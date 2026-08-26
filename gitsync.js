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
 * other than its own last write — and if it does a read-modify-write, it will
 * happily write that stale view back.
 *
 * So this does NOT stash. `git stash` takes the entire working tree away from
 * whoever else is using it and holds it away across the network round-trip of a
 * fetch, which is the widest window available. Committing first instead leaves
 * the tree at its current content and reduces the exposure to the rebase replay
 * itself; measured against a local origin, ~97 ms of stale tree became ~5 ms.
 *
 * It also gains a real fail-safe: `git pull --rebase` REFUSES to run on a dirty
 * tree, so if the local changes could not be committed for any reason, the pull
 * declines instead of proceeding over them.
 */

const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const { stageWithGuard } = require("./gitguard");

/** Subject for the commit the sync makes on its own initiative. Never contains
 *  a filename: this runs against repositories whose file names are private and
 *  whose origin may be public. */
const PRE_SYNC_SUBJECT = "board: local changes before sync";

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

/** Async so a fetch (measured at 1.5 s against a real remote) does not block
 *  the board's HTTP server for its duration. */
function gitAsync(root, args) {
	return new Promise((resolve) => {
		execFile("git", args, { cwd: root }, (err, stdout, stderr) => {
			resolve({
				ok: !err,
				out: stdout || "",
				err: (stderr || "").trim() || (err ? err.message : ""),
			});
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

function unmergedPaths(root) {
	return gitTry(root, ["diff", "--name-only", "--diff-filter=U"])
		.out.split("\n")
		.filter(Boolean);
}

/** git leaves one of these directories behind while a rebase is in flight. */
function rebaseInProgress(root) {
	const gitDir = gitTry(root, ["rev-parse", "--git-dir"]).out.trim();
	if (!gitDir) return false;
	const base = path.isAbsolute(gitDir) ? gitDir : path.join(root, gitDir);
	return fs.existsSync(path.join(base, "rebase-merge")) || fs.existsSync(path.join(base, "rebase-apply"));
}

/**
 * Aborts a rebase and PROVES it worked.
 *
 * The previous version of this called `git rebase --abort` inside an empty
 * catch, so a failed abort was indistinguishable from a successful one and the
 * daemon carried on against a repository stuck mid-rebase — committing and
 * pushing out of that state is how a conflicted tree reaches a remote.
 *
 * Returns true only if no rebase is in progress and nothing is unmerged.
 */
function abortRebaseVerified(root, log) {
	gitTry(root, ["rebase", "--abort"]);

	const stillRebasing = rebaseInProgress(root);
	const stillUnmerged = unmergedPaths(root);
	if (!stillRebasing && stillUnmerged.length === 0) return true;

	log(
		`🛑 rebase --abort did not leave a clean repository` +
			(stillRebasing ? ` (a rebase is still in progress)` : ``) +
			(stillUnmerged.length ? ` (${stillUnmerged.length} unmerged path(s))` : ``) +
			` — stopping sync rather than continuing blind`
	);
	return false;
}

/**
 * Pulls the remote into the working tree.
 *
 * Returns:
 *   status    "synced" | "unchanged" | "blocked" | "failed" | "halted"
 *   pulled    oneline descriptions of the commits that arrived
 *   committed true if local changes were committed before the pull
 *   excluded  paths the guard held back, if any
 *   error     a human-readable reason when the status is not a success
 *
 * "halted" means the repository could not be returned to a known-good state.
 * The caller must stop syncing on it; continuing is how damage spreads.
 */
async function syncWithRemote({ repo, log }) {
	const localHead = git(repo, ["rev-parse", "HEAD"]).trim();
	const result = {
		status: "unchanged",
		pulled: [],
		committed: false,
		excluded: [],
		error: null,
	};

	// 1. Commit whatever is in the tree, rather than stashing it away. The guard
	//    keeps anything broken out of that commit.
	if (isDirty(repo)) {
		const guard = stageWithGuard({ root: repo, paths: ["."], log });
		result.excluded = guard.excluded;
		if (guard.staged) {
			const committed = gitTry(repo, ["commit", "-m", PRE_SYNC_SUBJECT]);
			if (!committed.ok) {
				result.status = "blocked";
				result.error = `could not commit local changes: ${committed.out}`;
				log(`⚠  ${result.error}`);
				return result;
			}
			result.committed = true;
		}
	}

	// 2. A tree still dirty here holds only files the guard refused to commit.
	//    `git pull --rebase` would refuse anyway; declining explicitly says why.
	if (isDirty(repo)) {
		result.status = "blocked";
		result.error =
			`working tree still has uncommitted changes after the guard ran ` +
			`(${result.excluded.length} path(s) held back) — not pulling over them`;
		log(`⚠  ${result.error}`);
		return result;
	}

	// 3. Rebase onto the remote. The tree is clean, so a failure here is
	//    recoverable by definition: nothing uncommitted can be lost.
	const pull = await gitAsync(repo, ["pull", "--rebase"]);
	if (!pull.ok) {
		log(`⚠  git pull --rebase failed: ${pull.err}`);
		if (!abortRebaseVerified(repo, log)) {
			result.status = "halted";
			result.error = "rebase could not be aborted cleanly";
			return result;
		}
		result.status = "failed";
		result.error = pull.err;
		log(`↩  rebase aborted; local commits are intact and will be retried next cycle`);
		return result;
	}

	result.pulled = incoming(repo, localHead);
	result.status = result.pulled.length || result.committed ? "synced" : "unchanged";
	return result;
}

module.exports = {
	syncWithRemote,
	abortRebaseVerified,
	rebaseInProgress,
	unmergedPaths,
	isDirty,
	incoming,
	git,
	gitTry,
	gitAsync,
	PRE_SYNC_SUBJECT,
};
