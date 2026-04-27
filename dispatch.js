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
};

function getState() {
	return { ...state };
}

// ---------------------------------------------------------------------------
// Skill discovery (dynamic, reads from disk every call)
// ---------------------------------------------------------------------------

function listSkills(skillsDir) {
	if (!skillsDir || !fs.existsSync(skillsDir)) return [];
	return fs
		.readdirSync(skillsDir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const id = f.replace(".md", "");
			const content = fs.readFileSync(path.join(skillsDir, f), "utf-8");
			const name = deriveSkillName(id, content);
			return { id, name };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function deriveSkillName(id, content) {
	// Try to extract from "Act like a ..." on the first line
	const firstLine = content.split("\n")[0] || "";
	const match = firstLine.match(/^Act like (?:a |an )?(.+?)[\.\,]/i);
	if (match) return match[1].trim();

	// Fallback: humanize the filename
	return id
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

// ---------------------------------------------------------------------------
// Default chain suggestion
// ---------------------------------------------------------------------------

function suggestChain(card, availableSkills) {
	const chain = [];
	const skillIds = new Set(availableSkills.map((s) => s.id));
	const files = card.files || [];

	const hasMilestones = files.some((f) => f.endsWith("-milestones.md"));
	const hasDesign = files.some(
		(f) => f.includes("-adr") || f.includes("-design"),
	);
	const hasTickets = files.some((f) => f.endsWith("-tickets.md"));

	if (!hasMilestones && skillIds.has("cpo-chief-product-architect")) {
		chain.push({ skill: "cpo-chief-product-architect", context: "" });
	}
	if (!hasDesign && skillIds.has("chief-architect")) {
		chain.push({ skill: "chief-architect", context: "" });
	}
	if (!hasTickets && skillIds.has("sprint-planner")) {
		chain.push({ skill: "sprint-planner", context: "" });
	}

	// CSE last, unless card type is purely non-technical
	const nonTechTypes = ["legal", "prospect", "ops"];
	if (
		!nonTechTypes.includes(card.type) &&
		skillIds.has("cse-chief-software-engineer")
	) {
		chain.push({ skill: "cse-chief-software-engineer", context: "" });
	}

	// If nothing was suggested (everything already exists), default to CSE
	if (chain.length === 0 && skillIds.has("cse-chief-software-engineer")) {
		chain.push({ skill: "cse-chief-software-engineer", context: "" });
	}

	return chain;
}

// ---------------------------------------------------------------------------
// Prompt composition
// ---------------------------------------------------------------------------

function composePrompt(step, card, previousLog, skillsDir, sentinelPath) {
	const parts = [];

	// 1. Skill persona (the full .md file content)
	const skillPath = path.join(skillsDir, step.skill + ".md");
	if (fs.existsSync(skillPath)) {
		parts.push(fs.readFileSync(skillPath, "utf-8"));
	}

	parts.push("---");
	parts.push("");
	parts.push("## Your task");
	parts.push("");
	parts.push(`**Card**: ${card.title}`);
	parts.push(`**Card folder**: backlog/${card.slug}/`);

	if (card.goal) {
		parts.push(`**Description**: ${card.goal}`);
	}

	if (card.files && card.files.length > 0) {
		parts.push("");
		parts.push("### Existing files in this card folder");
		for (const f of card.files) {
			parts.push(`- ${f}`);
		}
	}

	if (card.body) {
		parts.push("");
		parts.push("### Card body");
		parts.push(card.body);
	}

	// Previous phase outputs
	const completedSteps = previousLog.filter((l) => l.status === "done");
	if (completedSteps.length > 0) {
		parts.push("");
		parts.push("### Previous phase outputs");
		parts.push(
			"The following skills have already completed and their outputs are in the card folder. Read them before starting.",
		);
		for (const l of completedSteps) {
			parts.push(`- **${l.skill}** completed (${l.durationFormatted})`);
		}
	}

	// User-provided per-skill context
	if (step.context && step.context.trim()) {
		parts.push("");
		parts.push("### Additional context from the user");
		parts.push(step.context.trim());
	}

	// Sentinel: instruct agent to signal completion
	parts.push("");
	parts.push("### Completion signal");
	parts.push(
		`When you have fully completed your work, create a file at \`${sentinelPath}\` with content \`done\`. This signals the dispatch system that you are finished. Do this as your very last action.`,
	);

	return parts.join("\n");
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

// ---------------------------------------------------------------------------
// Core orchestration
// ---------------------------------------------------------------------------

async function runDispatch(card, chain, driver, agentConfig, fns) {
	// fns: { addComment, updateCard, skillsDir, log, notifyReload }

	state = {
		status: "running",
		card,
		chain,
		currentIndex: 0,
		startedAt: new Date().toISOString(),
		log: [],
	};

	// Move card to WIP
	try {
		fns.updateCard(card.slug, { status: "wip" });
	} catch (_) {}

	const chainNames = chain.map((s) => s.skill.replace(/-/g, " ")).join(" → ");
	fns.addComment(card.slug, `🚀 Dispatch started — ${chainNames}`, "faru-agent");
	fns.notifyReload();

	const totalStart = Date.now();

	for (let i = 0; i < chain.length; i++) {
		state.currentIndex = i;
		const step = chain[i];
		const skillStart = Date.now();

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
			fns.addComment(
				card.slug,
				`❌ ${step.skill} failed — could not start new session: ${e.message}`,
				"faru-agent",
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
		const result = await driver.execute(prompt, agentConfig, sentinelAbsPath);
		const duration = formatDuration(Date.now() - skillStart);

		state.log.push({
			skill: step.skill,
			status: result.success ? "done" : "failed",
			duration: Date.now() - skillStart,
			durationFormatted: duration,
			message: result.success ? "" : result.output,
		});

		if (result.success) {
			fns.log(`✅ [${i + 1}/${chain.length}] ${step.skill} completed (${duration})`);
			fns.addComment(card.slug, `✅ ${step.skill} completed (${duration})`, "faru-agent");
		} else {
			fns.log(`❌ [${i + 1}/${chain.length}] ${step.skill} failed (${duration})`);
			fns.addComment(
				card.slug,
				`❌ ${step.skill} failed after ${duration}: ${result.output.substring(0, 200)}`,
				"faru-agent",
			);
			state.status = "error";
			fns.notifyReload();
			return;
		}

		fns.notifyReload();
	}

	// Chain complete
	const totalDuration = formatDuration(Date.now() - totalStart);
	fns.addComment(
		card.slug,
		`🎉 All skills completed (${totalDuration}) — ${chainNames}`,
		"faru-agent",
	);
	fns.log(`🎉 Dispatch complete: ${card.slug} (${totalDuration})`);

	try {
		fns.updateCard(card.slug, { status: "done" });
	} catch (_) {}

	// Release workspace pin so next dispatch can pick a fresh target
	if (driver.releaseWorkspace) driver.releaseWorkspace();

	state = {
		status: "idle",
		card: null,
		chain: [],
		currentIndex: 0,
		startedAt: null,
		log: [],
	};

	fns.notifyReload();
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
	};
	return slug;
}

module.exports = {
	getState,
	listSkills,
	suggestChain,
	runDispatch,
	abortDispatch,
};
