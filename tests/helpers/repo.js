/**
 * Throwaway git repositories for the sync tests.
 *
 * Deliberately NO MOCKS. The defects these tests pin live in git's own
 * behaviour — `git stash` exiting 0 on a clean tree, `git commit` refusing an
 * unmerged index, git unlinking a working-tree file before rewriting it — and a
 * stubbed git would define every one of them away. So each test builds a real
 * bare origin, clones it for real, and runs the real binary against it.
 *
 * Shape:
 *
 *   <tmp>/origin.git      bare, the shared remote
 *   <tmp>/w1/             a clone — one "machine"
 *   <tmp>/w2/             another clone, for the two-writer cases
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

/** Every clone gets these, so a test never depends on the host's git identity. */
const IDENTITY = [
	["user.email", "harness@example.test"],
	["user.name", "faru harness"],
	["commit.gpgsign", "false"],
	["core.hooksPath", ""],
	["pull.rebase", "true"],
];

function git(cwd, args, opts = {}) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: "pipe",
		...opts,
	});
}

/** Runs a git command that is allowed to fail; returns {ok, out}. */
function gitTry(cwd, args) {
	try {
		return { ok: true, out: git(cwd, args) };
	} catch (e) {
		return { ok: false, out: `${e.stdout || ""}${e.stderr || ""}` };
	}
}

function makeClone(originPath, dir, name) {
	git(path.dirname(dir), ["clone", "-q", originPath, path.basename(dir)]);
	for (const [key, value] of IDENTITY) git(dir, ["config", key, value]);

	return {
		name,
		root: dir,
		git: (...args) => git(dir, args),
		gitTry: (...args) => gitTry(dir, args),
		/** Absolute path of a repo-relative file. */
		at: (rel) => path.join(dir, rel),
		write(rel, content) {
			const full = path.join(dir, rel);
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, content, "utf-8");
			return full;
		},
		read: (rel) => fs.readFileSync(path.join(dir, rel), "utf-8"),
		exists: (rel) => fs.existsSync(path.join(dir, rel)),
		commit(message, rel) {
			git(dir, ["add", rel === undefined ? "." : rel]);
			git(dir, ["commit", "-q", "-m", message]);
			return git(dir, ["rev-parse", "HEAD"]).trim();
		},
		push: () => git(dir, ["push", "-q", "origin", "HEAD"]),
		head: () => git(dir, ["rev-parse", "HEAD"]).trim(),
		status: () => git(dir, ["status", "--porcelain"]),
		/** Paths git reports as unmerged — I4 reads this. */
		unmerged() {
			return git(dir, ["diff", "--name-only", "--diff-filter=U"])
				.split("\n")
				.filter(Boolean);
		},
		stashList: () => git(dir, ["stash", "list"]).split("\n").filter(Boolean),
		log: () => git(dir, ["log", "--oneline"]).split("\n").filter(Boolean),
	};
}

/**
 * Builds a bare origin with one seed commit and returns the first clone.
 * `.clone(name)` hands back another clone of the same origin — that is the
 * two-machines-from-the-same-base shape the deterministic tests need.
 */
function makeRepo(seed = {}) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "faru-sync-"));
	const originPath = path.join(tmp, "origin.git");
	git(tmp, ["init", "-q", "--bare", "origin.git"]);

	// Seed through a scratch clone so the bare origin starts with a real HEAD.
	const seedDir = path.join(tmp, "seed");
	const seedClone = makeClone(originPath, seedDir, "seed");
	seedClone.write("README.md", "# harness\n");
	for (const [rel, content] of Object.entries(seed)) seedClone.write(rel, content);
	seedClone.commit("seed");
	seedClone.git("push", "-q", "origin", "HEAD");
	fs.rmSync(seedDir, { recursive: true, force: true });

	const clones = [];
	const first = makeClone(originPath, path.join(tmp, "w1"), "w1");
	clones.push(first);

	first.tmp = tmp;
	first.originPath = originPath;
	first.clone = (name = `w${clones.length + 1}`) => {
		const extra = makeClone(originPath, path.join(tmp, name), name);
		clones.push(extra);
		return extra;
	};
	first.cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });

	return first;
}

/** A file carrying real conflict markers, as a collided stash pop leaves it. */
function conflicted(ours, theirs) {
	return [
		"<<<<<<< Updated upstream",
		ours,
		"=======",
		theirs,
		">>>>>>> Stashed changes",
		"",
	].join("\n");
}

/** Collects log lines the way the daemon's `log()` does, for assertions. */
function recorder() {
	const lines = [];
	const log = (message) => lines.push(String(message));
	log.lines = lines;
	log.text = () => lines.join("\n");
	return log;
}

module.exports = { makeRepo, conflicted, recorder, git, gitTry };
