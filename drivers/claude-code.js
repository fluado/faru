/**
 * Claude Code CLI driver for faru dispatch.
 *
 * Uses `claude -p` in headless mode and parses stream-json events from stdout.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

let availabilityCache = null;
let activeSession = null;
let selectedModel = null;

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

function listFilesRecursive(dir, baseDir = dir) {
	if (!fs.existsSync(dir)) return [];
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listFilesRecursive(full, baseDir));
			continue;
		}
		if (!entry.isFile()) continue;
		out.push(path.relative(baseDir, full).replace(/\\/g, "/"));
	}
	return out;
}

function matchGlob(filename, pattern) {
	const regex = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "<<GLOBSTAR>>")
		.replace(/\*/g, "[^/]*")
		.replace(/<<GLOBSTAR>>/g, ".*");
	return new RegExp(`^${regex}$`).test(filename);
}

function parseFrontmatter(raw) {
	if (!raw.startsWith("---")) return {};
	const end = raw.indexOf("---", 3);
	if (end === -1) return {};
	const yaml = raw.substring(3, end).trim();
	const meta = {};
	for (const line of yaml.split("\n")) {
		const idx = line.indexOf(":");
		if (idx <= 0) continue;
		const key = line.substring(0, idx).trim();
		const value = line.substring(idx + 1).trim();
		meta[key] = value;
	}
	return meta;
}

function getSkillProduces(config) {
	const skillsDir = resolvePathMaybe(process.cwd(), config?.skills || "");
	const skillId = config?.__skillId;
	if (!skillsDir || !skillId) return null;
	const fp = path.join(skillsDir, `${skillId}.md`);
	if (!fs.existsSync(fp)) return null;
	const raw = fs.readFileSync(fp, "utf-8");
	const meta = parseFrontmatter(raw);
	return meta.produces || null;
}

function classifyError(text) {
	const lower = String(text || "").toLowerCase();
	if (
		lower.includes("anthropic_api_key") ||
		lower.includes("api key") ||
		lower.includes("auth") ||
		lower.includes("login")
	) {
		return "auth";
	}
	if (
		lower.includes("rate limit") ||
		lower.includes("quota") ||
		lower.includes("too many requests") ||
		lower.includes("429")
	) {
		return "rate_limit";
	}
	return "generic";
}

function normalizeEventType(evt) {
	const raw = evt?.type || evt?.event || evt?.kind || "";
	return String(raw).toLowerCase();
}

function extractSessionId(evt) {
	return (
		evt?.session_id ||
		evt?.sessionId ||
		evt?.session?.id ||
		evt?.data?.session_id ||
		evt?.payload?.session_id ||
		null
	);
}

function extractTextDelta(evt) {
	if (typeof evt?.text === "string") return evt.text;
	if (typeof evt?.delta === "string") return evt.delta;
	if (typeof evt?.content === "string") return evt.content;
	if (typeof evt?.result === "string") return evt.result;
	if (Array.isArray(evt?.content)) {
		return evt.content
			.map((c) => (typeof c?.text === "string" ? c.text : ""))
			.join("");
	}
	if (evt?.message?.content && Array.isArray(evt.message.content)) {
		return evt.message.content
			.map((c) => (typeof c?.text === "string" ? c.text : ""))
			.join("");
	}
	return "";
}

function extractMetrics(finalEvent) {
	const cost =
		finalEvent?.total_cost_usd ??
		finalEvent?.cost_usd ??
		finalEvent?.cost ??
		finalEvent?.usage?.total_cost_usd ??
		null;
	const durationMs =
		finalEvent?.duration_ms ??
		finalEvent?.durationMs ??
		finalEvent?.metrics?.duration_ms ??
		null;
	const turns =
		finalEvent?.num_turns ??
		finalEvent?.turns ??
		finalEvent?.metrics?.turns ??
		null;
	return { cost, durationMs, turns };
}

function extractFinalOutput(finalEvent, fallbackText) {
	const result =
		finalEvent?.result ||
		finalEvent?.output ||
		finalEvent?.message ||
		finalEvent?.text ||
		"";
	if (typeof result === "string" && result.trim()) return result;
	return String(fallbackText || "").trim();
}

function appendDispatchLedger(workdir, payload) {
	const dir = path.join(workdir, ".faru");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const fp = path.join(dir, "dispatches.jsonl");
	fs.appendFileSync(fp, JSON.stringify(payload) + "\n", "utf-8");
}

async function runVersionCheck() {
	return new Promise((resolve) => {
		const p = spawn("claude", ["--version"], { stdio: "ignore" });
		const timer = setTimeout(() => {
			try {
				p.kill("SIGTERM");
			} catch (_) {}
			resolve(false);
		}, 2000);

		p.on("error", (err) => {
			clearTimeout(timer);
			if (err && err.code === "ENOENT") {
				resolve(false);
				return;
			}
			resolve(false);
		});
		p.on("exit", (code) => {
			clearTimeout(timer);
			resolve(code === 0);
		});
	});
}

