/**
 * Removes card folders a pull left behind as husks.
 *
 * When another clone archives a card, the pull deletes its tracked files here,
 * but git never removes a directory that still holds an ignored file, and a
 * dispatched card holds `.dispatch-complete`. The folder survives with nothing
 * but that marker in it and the board shows a blank card. The pull is
 * enmetu's (or a person's own `git pull`), and neither knows what a card is,
 * so faru's backlog watcher calls this after every backlog change.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

/** Async, so a backlog event never blocks the board's HTTP server on git. Resolves null when git fails. */
function git(cwd, args) {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, encoding: "utf-8" }, (err, stdout) => resolve(err ? null : stdout));
	});
}

/** Any file at any depth. A folder holding only directories is an agent's mkdir before its first write. */
function holdsAFile(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory() || holdsAFile(path.join(dir, entry.name))) return true;
	}
	return false;
}

/**
 * True inside a git work tree with no rebase or merge in progress. During a
 * person's stopped `rebase -i`, a locally committed card's tracked files are
 * off disk for minutes, and its folder looks exactly like a husk.
 */
async function idleWorkTree(repo) {
	const out = await git(repo, [
		"rev-parse",
		"--is-inside-work-tree",
		"--git-path", "rebase-merge",
		"--git-path", "rebase-apply",
		"--git-path", "MERGE_HEAD",
	]);
	if (out === null) return false;
	const [inside, ...paths] = out.trim().split("\n");
	return inside === "true" && !paths.some((p) => fs.existsSync(path.resolve(repo, p)));
}

/**
 * Removes backlog/<slug> when all of these hold:
 *   1. backlog/archive/<slug> exists (the archive twin);
 *   2. the folder holds at least one file (an agent's mkdir before its first write stays);
 *   3. `git ls-files --cached --others --exclude-standard -- <rel>` prints nothing:
 *      every file left is gitignored;
 *   4. no rebase or merge is in progress (rebase-merge, rebase-apply, MERGE_HEAD absent,
 *      paths from `git rev-parse --git-path`).
 * Async git (execFile), and only for folders that pass 1 and 2. Never rejects; outside a
 * git work tree it returns []. Logs "removed N archived card husk(s): ...".
 * @param {{ repo: string, backlogDir: string, log: (line: string) => void }} options
 * @returns {Promise<string[]>} the slugs removed
 */
async function pruneHusks({ repo, backlogDir, log }) {
	const removed = [];
	try {
		const archiveDir = path.join(backlogDir, "archive");
		if (!fs.existsSync(backlogDir) || !fs.existsSync(archiveDir)) return removed;

		// Rules 1 and 2 cost a readdir and an existsSync per card folder; a normal
		// backlog event stops here without running git.
		const candidates = fs
			.readdirSync(backlogDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name !== "archive")
			.map((entry) => entry.name)
			.filter((slug) => fs.existsSync(path.join(archiveDir, slug)) && holdsAFile(path.join(backlogDir, slug)));
		if (candidates.length === 0 || !(await idleWorkTree(repo))) return removed;

		for (const slug of candidates) {
			const folder = path.join(backlogDir, slug);
			const rel = path.relative(repo, folder).split(path.sep).join("/");
			// A card being created under an archived name holds an untracked, not
			// ignored CARD.md; listing it keeps the folder. Literal pathspecs, so a
			// folder name with glob characters matches only itself.
			const listed = await git(repo, ["--literal-pathspecs", "ls-files", "--cached", "--others", "--exclude-standard", "--", rel]);
			if (listed === null || listed.trim() !== "") continue;
			fs.rmSync(folder, { recursive: true, force: true });
			removed.push(slug);
		}
	} catch (_) {
		// A folder that vanished mid-scan, or a permission error: report what was done.
	}
	if (removed.length) log(`🧹 removed ${removed.length} archived card husk(s): ${removed.join(", ")}`);
	return removed;
}

module.exports = { pruneHusks };
