/**
 * Commit guard — the daemon never commits a broken file.
 *
 * The board stages with `git add .` and commits whatever it finds. That is the
 * right default for an auto-commit loop, and it has one bad case: when a merge,
 * a rebase or a stash pop has left a file half-resolved, `git add .` picks up
 * the conflict markers and pushes them to the remote. From there every other
 * clone pulls them, and any program that parses the file starts failing.
 *
 * Two checks, both cheap and both scoped to what is about to be committed:
 *
 *   1. conflict markers — a file carrying BOTH an opening `<<<<<<<` and a
 *      closing `>>>>>>>` line. Requiring the pair is deliberate: `=======` on
 *      its own is an ordinary markdown setext heading, and matching it alone
 *      would exclude a large share of any docs-shaped repository.
 *   2. JSON that does not parse — a torn or truncated write leaves no markers
 *      at all, just an incomplete document, and that is equally unfit to commit.
 *
 * An offending path is EXCLUDED and reported; the commit itself goes through
 * with everything else. Refusing the whole commit would let one broken file
 * stop every auto-commit in the repository, including unrelated work — which is
 * also why this lives here rather than in a pre-commit hook, where the only
 * available answer is a non-zero exit code.
 *
 * Excluding is not deleting. The damaged content stays in the working tree
 * where it can still be recovered; it simply stops spreading to the remote.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/** Files above this size are not scanned; nothing that large is hand-authored. */
const MAX_SCAN_BYTES = 32 * 1024 * 1024;

const MARKER_START = /^<{7}(?: |\t|$)/m;
const MARKER_END = /^>{7}(?: |\t|$)/m;

function git(root, args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: "pipe" });
}

function gitQuiet(root, args) {
	try {
		git(root, args);
		return true;
	} catch (_) {
		return false;
	}
}

/**
 * Every path git considers changed, including untracked and unmerged ones.
 * Read with -z because filenames may contain spaces.
 */
function changedPaths(root) {
	let out;
	try {
		out = git(root, ["status", "--porcelain", "-z", "--untracked-files=all"]);
	} catch (_) {
		return [];
	}

	const found = [];
	for (const entry of out.split("\0")) {
		if (entry.length < 4) continue;
		// "XY <path>"; a rename is "R  <new>\0<old>", and the old name arrives as
		// its own entry with no status prefix, which the length guard above drops.
		found.push(entry.slice(3));
	}
	return found;
}

/** Does this path sit inside one of the paths being staged? */
function isUnder(candidate, paths) {
	return paths.some((p) => {
		if (p === "." || p === "") return true;
		const normalised = p.replace(/\/+$/, "");
		return candidate === normalised || candidate.startsWith(`${normalised}/`);
	});
}

/**
 * Why this file must not be committed, or null if it is fine.
 * A file that cannot be read at all is left alone: an unreadable file is not
 * evidence of damage, and refusing to stage it would be its own failure mode.
 */
function inspect(root, rel) {
	const full = path.join(root, rel);

	let stat;
	try {
		stat = fs.statSync(full);
	} catch (_) {
		return null; // deleted between `git status` and now
	}
	if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return null;

	let content;
	try {
		content = fs.readFileSync(full, "utf-8");
	} catch (_) {
		return null;
	}
	if (content.includes("\0")) return null; // binary

	if (MARKER_START.test(content) && MARKER_END.test(content)) {
		return "carries conflict markers";
	}
	if (rel.endsWith(".json")) {
		try {
			JSON.parse(content);
		} catch (e) {
			return `does not parse as JSON (${e.message})`;
		}
	}
	return null;
}

/**
 * Stages `paths`, minus anything that fails the two checks.
 *
 * The order matters and is not obvious. The offenders are found BEFORE staging,
 * because `git add` on an unmerged path resolves the conflict by staging the
 * marker text and clears the unmerged flag that would otherwise identify it.
 * They are removed from the index AFTER staging, with `git reset HEAD --`,
 * because that is the only thing that clears an unmerged index entry — and
 * while one exists, `git commit` refuses outright:
 *
 *     error: Committing is not possible because you have unmerged files.
 *
 * Leaving the offender out of `git add` does not help on its own; a stash pop
 * or rebase conflict always leaves the index unmerged, so that is the common
 * case rather than the rare one.
 *
 * Returns { staged: boolean, excluded: [{ path, reason }] }.
 */
function stageWithGuard({ root, paths, log }) {
	const targets = paths && paths.length ? paths : ["."];
	const excluded = [];

	for (const rel of changedPaths(root)) {
		if (!isUnder(rel, targets)) continue;
		const reason = inspect(root, rel);
		if (reason !== null) excluded.push({ path: rel, reason });
	}

	for (const target of targets) git(root, ["add", target]);

	for (const { path: rel, reason } of excluded) {
		// Drops the index entry — unmerged or not — back to HEAD, leaving the
		// damaged file dirty in the working tree and out of this commit.
		gitQuiet(root, ["reset", "-q", "HEAD", "--", rel]);
		log(`⛔ excluded from commit — ${rel}: ${reason}`);
	}

	// `diff --cached --quiet` exits 1 when something IS staged. A cycle whose
	// only changed file was excluded leaves nothing to commit, and that is a
	// no-op, not an error — the caller must not try to commit an empty index.
	const staged = !gitQuiet(root, ["diff", "--cached", "--quiet"]);

	if (excluded.length > 0) {
		log(
			`⚠  ${excluded.length} file${excluded.length === 1 ? "" : "s"} held back and left in the working tree; ` +
				(staged ? `the rest of the commit went through` : `nothing else to commit this cycle`)
		);
	}

	return { staged, excluded };
}

module.exports = { stageWithGuard, inspect, changedPaths, MARKER_START, MARKER_END };