module.exports = {
	async isAvailable() {
		if (availabilityCache !== null) return availabilityCache;
		availabilityCache = await runVersionCheck();
		return availabilityCache;
	},

	async newSession(config, ctx = {}) {
		const workdir = resolvePathMaybe(process.cwd(), ctx.workdir || config?.workdir || ".");
		activeSession = {
			id: randomUUID(),
			workdir,
			claudeSessionId: null,
			child: null,
			aborted: false,
		};
		return activeSession;
	},

	async execute(prompt, config, sentinelPath) {
		if (!activeSession) {
			await this.newSession(config, {});
		}
		const session = activeSession;
		if (session.aborted) {
			return { success: false, output: "Session was aborted", errorType: "aborted" };
		}

		const timeoutMs = (config?.timeoutMinutes || 15) * 60_000;
		const args = [
			"-p",
			"--output-format",
			"stream-json",
			"--input-format",
			"stream-json",
			"--verbose",
			"--bare",
		];
		const allowedTools = config?.allowedTools || "Read,Write,Edit,Bash,Glob,Grep";
		if (allowedTools) args.push("--allowedTools", allowedTools);
		if (config?.dangerouslySkipPermissions) {
			args.push("--dangerously-skip-permissions");
		}
		const mcpConfig = resolvePathMaybe(session.workdir, config?.mcpConfig);
		if (mcpConfig) args.push("--mcp-config", mcpConfig);
		if (config?.appendSystemPrompt) {
			args.push("--append-system-prompt", config.appendSystemPrompt);
		}
		if (selectedModel) args.push("--model", selectedModel);
		if (config?.maxTurns) args.push("--max-turns", String(config.maxTurns));
		if (session.claudeSessionId) args.push("--resume", session.claudeSessionId);

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

		const child = spawn("claude", args, {
			cwd: session.workdir,
			stdio: ["pipe", "pipe", "pipe"],
		});
		session.child = child;
		const onEvent = typeof config?.__onEvent === "function" ? config.__onEvent : null;
		const emitEvent = (text) => {
			if (!onEvent) return;
			try {
				onEvent(text);
			} catch (_) {}
		};

		let killedByTimeout = false;
		let stderr = "";
		let assistantText = "";
		let finalEvent = null;
		const toolEvents = [];

		const rl = readline.createInterface({ input: child.stdout });
		rl.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let evt;
			try {
				evt = JSON.parse(trimmed);
			} catch (_) {
				return;
			}
			const type = normalizeEventType(evt);
			if (!session.claudeSessionId) {
				const sid = extractSessionId(evt);
				if (sid) session.claudeSessionId = sid;
			}
			if (type.includes("tool_use") || type.includes("tool_result")) {
				const toolName = evt?.name || evt?.tool || evt?.tool_name || "unknown";
				toolEvents.push({
					type,
					tool: toolName,
				});
				emitEvent(`${type}: ${toolName}`);
			}
			if (type === "assistant" || type.includes("assistant")) {
				const delta = extractTextDelta(evt);
				assistantText += delta;
				if (delta.trim()) {
					emitEvent(`assistant: ${delta.trim().slice(0, 120)}`);
				}
			}
			if (type === "result" || type.includes("/result")) {
				finalEvent = evt;
				emitEvent("result event received");
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
		const closePromise = new Promise((resolve) => {
			child.on("error", (err) => {
				execError = err;
			});
			child.on("close", (code) => {
				exitCode = code;
				resolve();
			});
		});

		const streamPrompt = {
			type: "user",
			message: {
				role: "user",
				content: [{ type: "text", text: String(prompt || "") }],
			},
		};
		child.stdin.write(JSON.stringify(streamPrompt) + "\n");
		child.stdin.end();

		await closePromise;
		clearTimeout(timeout);
		rl.close();
		session.child = null;

		const elapsedMs = Date.now() - startedAt;
		const metrics = extractMetrics(finalEvent || {});
		const resultText = extractFinalOutput(finalEvent || {}, assistantText || stderr);
		const isError = Boolean(finalEvent?.is_error);
		const success =
			!session.aborted &&
			!killedByTimeout &&
			!execError &&
			exitCode === 0 &&
			!isError;

		const produces = getSkillProduces(config);
		if (success && produces && cardFolder && fs.existsSync(cardFolder)) {
			const files = listFilesRecursive(cardFolder);
			const matched = files.some((f) => matchGlob(f, produces));
			if (!matched) {
				return {
					success: false,
					output: `Dispatch completed but required artifact "${produces}" was not created in card folder`,
					errorType: "produces_mismatch",
					cost: metrics.cost,
					durationMs: metrics.durationMs || elapsedMs,
					turns: metrics.turns,
				};
			}
		}

		if (sentinelPath) {
			try {
				fs.unlinkSync(sentinelPath);
			} catch (_) {}
		}

		const errorText = execError?.message || stderr || resultText;
		const errorType = session.aborted
			? "aborted"
			: killedByTimeout
				? "timeout"
				: success
					? null
					: classifyError(errorText);

		appendDispatchLedger(session.workdir, {
			timestamp: new Date().toISOString(),
			sessionId: session.id,
			claudeSessionId: session.claudeSessionId,
			skill: config?.__skillId || null,
			cardSlug: config?.__cardSlug || null,
			success,
			errorType,
			costUsd: metrics.cost,
			durationMs: metrics.durationMs || elapsedMs,
			turns: metrics.turns,
			toolEvents,
		});

		if (success) {
			return {
				success: true,
				output: resultText || "[No output]",
				cost: metrics.cost,
				durationMs: metrics.durationMs || elapsedMs,
				turns: metrics.turns,
			};
		}

		return {
			success: false,
			output:
				killedByTimeout
					? `Timeout — agent did not finish within ${config?.timeoutMinutes || 15} minutes`
					: (errorText || "Claude Code execution failed"),
			errorType,
			cost: metrics.cost,
			durationMs: metrics.durationMs || elapsedMs,
			turns: metrics.turns,
		};
	},

	async setModel(_config, modelId) {
		selectedModel = modelId || null;
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
