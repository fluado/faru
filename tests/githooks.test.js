/**
 * The pre-commit hook — the outer net.
 *
 * The guard covers the daemon's own commits. This covers everyone else who
 * commits in the same working tree, where the only available answer is an exit
 * code. It must block a broken commit, let a clean one through, and never take
 * over a hooks path somebody else configured.
 */

const fs = require("fs");
const path = require("path");
const { test, expect, afterEach } = require("bun:test");
const { makeRepo, conflicted, recorder } = require("./helpers/repo");
const { installHooks, HOOKS_DIR } = require("../githooks");

let repo = null;
afterEach(() => {
	if (repo) repo.cleanup();
	repo = null;
});

/** The harness disables hooks by default; these tests want them live. */
function withHooks() {
	repo.git("config", "--unset-all", "core.hooksPath");
	const result = installHooks({ root: repo.root, log: recorder() });
	expect(result.installed).toBe(true);
	return result;
}

test("blocks a commit that would record conflict markers", () => {
	repo = makeRepo({ "state.json": '{"items": []}\n' });
	withHooks();

	repo.write("state.json", conflicted('{"items": ["a"]}', '{"items": ["b"]}'));
	repo.git("add", ".");
	const commit = repo.gitTry("commit", "-m", "by hand");

	expect(commit.ok).toBe(false);
	expect(commit.out).toContain("conflict markers");
	expect(repo.log().length).toBe(1); // seed only
});

test("blocks a commit that would record unparsable JSON", () => {
	repo = makeRepo({ "state.json": '{"items": []}\n' });
	withHooks();

	repo.write("state.json", '{"items": [{"kind": "par');
	repo.git("add", ".");
	const commit = repo.gitTry("commit", "-m", "by hand");

	expect(commit.ok).toBe(false);
	expect(commit.out).toMatch(/does not parse/i);
});

test("lets a clean commit through", () => {
	repo = makeRepo({ "state.json": '{"items": []}\n' });
	withHooks();

	repo.write("state.json", '{"items": ["a"]}\n');
	repo.write("notes/plan.md", "Title\n=======\n\nBody.\n");
	repo.git("add", ".");
	const commit = repo.gitTry("commit", "-m", "by hand");

	expect(commit.ok).toBe(true);
	expect(repo.log().length).toBe(2);
});

test("inspects the STAGED content, not the working tree", () => {
	repo = makeRepo({ "state.json": '{"items": []}\n' });
	withHooks();

	// Staged clean, then damaged on disk afterwards. What gets committed is the
	// staged version, so this commit is fine and must not be blocked.
	repo.write("state.json", '{"items": ["a"]}\n');
	repo.git("add", "state.json");
	repo.write("state.json", conflicted("x", "y"));

	const commit = repo.gitTry("commit", "-m", "by hand");

	expect(commit.ok).toBe(true);
	expect(repo.git("show", "HEAD:state.json")).toBe('{"items": ["a"]}\n');
});

test("--no-verify still works, because a hook is a net and not a cage", () => {
	repo = makeRepo({ "state.json": '{"items": []}\n' });
	withHooks();

	repo.write("state.json", conflicted("x", "y"));
	repo.git("add", ".");
	const commit = repo.gitTry("commit", "--no-verify", "-m", "deliberate");

	expect(commit.ok).toBe(true);
});

test("installation is idempotent", () => {
	repo = makeRepo({ "state.json": '{"items": []}\n' });
	repo.git("config", "--unset-all", "core.hooksPath");

	const first = installHooks({ root: repo.root, log: recorder() });
	const before = fs.statSync(path.join(repo.root, HOOKS_DIR, "pre-commit")).mtimeMs;
	const second = installHooks({ root: repo.root, log: recorder() });
	const after = fs.statSync(path.join(repo.root, HOOKS_DIR, "pre-commit")).mtimeMs;

	expect(first.installed).toBe(true);
	expect(second.installed).toBe(true);
	expect(after).toBe(before); // not rewritten on every sync
	expect(repo.git("config", "--local", "core.hooksPath").trim()).toBe(HOOKS_DIR);
});

test("never takes over a hooks path somebody else configured", () => {
	repo = makeRepo({ "state.json": '{"items": []}\n' });
	repo.git("config", "--local", "core.hooksPath", ".my-hooks");

	const result = installHooks({ root: repo.root, log: recorder() });

	expect(result.installed).toBe(false);
	expect(result.reason).toContain(".my-hooks");
	expect(repo.git("config", "--local", "core.hooksPath").trim()).toBe(".my-hooks");
	expect(fs.existsSync(path.join(repo.root, HOOKS_DIR, "pre-commit"))).toBe(false);
});

test("the hook is committed content, so every clone gets it", () => {
	repo = makeRepo({ "state.json": '{"items": []}\n' });
	withHooks();

	repo.git("add", HOOKS_DIR);
	repo.git("commit", "-q", "-m", "add hook");

	expect(repo.git("show", `HEAD:${HOOKS_DIR}/pre-commit`)).toContain("conflict markers");
});
