/**
 * The commit guard.
 *
 * A conflict-marked file reaches a remote through the auto-commit path, not
 * through a person: `git add .` cannot tell a half-resolved merge from an edit.
 * So the check belongs in the daemon's own commit path, where it needs no
 * per-clone setup — if the daemon runs, the check runs.
 *
 * The guard EXCLUDES an offending path rather than refusing the commit. A hook
 * only has an exit code, and one broken file blocking every auto-commit would
 * stop unrelated work across the whole repository.
 *
 * Real git throughout, no mocks: the behaviours being pinned here are git's own
 * (`git commit` refusing an unmerged index, `git add` clearing the unmerged
 * flag), and a stub would define every one of them away.
 */

const { test, expect, afterEach } = require("bun:test");
const { makeRepo, conflicted, recorder } = require("./helpers/repo");
const { stageWithGuard } = require("../gitguard");

let repo = null;
afterEach(() => {
	if (repo) repo.cleanup();
	repo = null;
});

const MARKED = conflicted('{"items": ["a"]}', '{"items": ["a", "b"]}');

/**
 * Drives two clones into a real `git stash pop` conflict rather than writing a
 * file with markers typed into it. Leaves w1 with markers in the working tree
 * AND an unmerged index entry, which is the combination that matters.
 */
function realStashPopConflict(rel) {
	const other = repo.clone("w2");
	other.write(rel, '{"items": ["remote"]}\n');
	other.commit("remote edit");
	other.push();

	repo.write(rel, '{"items": ["local"]}\n');
	repo.git("stash", "--include-untracked");
	repo.git("pull", "--rebase");
	const pop = repo.gitTry("stash", "pop");
	expect(pop.ok).toBe(false); // the collision the daemon logs and walks past
	return repo;
}

test("characterisation — today's `git add .` commits conflict markers", () => {
	repo = makeRepo({ "state.json": '{"items": []}\n' });
	repo.write("state.json", MARKED);

	repo.git("add", ".");
	repo.git("commit", "-q", "-m", "board: update");

	// This is the defect, reproduced. If this test ever goes green on its own,
	// the guard tests below have stopped proving anything.
	expect(repo.git("show", "HEAD:state.json")).toContain("<<<<<<<");
});

test("no-markers — no commit contains conflict markers, and the clean paths still land", () => {
	repo = makeRepo({ "state.json": '{"items": []}\n' });
	repo.write("state.json", MARKED);
	repo.write("notes/plan.md", "# unrelated work\n");
	const log = recorder();

	const result = stageWithGuard({ root: repo.root, paths: ["."], log });
	repo.git("commit", "-q", "-m", "board: update");

	expect(result.excluded.map((e) => e.path)).toEqual(["state.json"]);
	expect(repo.git("show", "HEAD:notes/plan.md")).toBe("# unrelated work\n");
	expect(repo.gitTry("show", "HEAD:state.json").out).not.toContain("<<<<<<<");
	// The damaged content is still on disk, recoverable. Excluding is not deleting.
	expect(repo.read("state.json")).toBe(MARKED);
});

test("no-markers — a real stash-pop conflict with an unmerged index still commits the rest", () => {
	repo = makeRepo({ "state.json": '{"items": []}\n' });
	realStashPopConflict("state.json");
	repo.write("notes/plan.md", "# unrelated work\n");
	const log = recorder();

	// `git commit` refuses outright while the index carries an unmerged entry,
	// so excluding the path from `git add` is not enough on its own — the guard
	// has to clear the index entry with `git reset HEAD -- <path>`.
	expect(repo.unmerged()).toContain("state.json");

	const result = stageWithGuard({ root: repo.root, paths: ["."], log });
	repo.git("commit", "-q", "-m", "board: update");

	expect(result.excluded.map((e) => e.path)).toEqual(["state.json"]);
	expect(repo.git("show", "HEAD:notes/plan.md")).toBe("# unrelated work\n");
	expect(repo.unmerged()).toEqual([]);
});

