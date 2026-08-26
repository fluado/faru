/**
 * The sync half of the board daemon: bring the working tree in line with the
 * remote, without losing anything that was written while it happened.
 *
 * Extracted from server.js's checkRemote() so it can be tested against a real
 * git binary rather than a stub. The polling (remote SHA every 5 s), the mutex
 * and the live-reload notification stay in server.js; everything that touches
 * the working tree is here.
 *
 * The rule this module exists to keep: another process may be reading and
 * writing files in this working tree the whole time we run. Every step that
 * changes what is on disk is a window in which that process sees something
 * other than its own last write.
 */

const { execFile, execFileSync } = require("child_process");
const { stageWithGuard } = require("./gitguard");

function git(root, args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: "pipe" });
}

function gitTry(root, args) {
	try {
		return { ok: true, out: git(root, args) };
	} catch (e) {
		return { ok: false, out: `${(e && e.stdout) || ""}${(e && e.stderr) || ""}`.trim() };
	}
}

/** Async so a ~1.5 s fetch does not block the board's HTTP server. */
function gitAsync(root, args) {
	return new Promise((resolve) => {
		execFile("git", args, { cwd: root }, (err, stdout, stderr) => {
			resolve({ ok: !err, out: stdout || "", err: (stderr || "").trim() || (err ? err.message : "") });
		});
	});
}

/** Commits that arrived between the old local HEAD and now, oldest first. */
function incoming(root, fromSha) {
	const r = gitTry(root, ["log", `${fromSha}..HEAD`, "--oneline", "--reverse"]);
	return r.ok ? r.out.trim().split("\n").filter(Boolean) : [];
}

function isDirty(root) {
	return gitTry(root, ["status", "--porcelain"]).out.trim() !== "";
}

/**
 * Pulls the remote into the working tree.
 *
 * Returns:
 *   status   "synced" | "unchanged" | "failed"
 *   pulled   oneline descriptions of the commits that arrived
 *   excluded paths the guard held back, if any
 *   error    a human-readable reason when status is "failed"
 */
async function syncWithRemote({ repo, log }) {
	const localHead = git(repo, ["rev-parse", "HEAD"]).trim();
	const result = { status: "unchanged", pulled: [], excluded: [], error: null };

	// Stash any uncommitted changes so pull --rebase can proceed on a dirty
	// working tree (e.g. a user mid-edit between debounce cycles).
	let stashed = false;
	try {
		execFileSync("git", ["stash", "--include-untracked"], { cwd: repo, stdio: "pipe" });
		stashed = true;
	} catch (_) {
		// Nothing to stash (clean tree)
	}

	const pull = await gitAsync(repo, ["pull", "--rebase"]);
	if (!pull.ok) {
		log(`⚠  git pull failed: ${pull.err}`);
		gitTry(repo, ["rebase", "--abort"]);
		result.status = "failed";
		result.error = pull.err;
	} else {
		result.pulled = incoming(repo, localHead);
		result.status = result.pulled.length ? "synced" : "unchanged";
	}

	if (stashed) {
		const pop = gitTry(repo, ["stash", "pop"]);
		if (!pop.ok) log(`⚠  git stash pop conflict — changes preserved in stash list`);
	}

	return result;
}

module.exports = { syncWithRemote, git, gitTry, gitAsync, isDirty, incoming, stageWithGuard };
