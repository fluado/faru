/**
 * faru dojo — kata scheduler.
 *
 * Scans kata/*.md files, runs them on cron schedules via the existing
 * dispatch driver, and stores sweep reports alongside each kata definition.
 */

const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

// ---------------------------------------------------------------------------
// Frontmatter parser (reused pattern from dispatch.js)
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

// ---------------------------------------------------------------------------
// Kata discovery — reads kata/*.md from disk every call
// ---------------------------------------------------------------------------

function scanKata(kataDir) {
	if (!kataDir || !fs.existsSync(kataDir)) return [];
	return fs
		.readdirSync(kataDir)
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const id = f.replace(".md", "");
			const raw = fs.readFileSync(path.join(kataDir, f), "utf-8");
			const { meta, body } = parseFrontmatter(raw);
			const schedule = meta.schedule || null;
			const title = deriveTitle(id);
			return { id, title, schedule, body, file: f };
		});
}

function deriveTitle(id) {
	return id
		.split("-")
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

// ---------------------------------------------------------------------------
// Sweep discovery — reads kata/{id}/*-sweep.md files
// ---------------------------------------------------------------------------

function scanSweeps(kataDir) {
	if (!kataDir || !fs.existsSync(kataDir)) return [];

	const allSweeps = [];
	const kataList = scanKata(kataDir);

	for (const kata of kataList) {
		const sweepDir = path.join(kataDir, kata.id);
		if (!fs.existsSync(sweepDir) || !fs.statSync(sweepDir).isDirectory()) continue;

		const files = fs.readdirSync(sweepDir)
			.filter((f) => f.endsWith("-sweep.md"))
			.sort()
			.reverse(); // newest first

		for (const f of files) {
			const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/);
			const date = dateMatch ? dateMatch[1] : f.replace("-sweep.md", "");
			const content = fs.readFileSync(path.join(sweepDir, f), "utf-8");

			// Extract a one-line summary from the report
			const summary = extractSummary(content);

			allSweeps.push({
				kataId: kata.id,
				kataTitle: kata.title,
				date,
				file: f,
				summary,
				content,
			});
		}
	}

	// Sort all sweeps by date descending
	allSweeps.sort((a, b) => b.date.localeCompare(a.date));
	return allSweeps;
}

