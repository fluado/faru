/**
 * faru dispatch orchestrator.
 *
 * Manages skill-chain execution: state tracking, prompt composition,
 * card comment logging, and driver coordination.
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// State — module-scoped, one dispatch at a time
// ---------------------------------------------------------------------------

let state = {
	status: "idle", // "idle" | "running" | "error"
	card: null, // { slug, title, goal, body, files }
	chain: [], // [{ skill, context }, ...]
	currentIndex: 0,
	startedAt: null,
	log: [], // [{ skill, status, duration, message }, ...]
	liveEvent: null,
};

function getState() {
	return { ...state };
}

// ---------------------------------------------------------------------------
// Queue — FIFO, serial execution. Items wait here when dispatch/kata is busy.
// ---------------------------------------------------------------------------

let dispatchQueue = [];

/**
 * Add a dispatch to the queue. Rejects if the slug is already running or
 * already queued. Returns { queued, position?, reason? }.
 */
function enqueue(card, chain, driver, agentConfig, fns) {
	// Reject if this slug is already running
	if (state.status === "running" && state.card && state.card.slug === card.slug) {
		fns.log(`⚠️  ${card.slug} is already running — not queued`);
		return { queued: false, reason: "already-running" };
	}
	// Reject if this slug is already in the queue
	if (dispatchQueue.some((item) => item.card.slug === card.slug)) {
		fns.log(`⚠️  ${card.slug} is already in the queue — not queued again`);
		return { queued: false, reason: "already-queued" };
	}

	const item = { card, chain, driver, agentConfig, fns, queuedAt: new Date().toISOString() };
	dispatchQueue.push(item);
	fns.log(`📋 Queued: ${card.slug} (position ${dispatchQueue.length})`);
	fns.notifyReload();

	// If idle, start draining immediately
	if (state.status === "idle") {
		drainQueue().catch((e) => fns.log(`❌ Queue drain error: ${e.message}`));
	}
	return { queued: true, position: dispatchQueue.length };
}

/**
 * Process queued dispatches one at a time. Called after a dispatch completes
 * and when a new item is enqueued while idle. Pauses if a kata is running.
 */
async function drainQueue() {
	while (dispatchQueue.length > 0 && state.status === "idle") {
		const next = dispatchQueue[0];

		// Respect kata state — if a kata started between queue items, wait.
		// The kata module will call back when it finishes to resume draining.
		if (next.fns.getKataState && next.fns.getKataState().status === "running") {
			next.fns.log("⏸  Queue paused — kata is running");
			return;
		}

		dispatchQueue.shift();
		next.fns.notifyReload();
		await runDispatch(next.card, next.chain, next.driver, next.agentConfig, next.fns);
	}
}

/**
 * Return a serialisable snapshot of the current queue.
 */
function getQueue() {
	return dispatchQueue.map((item, i) => ({
		position: i + 1,
		slug: item.card.slug,
		title: item.card.title,
		chain: item.chain.map((s) => s.skill),
		queuedAt: item.queuedAt,
	}));
}

/**
 * Remove a queued item by slug. Returns true if found and removed.
 */
function dequeue(slug) {
	const idx = dispatchQueue.findIndex((item) => item.card.slug === slug);
	if (idx === -1) return false;
	dispatchQueue.splice(idx, 1);
	return true;
}

// ---------------------------------------------------------------------------
// Skill discovery (dynamic, reads from disk every call)
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
	if (!content.startsWith("---")) return { meta: {}, body: content };
	const end = content.indexOf("---", 3);
	if (end === -1) return { meta: {}, body: content };
	const yaml = content.substring(3, end).trim();
	const meta = {};
	for (const line of yaml.split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			meta[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
		}
	}
	return { meta, body: content.substring(end + 3).trim() };
}