test("clean-index — the index is never left unmerged after the guard runs", () => {
	repo = makeRepo({ "state.json": '{"items": []}\n' });
	realStashPopConflict("state.json");

	stageWithGuard({ root: repo.root, paths: ["."], log: recorder() });

	expect(repo.unmerged()).toEqual([]);
});

test("not-blocking — an excluded path is reported, and does not block later commits", () => {
	repo = makeRepo({ "state.json": '{"items": []}\n' });
	repo.write("state.json", MARKED);
	const log = recorder();

	const first = stageWithGuard({ root: repo.root, paths: ["."], log });

	// The damaged file was the only change, so this cycle has nothing left to
	// commit. That is a no-op, not an error — the daemon must not try to commit
	// an empty index and log a failure every five seconds.
	expect(first.staged).toBe(false);

	// Reported loudly. Damage that is only visible in a daemon log nobody reads
	// is damage that runs for days.
	expect(log.text()).toContain("state.json");
	expect(log.text()).toMatch(/conflict marker/i);

	// The damaged file is still dirty. A later, unrelated commit must go through
	// rather than being stopped by it, cycle after cycle.
	repo.write("notes/later.md", "later work\n");
	const second = stageWithGuard({ root: repo.root, paths: ["."], log });
	expect(second.staged).toBe(true);
	repo.git("commit", "-q", "-m", "board: second");

	expect(second.excluded.map((e) => e.path)).toEqual(["state.json"]);
	expect(repo.git("show", "HEAD:notes/later.md")).toBe("later work\n");
	expect(repo.log().length).toBe(2); // seed + second; the excluded-only cycle added nothing
});

test("stage 2 — a staged JSON file that does not parse is excluded and reported", () => {
	repo = makeRepo({ "data/record.json": '{"name": "x"}\n' });
	// A torn write: no markers at all, just a truncated document. Nothing about
	// this file looks conflicted, and it is still unfit to commit.
	repo.write("data/record.json", '{"name": "x", "items": [{"kind": "par');
	repo.write("notes/plan.md", "# unrelated\n");
	const log = recorder();

	const result = stageWithGuard({ root: repo.root, paths: ["."], log });
	repo.git("commit", "-q", "-m", "board: update");

	expect(result.excluded.map((e) => e.path)).toEqual(["data/record.json"]);
	expect(log.text()).toMatch(/does not parse|unparsable/i);
	expect(repo.git("show", "HEAD:notes/plan.md")).toBe("# unrelated\n");
});

test("a clean tree is untouched — the guard costs nothing when nothing is wrong", () => {
	repo = makeRepo({ "data/record.json": '{"name": "x"}\n' });
	repo.write("data/record.json", '{"name": "y"}\n');
	repo.write("notes/plan.md", "# fine\n");

	const result = stageWithGuard({ root: repo.root, paths: ["."], log: recorder() });
	repo.git("commit", "-q", "-m", "board: update");

	expect(result.excluded).toEqual([]);
	expect(repo.git("show", "HEAD:data/record.json")).toBe('{"name": "y"}\n');
	expect(repo.git("show", "HEAD:notes/plan.md")).toBe("# fine\n");
});

test("a markdown setext heading is not mistaken for a conflict marker", () => {
	repo = makeRepo({ "notes/doc.md": "x\n" });
	// `=======` alone is a legitimate line in markdown. Requiring the opening
	// AND closing marker is what keeps a docs-shaped repository from being
	// shredded by false positives.
	repo.write("notes/doc.md", "Title\n=======\n\nBody text.\n");

	const result = stageWithGuard({ root: repo.root, paths: ["."], log: recorder() });
	repo.git("commit", "-q", "-m", "board: update");

	expect(result.excluded).toEqual([]);
	expect(repo.git("show", "HEAD:notes/doc.md")).toContain("=======");
});