function extractSummary(content) {
	// Try to find "Fixed" or "Could Not Fix" sections
	const fixedMatch = content.match(/## Fixed \((\d+)\)/);
	const cantFixMatch = content.match(/## Could Not Fix \((\d+)\)/);
	const fixed = fixedMatch ? parseInt(fixedMatch[1], 10) : 0;
	const cantFix = cantFixMatch ? parseInt(cantFixMatch[1], 10) : 0;

	if (fixed > 0 && cantFix > 0) return `fixed ${fixed}, ${cantFix} finding${cantFix > 1 ? "s" : ""}`;
	if (fixed > 0) return `fixed ${fixed}`;
	if (cantFix > 0) return `${cantFix} finding${cantFix > 1 ? "s" : ""}`;

	// Check if "healthy" appears
	if (/healthy/i.test(content) || /all.*pass/i.test(content)) return "healthy";

	return "completed";
}

// ---------------------------------------------------------------------------
// Duration formatting (reused from dispatch.js)
// ---------------------------------------------------------------------------

function formatDuration(ms) {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

// ---------------------------------------------------------------------------
// Kata runner — fires a kata prompt through the dispatch driver
// ---------------------------------------------------------------------------

let kataState = {
	status: "idle", // "idle" | "running"
	currentKata: null,
	startedAt: null,
};

function getKataState() {
	return { ...kataState };
}

async function runKata(kata, kataDir, driver, agentConfig, fns) {
	// fns: { log, notifyReload, getDispatchState }

	// Guard: don't run if dispatch is active
	if (fns.getDispatchState().status === "running") {
		fns.log(`⏭  Kata "${kata.title}" skipped — dispatch is running`);
		return { success: false, reason: "dispatch-running" };
	}

	// Guard: don't run if another kata is running
	if (kataState.status === "running") {
		fns.log(`⏭  Kata "${kata.title}" skipped — another kata is running`);
		return { success: false, reason: "kata-running" };
	}

	kataState = {
		status: "running",
		currentKata: kata.id,
		startedAt: new Date().toISOString(),
	};

	const sweepDate = new Date().toISOString().slice(0, 10);
	const sweepDir = path.join(kataDir, kata.id);
	const sweepFile = `${sweepDate}-sweep.md`;
	const sentinelFile = ".sweep-complete";
	const sentinelAbsPath = path.join(sweepDir, sentinelFile);

	// Ensure sweep directory exists
	if (!fs.existsSync(sweepDir)) {
		fs.mkdirSync(sweepDir, { recursive: true });
	}

	// Clean stale sentinel
	try { fs.unlinkSync(sentinelAbsPath); } catch (_) {}

	const startTime = Date.now();
	fns.log(`🥋 Kata "${kata.title}" starting`);

	try {
		// New session
		await driver.newSession(agentConfig);

		// Select model if the prompt references a skill with a model
		// (for kata we don't auto-detect — the prompt is user-controlled)

		// Compose prompt: kata body + sentinel
		const repoName = path.basename(process.cwd());
		const sentinelPath = `kata/${kata.id}/${sentinelFile}`;
		const prompt = `${kata.body}\n\nWhen done, create \`${sentinelPath}\` with content \`done\`.`;

		// Execute
		const result = await driver.execute(prompt, agentConfig, sentinelAbsPath);

		const duration = formatDuration(Date.now() - startTime);

		if (result.success) {
			fns.log(`✅ Kata "${kata.title}" completed (${duration})`);
		} else {
			fns.log(`❌ Kata "${kata.title}" failed (${duration}): ${result.output.substring(0, 200)}`);
		}

		// Release workspace
		if (driver.releaseWorkspace) driver.releaseWorkspace();

		kataState = { status: "idle", currentKata: null, startedAt: null };
		fns.notifyReload();

		return {
			success: result.success,
			duration: Date.now() - startTime,
			durationFormatted: duration,
		};

	} catch (e) {
		const duration = formatDuration(Date.now() - startTime);
		fns.log(`❌ Kata "${kata.title}" crashed (${duration}): ${e.message}`);
		if (driver.releaseWorkspace) driver.releaseWorkspace();
		kataState = { status: "idle", currentKata: null, startedAt: null };
		fns.notifyReload();
		return { success: false, duration: Date.now() - startTime, durationFormatted: duration };
	}
}

// ---------------------------------------------------------------------------
// Cron scheduler — starts cron jobs for each active kata
// ---------------------------------------------------------------------------

let activeJobs = [];

function startScheduler(kataDir, driver, agentConfig, fns) {
	stopScheduler();

	const kataList = scanKata(kataDir);
	const scheduled = kataList.filter((k) =>
		k.schedule && k.schedule !== "paused" && cron.validate(k.schedule)
	);

	for (const kata of scheduled) {
		const job = cron.schedule(kata.schedule, () => {
			runKata(kata, kataDir, driver, agentConfig, fns).catch((e) => {
				fns.log(`❌ Kata "${kata.title}" cron error: ${e.message}`);
			});
		});
		activeJobs.push({ kataId: kata.id, job });
		fns.log(`📅 Kata "${kata.title}" scheduled: ${kata.schedule}`);
	}

	const invalidCount = kataList.filter(
		(k) => k.schedule && k.schedule !== "paused" && !cron.validate(k.schedule)
	).length;
	if (invalidCount > 0) {
		fns.log(`⚠  ${invalidCount} kata with invalid cron expressions — skipped`);
	}

	return scheduled.length;
}

function stopScheduler() {
	for (const { job } of activeJobs) {
		job.stop();
	}
	activeJobs = [];
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
	scanKata,
	scanSweeps,
	runKata,
	getKataState,
	startScheduler,
	stopScheduler,
};
