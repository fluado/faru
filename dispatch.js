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
//   excludeTypes: <csv>     — skip for these card categories
//   default:      true      — include as fallback when chain would be empty
// ---------------------------------------------------------------------------

function suggestChain(card, availableSkills) {
	const files = card.files || [];

	// Filter to skills that declare a phase (chainable skills)
	const chainable = availableSkills.filter((s) => s.phase !== null);

	const chain = chainable
		.filter((skill) => {
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
	if (step.context && step.context.trim()) {
		parts.push(step.context.trim());
	}

	// Sentinel
	parts.push(
		`When done, create \`${sentinelPath}\` with content \`done\`.`,
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

		// Select model for this skill (if driver supports it)
		if (driver.setModel) {
			const model = getSkillModel(fns.skillsDir, step.skill);
			if (model) {
				fns.log(`🧠 Selecting model: ${model} for ${step.skill}`);
				await driver.setModel(agentConfig, model);
			}
		}

		const result = await driver.execute(prompt, agentConfig, sentinelAbsPath);

		if (result.success && agentConfig.verify) {
			// ---------------------------------------------------------------
			// Verification pass — same session, second prompt.
			// The agent can't opt out: this is a structural harness mechanism
			// injected by the orchestrator, not part of any skill prompt.
			// The prompt content is user-configured — dispatch is agnostic
			// about what the verification checks for.
			// Sentinel is primary completion signal; idle detection in the
			// driver is the fallback if the agent finishes without creating it.
			// ---------------------------------------------------------------
			const verifySentinelPath = `backlog/${card.slug}/.dispatch-verify`;
			const verifySentinelAbsPath = path.join(fns.backlogDir, card.slug, ".dispatch-verify");
			try { fs.unlinkSync(verifySentinelAbsPath); } catch (_) {}

			const basePrompt = typeof agentConfig.verify === "string"
				? agentConfig.verify
				: "Review what was requested and what you produced. List each requirement, confirm it is done or flag it as incomplete. Fix anything incomplete now.";

			const verifyPrompt = `${basePrompt} When finished, create \`${verifySentinelPath}\` with content \`done\`.`;

			fns.log(`🔍 [${i + 1}/${chain.length}] Verification pass for ${step.skill}`);

			const verifyResult = await driver.execute(
				verifyPrompt,
				agentConfig,
				verifySentinelAbsPath,
			);

			if (!verifyResult.success) {
				fns.log(`⚠️  [${i + 1}/${chain.length}] Verification timed out for ${step.skill} — proceeding`);
				fns.addComment(
					card.slug,
					`⚠️ ${step.skill} verification pass timed out — results may be incomplete`,
					"faru-agent",
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
		"faru-agent",
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