function listSkills(skillsDir) {
	if (!skillsDir || !fs.existsSync(skillsDir)) return [];
	return fs
		.readdirSync(skillsDir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const id = f.replace(".md", "");
			const raw = fs.readFileSync(path.join(skillsDir, f), "utf-8");
			const { meta, body } = parseFrontmatter(raw);
			const name = deriveSkillName(id, body);
			return {
				id,
				name,
				model: meta.model || null,
				phase: meta.phase ? Number(meta.phase) : null,
				produces: meta.produces || null,
				includeTypes: meta.includeTypes
					? meta.includeTypes.split(",").map((s) => s.trim())
					: [],
				excludeTypes: meta.excludeTypes
					? meta.excludeTypes.split(",").map((s) => s.trim())
					: [],
				default: meta.default === "true",
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function getSkillModel(skillsDir, skillId) {
	const fp = path.join(skillsDir, skillId + ".md");
	if (!fs.existsSync(fp)) return null;
	const { meta } = parseFrontmatter(fs.readFileSync(fp, "utf-8"));
	return meta.model || null;
}

function deriveSkillName(id, body) {
	const firstLine = body.split("\n")[0] || "";
	const match = firstLine.match(/^Act like (?:a |an )?(.+?)[.,]/i);
	if (match) return match[1].trim();
	return id
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

// ---------------------------------------------------------------------------
// Default chain suggestion — fully driven by skill frontmatter.
//
// Skills self-describe their chain behaviour:
//   phase:        <number>  — ordering in the chain (lower = earlier)
//   produces:     <glob>    — skip this skill if a card file matches the glob
//   includeTypes: <csv>     — only suggest for these card categories
//   excludeTypes: <csv>     — skip for these card categories
//   default:      true      — include as fallback when chain would be empty
// ---------------------------------------------------------------------------

function suggestChain(card, availableSkills) {
	const files = card.files || [];

	// Filter to skills that declare a phase (chainable skills)
	const chainable = availableSkills.filter((s) => s.phase !== null);

	const chain = chainable
		.filter((skill) => {
			// Skip if card type is not in the include list (when specified)
			if (skill.includeTypes.length > 0 && !skill.includeTypes.includes(card.type)) {
				return false;
			}
			// Skip if card type is excluded
			if (skill.excludeTypes.length > 0 && skill.excludeTypes.includes(card.type)) {
				return false;
			}
			// Skip if the artifact this skill produces already exists
			if (skill.produces) {
				const glob = skill.produces;
				const hasArtifact = files.some((f) => matchGlob(f, glob));
				if (hasArtifact) return false;
			}
			return true;
		})
		.sort((a, b) => a.phase - b.phase)
		.map((s) => ({ skill: s.id, context: "" }));

	// If nothing was suggested, fall back to any skill marked as default
	if (chain.length === 0) {
		const fallback = availableSkills.find((s) => s.default);
		if (fallback) {
			chain.push({ skill: fallback.id, context: "" });
		}
	}

	return chain;
}

// Minimal glob matcher — supports * and ** wildcards
function matchGlob(filename, pattern) {
	const regex = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "<<GLOBSTAR>>")
		.replace(/\*/g, "[^/]*")
		.replace(/<<GLOBSTAR>>/g, ".*");
	return new RegExp(`^${regex}$`).test(filename);
}

function scanCardFiles(slug, backlogDir) {
	const folderPath = path.join(backlogDir, slug);
	if (!fs.existsSync(folderPath)) return [];
	return fs.readdirSync(folderPath).filter((f) => f.endsWith(".md"));
}

function getSkillNeeds(skillsDir, skillId) {
	const fp = path.join(skillsDir, skillId + ".md");
	if (!fs.existsSync(fp)) return null;
	const { meta } = parseFrontmatter(fs.readFileSync(fp, "utf-8"));
	return meta.needs || null;
}

function resolveNeeds(skillId, skillsDir, cardFiles) {
	const needs = getSkillNeeds(skillsDir, skillId);
	if (!needs) return cardFiles;
	const patterns = needs.split(",").map((p) => p.trim());
	const matched = cardFiles.filter((f) =>
		patterns.some((p) => matchGlob(f, p)),
	);
	return matched.length > 0 ? matched : cardFiles;
}

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

function composePrompt(step, card, previousLog, skillsDir, sentinelPath) {
	const repoName = path.basename(process.cwd());
	const parts = [];

	// Skill persona
	const skillFile = step.skill + ".md";
	const skillPath = path.join(skillsDir, skillFile);
	if (fs.existsSync(skillPath)) {
		const skillsDirName = path.basename(path.resolve(skillsDir));
		parts.push(`Act as @[${repoName}/${skillsDirName}/${skillFile}].`);
	}

	// Card files — scoped by skill's `needs` declaration
	const neededFiles = resolveNeeds(step.skill, skillsDir, card.files || []);
	if (neededFiles.length > 0) {
		const refs = neededFiles
			.map((f) => `@[${repoName}/backlog/${card.slug}/${f}]`)
			.join(" ");
		parts.push(`Read ${refs}.`);
	}

	// Previous phase output — explicit handoff of new files only
	const completedSteps = previousLog.filter((l) => l.status === "done");
	if (completedSteps.length > 0) {
		const lastStep = completedSteps[completedSteps.length - 1];
		const produced = lastStep.producedFiles || [];
		const handoff = produced.filter((f) => !neededFiles.includes(f));
		if (handoff.length > 0) {
			const refs = handoff
				.map((f) => `@[${repoName}/backlog/${card.slug}/${f}]`)
				.join(" ");
			parts.push(`The previous skill (${lastStep.skill}) produced: ${refs}.`);
		}
	}

	// User-provided per-skill context
	if (step.context?.trim()) {
		parts.push(step.context.trim());
	}

	// Sentinel
	parts.push(
		`When done, touch or re-create \`${sentinelPath}\` with content \`done\`.`,
	);

	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

function formatDuration(ms) {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function firstNonEmptyLine(text) {
	return String(text || "")
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean) || "";
}

// ---------------------------------------------------------------------------
// Core orchestration
// ---------------------------------------------------------------------------

async function runDispatch(card, chain, driver, agentConfig, fns) {
	// fns: { addComment, updateCard, skillsDir, log, notifyReload }
	const dispatchActor = agentConfig?.commentAuthor
		|| (agentConfig?.driver === "cursor" ? "cursor-agent" : "faru-agent");

	state = {
		status: "running",
		card,
		chain,
		currentIndex: 0,
		startedAt: new Date().toISOString(),
		log: [],
		liveEvent: null,
	};

	// Move card to WIP
	try {
		fns.updateCard(card.slug, { status: "wip" });
	} catch (_) {}

	const chainNames = chain.map((s) => s.skill.replace(/-/g, " ")).join(" → ");
	fns.addComment(card.slug, `🚀 Dispatch started — ${chainNames}`, dispatchActor);
	fns.notifyReload();

	const totalStart = Date.now();

	for (let i = 0; i < chain.length; i++) {
		state.currentIndex = i;
		const step = chain[i];
		const skillStart = Date.now();
		const filesBefore = scanCardFiles(card.slug, fns.backlogDir);

		fns.log(`⚡ [${i + 1}/${chain.length}] Running: ${step.skill}`);

		// Fresh session per skill
		try {
			await driver.newSession(agentConfig);
		} catch (e) {
			const duration = formatDuration(Date.now() - skillStart);
			state.log.push({
				skill: step.skill,
				status: "failed",
				duration: Date.now() - skillStart,
				durationFormatted: duration,
				message: `Failed to start new session: ${e.message}`,
			});
			state.status = "error";
			if (driver.releaseWorkspace) driver.releaseWorkspace();
			fns.addComment(
				card.slug,
				`❌ ${step.skill} failed — could not start new session: ${e.message}`,
				dispatchActor,
			);
			fns.notifyReload();
			return;
		}

		// Compose and send
		const sentinelPath = `backlog/${card.slug}/.dispatch-complete`;
		const sentinelAbsPath = path.join(fns.backlogDir, card.slug, ".dispatch-complete");
		// Clean up any stale sentinel
		try { fs.unlinkSync(sentinelAbsPath); } catch (_) {}

		const prompt = composePrompt(step, card, state.log, fns.skillsDir, sentinelPath);
		const executeConfig = {
			...agentConfig,
			__skillId: step.skill,
			__cardSlug: card.slug,
			__backlogDir: fns.backlogDir,
			skills: fns.skillsDir,
			__onEvent: (eventText) => {
				if (!eventText) return;
				state.liveEvent = `[${step.skill}] ${eventText}`;
				fns.notifyReload();
			},
		};

		// Select model for this skill (if driver supports it)
		if (driver.setModel) {
			const model = getSkillModel(fns.skillsDir, step.skill);
			if (model) {
				fns.log(`🧠 Selecting model: ${model} for ${step.skill}`);
				await driver.setModel(agentConfig, model);
			}
		}

		const result = await driver.execute(prompt, executeConfig, sentinelAbsPath);

		if (result.success && agentConfig.verify) {
			// ---------------------------------------------------------------
			// Verification pass — same session, second prompt.
			// The agent can't opt out: this is a structural harness mechanism
			// injected by the orchestrator, not part of any skill prompt.
			// The prompt content is user-configured — dispatch is agnostic
			// about what the verification checks for.
			//
			// Reuses the same .dispatch-complete sentinel as the main step.
			// The agent just created this file (proving it knows how), and
			// the driver deleted it after the main step succeeded, so the
			// path is clean for re-polling.
			// ---------------------------------------------------------------
			const basePrompt = typeof agentConfig.verify === "string"
				? agentConfig.verify
				: "Review what was requested and what you produced. List each requirement, confirm it is done or flag it as incomplete. Fix anything incomplete now.";

			const verifyPrompt = `${basePrompt} When finished, touch or re-create \`${sentinelPath}\` with content \`done\`.`;

			fns.log(`🔍 [${i + 1}/${chain.length}] Verification pass for ${step.skill}`);

			const verifyResult = await driver.execute(
				verifyPrompt,
				executeConfig,
				sentinelAbsPath,
			);

			if (!verifyResult.success) {
				fns.log(`⚠️  [${i + 1}/${chain.length}] Verification timed out for ${step.skill} — proceeding`);
				fns.addComment(
					card.slug,
					`⚠️ ${step.skill} verification pass timed out — results may be incomplete`,
					dispatchActor,
				);
			} else {
				fns.log(`🔍 [${i + 1}/${chain.length}] Verification pass completed for ${step.skill}`);
			}
		}

		const duration = formatDuration(Date.now() - skillStart);

		const filesAfter = scanCardFiles(card.slug, fns.backlogDir);
		const producedFiles = filesAfter.filter((f) => !filesBefore.includes(f));

		state.log.push({
			skill: step.skill,
			status: result.success ? "done" : "failed",
			duration: Date.now() - skillStart,
			durationFormatted: duration,
			message: result.success ? "" : result.output,
			producedFiles,
			cost: result.cost ?? null,
			durationMs: result.durationMs ?? null,
			turns: result.turns ?? null,
		});

		if (result.success) {
			fns.log(`✅ [${i + 1}/${chain.length}] ${step.skill} completed (${duration})`);
			const details = [];
			if (typeof result.cost === "number") {
				details.push(`cost $${result.cost.toFixed(4)}`);
			}
			if (typeof result.durationMs === "number") {
				details.push(`duration ${Math.round(result.durationMs)}ms`);
			}
			if (typeof result.turns === "number") {
				details.push(`${result.turns} turns`);
			}
			const suffix = details.length > 0 ? ` — ${details.join(", ")}` : "";
			fns.addComment(
				card.slug,
				`✅ ${step.skill} completed (${duration})${suffix}`,
				dispatchActor,
			);
		} else {
			fns.log(`❌ [${i + 1}/${chain.length}] ${step.skill} failed (${duration})`);
			const meta = [];
			if (result.errorType) meta.push(`type: ${result.errorType}`);
			if (result.logFile) meta.push(`log: ${result.logFile}`);
			const reason = firstNonEmptyLine(result.output).slice(0, 240);
			const metaSuffix = meta.length > 0 ? ` (${meta.join(", ")})` : "";
			fns.addComment(
				card.slug,
				`❌ ${step.skill} failed after ${duration}${metaSuffix}${reason ? `: ${reason}` : ""}`,
				dispatchActor,
			);
			state.status = "error";
			if (driver.releaseWorkspace) driver.releaseWorkspace();
			fns.notifyReload();
			return;
		}

		fns.notifyReload();
	}

	// Chain complete — card stays in wip for human review.
	const totalDuration = formatDuration(Date.now() - totalStart);
	fns.addComment(
		card.slug,
		`🎉 All skills completed (${totalDuration}) — ${chainNames}`,
		dispatchActor,
	);
	fns.log(`🎉 Dispatch complete: ${card.slug} (${totalDuration})`);

	// Release workspace pin so next dispatch can pick a fresh target
	if (driver.releaseWorkspace) driver.releaseWorkspace();

	state = {
		status: "idle",
		card: null,
		chain: [],
		currentIndex: 0,
		startedAt: null,
		log: [],
		liveEvent: null,
	};

	fns.notifyReload();

	// Pick up next queued item (if any)
	drainQueue().catch((e) => fns.log(`❌ Queue drain error: ${e.message}`));
}

function abortDispatch() {
	if (state.status !== "running") return false;
	state.status = "idle";
	const slug = state.card?.slug;
	state = {
		status: "idle",
		card: null,
		chain: [],
		currentIndex: 0,
		startedAt: null,
		log: [],
		liveEvent: null,
	};
	return slug;
}

module.exports = {
	getState,
	listSkills,
	suggestChain,
	runDispatch,
	abortDispatch,
	enqueue,
	getQueue,
	dequeue,
	drainQueue,
};
