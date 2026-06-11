/**
 * Antigravity CLI (`agy`) driver for faru dispatch.
 *
 * Uses `agy -p` (print mode) to run prompts non-interactively.
 * Output is plain text on stdout; process exit signals completion.
 *
 * Config (.faru.local.json):
 *   {
 *     "agent": {
 *       "driver": "agy",
 *       "workdir": ".",
 *       "dangerouslySkipPermissions": true
 *     }
 *   }
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let availabilityCache = null;
let activeSession = null;
let selectedModel = null;

// ---------------------------------------------------------------------------
// Model mapping — skill frontmatter IDs → agy model display names.
// Run `agy models` to see the full list.
// ---------------------------------------------------------------------------

const MODEL_MAP = {
	"opus-4.6": "Claude Opus 4.6 (Thinking)",
	"sonnet-4.6": "Claude Sonnet 4.6 (Thinking)",
	"gemini-flash-3.5-medium": "Gemini 3.5 Flash (Medium)",
	"gemini-flash-3.5-high": "Gemini 3.5 Flash (High)",
	"gemini-flash-3.5-low": "Gemini 3.5 Flash (Low)",
	"gemini-pro-3.1-low": "Gemini 3.1 Pro (Low)",
	"gemini-pro-3.1-high": "Gemini 3.1 Pro (High)",
	"gpt-oss-120b": "GPT-OSS 120B (Medium)",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePathMaybe(baseDir, value) {
	if (!value) return null;
	if (path.isAbsolute(value)) return value;
	return path.resolve(baseDir, value);
}

function isSubPath(parentPath, targetPath) {
	const rel = path.relative(parentPath, targetPath);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function appendDispatchLedger(workdir, payload) {
	const dir = path.join(workdir, ".faru");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const fp = path.join(dir, "dispatches.jsonl");
	fs.appendFileSync(fp, JSON.stringify(payload) + "\n", "utf-8");
}

function writeDispatchLog(workdir, payload) {
	const logsDir = path.join(workdir, ".faru", "logs");
	if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const filename = `${stamp}-${payload.sessionId || "session"}.json`;
	const absPath = path.join(logsDir, filename);
	fs.writeFileSync(absPath, JSON.stringify(payload, null, 2), "utf-8");
	return path.relative(workdir, absPath).replace(/\\/g, "/");
}

// ---------------------------------------------------------------------------
// Core: build args, run process
// ---------------------------------------------------------------------------

function buildAgyArgs(prompt, session, config) {
	const args = ["-p", String(prompt || "")];

	// Timeout
	const timeoutMinutes = config?.timeoutMinutes || 15;
	args.push("--print-timeout", `${timeoutMinutes}m`);

	// Model
	if (selectedModel) {
		args.push("--model", selectedModel);
	}

	// Permissions
	if (config?.dangerouslySkipPermissions) {
		args.push("--dangerously-skip-permissions");
	}

	// Add card folder as workspace directory if outside workdir
	const cardFolder = config?.__cardSlug
		? path.join(config.__backlogDir || "", config.__cardSlug)
		: null;
	if (
		cardFolder &&
		fs.existsSync(cardFolder) &&
		!isSubPath(session.workdir, cardFolder)
	) {
		args.push("--add-dir", cardFolder);
	}

	// Continue previous conversation for verification passes
	if (session.shouldContinue) {
		args.push("--continue");
	}

	return args;
}

async function runAgyInvocation(session, prompt, config, timeoutMs, emitEvent) {
	const args = buildAgyArgs(prompt, session, config);
	const child = spawn("agy", args, {
		cwd: session.workdir,
		stdio: ["pipe", "pipe", "pipe"],
	});
	session.child = child;

	let killedByTimeout = false;
	let stdout = "";
	let stderr = "";

	child.stdout.on("data", (chunk) => {
		const text = String(chunk);
		stdout += text;
		// Emit last meaningful line as live event
		const lines = text.trim().split("\n").filter(Boolean);
		if (lines.length > 0 && emitEvent) {
			emitEvent(lines[lines.length - 1].slice(0, 120));
		}
	});

	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});

	const timeout = setTimeout(() => {
		killedByTimeout = true;
		try {
			child.kill("SIGTERM");
		} catch (_) {}
	}, timeoutMs);

	const startedAt = Date.now();
	let exitCode = null;
	let execError = null;

	await new Promise((resolve) => {
		child.on("error", (err) => {
			execError = err;
		});
		child.on("close", (code) => {
			exitCode = code;
			resolve();
		});
		child.stdin.end();
	});

	clearTimeout(timeout);
	session.child = null;

	return {
		args,
		exitCode,
		execError,
		stdout: stdout.trim(),
		stderr: stderr.trim(),
		elapsedMs: Date.now() - startedAt,
		killedByTimeout,
	};
}

// ---------------------------------------------------------------------------
// Version check
// ---------------------------------------------------------------------------

async function runVersionCheck() {
	return new Promise((resolve) => {
		const p = spawn("agy", ["--help"], { stdio: "ignore" });
		const timer = setTimeout(() => {
			try {
				p.kill("SIGTERM");
			} catch (_) {}
			resolve(false);
		}, 3000);

		p.on("error", (err) => {
			clearTimeout(timer);
			resolve(false);
		});
		p.on("exit", (code) => {
			clearTimeout(timer);
			resolve(code === 0);
		});
	});
}

// ---------------------------------------------------------------------------
// Model normalisation
// ---------------------------------------------------------------------------

function normalizeModel(modelId) {
	if (!modelId) return null;
	const raw = String(modelId).trim();
	if (!raw) return null;

	// Direct match in our map
	if (MODEL_MAP[raw]) return MODEL_MAP[raw];

	// If the user passed an agy display name directly, use it as-is
	const knownNames = Object.values(MODEL_MAP);
	if (knownNames.some((n) => n.toLowerCase() === raw.toLowerCase())) {
		return raw;
	}

	// Unknown — pass through and let agy handle it
	console.log(
		`  [agy] Unknown model ID "${raw}" — passing through. Known: ${Object.keys(MODEL_MAP).join(", ")}`,
	);
	return raw;
}

// ---------------------------------------------------------------------------
// Driver interface
// ---------------------------------------------------------------------------

module.exports = {
	async isAvailable() {
		if (availabilityCache !== null) return availabilityCache;
		availabilityCache = await runVersionCheck();
		return availabilityCache;
	},

	async newSession(config) {
		const workdir = resolvePathMaybe(
			process.cwd(),
			config?.workdir || ".",
		);
		activeSession = {
			id: randomUUID(),
			workdir,
			child: null,
			aborted: false,
			shouldContinue: false,
		};
		return activeSession;
	},

	async execute(prompt, config, sentinelPath) {
		if (!activeSession) {
			await this.newSession(config);
		}
		const session = activeSession;
		if (session.aborted) {
			return {
				success: false,
				output: "Session was aborted",
				errorType: "aborted",
			};
		}

		const timeoutMs = (config?.timeoutMinutes || 15) * 60_000;
		const onEvent =
			typeof config?.__onEvent === "function" ? config.__onEvent : null;
		const emitEvent = (text) => {
			if (!onEvent) return;
			try {
				onEvent(text);
			} catch (_) {}
		};

		const run = await runAgyInvocation(
			session,
			prompt,
			config,
			timeoutMs,
			emitEvent,
		);

		// After first execute, subsequent calls in the same session use --continue
		session.shouldContinue = true;

		const output = run.stdout || run.stderr || "[No output]";

		// Clean up sentinel if it exists (skills may still create it)
		if (sentinelPath) {
			try {
				fs.unlinkSync(sentinelPath);
			} catch (_) {}
		}

		const success =
			!session.aborted &&
			!run.killedByTimeout &&
			!run.execError &&
			run.exitCode === 0;

		let errorType = null;
		if (!success) {
			errorType = session.aborted
				? "aborted"
				: run.killedByTimeout
					? "timeout"
					: "generic";
		}

		const logFile = writeDispatchLog(session.workdir, {
			timestamp: new Date().toISOString(),
			sessionId: session.id,
			skill: config?.__skillId || null,
			cardSlug: config?.__cardSlug || null,
			success,
			errorType,
			elapsedMs: run.elapsedMs,
			run: {
				args: run.args,
				exitCode: run.exitCode,
				killedByTimeout: run.killedByTimeout,
				execError: run.execError?.message || null,
				stderr: run.stderr || null,
			},
			outputPreview: String(output).slice(0, 1000),
		});

		appendDispatchLedger(session.workdir, {
			timestamp: new Date().toISOString(),
			sessionId: session.id,
			skill: config?.__skillId || null,
			cardSlug: config?.__cardSlug || null,
			success,
			errorType,
			elapsedMs: run.elapsedMs,
			logFile,
		});

		if (!success) {
			const reason = run.killedByTimeout
				? `Timeout — agent did not finish within ${config?.timeoutMinutes || 15} minutes`
				: run.execError?.message || output;
			return {
				success: false,
				output: reason,
				errorType,
				durationMs: run.elapsedMs,
				logFile,
			};
		}

		return {
			success: true,
			output,
			durationMs: run.elapsedMs,
			logFile,
		};
	},

	async setModel(_config, modelId) {
		selectedModel = normalizeModel(modelId);
	},

	async abort() {
		if (!activeSession) return false;
		activeSession.aborted = true;
		if (!activeSession.child) return true;
		try {
			activeSession.child.kill("SIGTERM");
		} catch (_) {
			return false;
		}
		await sleep(5000);
		if (activeSession.child) {
			try {
				activeSession.child.kill("SIGKILL");
			} catch (_) {}
		}
		return true;
	},

	releaseWorkspace() {
		activeSession = null;
		selectedModel = null;
	},
};
