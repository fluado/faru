/**
 * Husk cleanup.
 *
 * Real repositories throughout: whether a folder is a husk is decided by git
 * (tracked, untracked, ignored, a rebase in progress), and a stubbed git would
 * decide every case these tests exist for.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { test, expect, afterEach } = require("bun:test");
const { makeRepo, recorder, gitTry } = require("./helpers/repo");
const { pruneHusks } = require("../husks");

let repo = null;
afterEach(() => {
	if (repo) repo.cleanup();
	repo = null;
});

const CARD = "2026-01-01-OPS-CARD";

const prune = (log = recorder()) =>
	pruneHusks({ repo: repo.root, backlogDir: repo.at("backlog"), log });

/**
 * Another clone archives the card and pushes; this clone pulls. The marker a
 * dispatched agent wrote is gitignored, so the pull cannot remove the folder.
 */
function archivedElsewhere() {
	repo.write(`backlog/${CARD}/.dispatch-complete`, "done");
	const other = repo.clone("archiver");
	fs.mkdirSync(other.at("backlog/archive"), { recursive: true }); // git mv needs the parent to exist
	other.git("mv", `backlog/${CARD}`, `backlog/archive/${CARD}`);
	other.commit("board: auto-archive 1 done card");
	other.push();
	repo.git("pull", "-q");
	return other;
}

test("a card archived on another clone leaves only .dispatch-complete: removed and logged", async () => {
	repo = makeRepo({
		".gitignore": ".dispatch-complete\n",
		[`backlog/${CARD}/CARD.md`]: "status: done\n",
	});
	archivedElsewhere();
	expect(fs.readdirSync(repo.at(`backlog/${CARD}`))).toEqual([".dispatch-complete"]);
	const log = recorder();

	const removed = await prune(log);

	expect(removed).toEqual([CARD]);
	expect(repo.exists(`backlog/${CARD}`)).toBe(false);
	expect(repo.exists(`backlog/archive/${CARD}/CARD.md`)).toBe(true);
	expect(log.text()).toContain(`removed 1 archived card husk(s): ${CARD}`);
});

test("a new card under an archived name keeps its untracked CARD.md", async () => {
	repo = makeRepo({ [`backlog/archive/${CARD}/CARD.md`]: "status: done\n" });
	repo.write(`backlog/${CARD}/CARD.md`, "status: todo\n");

	expect(await prune()).toEqual([]);
	expect(repo.read(`backlog/${CARD}/CARD.md`)).toBe("status: todo\n");
});

test("a folder with a tracked file stays", async () => {
	repo = makeRepo({
		[`backlog/archive/${CARD}/CARD.md`]: "status: done\n",
		[`backlog/${CARD}/CARD.md`]: "status: todo\n",
	});

	expect(await prune()).toEqual([]);
	expect(repo.exists(`backlog/${CARD}/CARD.md`)).toBe(true);
});

test("an ignored file next to an untracked, not ignored file stays", async () => {
	repo = makeRepo({
		".gitignore": ".dispatch-complete\n",
		[`backlog/archive/${CARD}/CARD.md`]: "status: done\n",
	});
	repo.write(`backlog/${CARD}/.dispatch-complete`, "done");
	repo.write(`backlog/${CARD}/notes.md`, "half a thought\n");

	expect(await prune()).toEqual([]);
	expect(repo.exists(`backlog/${CARD}/notes.md`)).toBe(true);
	expect(repo.exists(`backlog/${CARD}/.dispatch-complete`)).toBe(true);
});

test("an empty folder with an archive twin stays", async () => {
	repo = makeRepo({ [`backlog/archive/${CARD}/CARD.md`]: "status: done\n" });
	fs.mkdirSync(repo.at(`backlog/${CARD}`));

	expect(await prune()).toEqual([]);
	expect(repo.exists(`backlog/${CARD}`)).toBe(true);
});

test("outside a git work tree it returns []", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "faru-husks-"));
	try {
		expect(gitTry(dir, ["rev-parse", "--is-inside-work-tree"]).ok).toBe(false);
		fs.mkdirSync(path.join(dir, "backlog", "archive", CARD), { recursive: true });
		fs.writeFileSync(path.join(dir, "backlog", "archive", CARD, "CARD.md"), "status: done\n");
		fs.mkdirSync(path.join(dir, "backlog", CARD));
		fs.writeFileSync(path.join(dir, "backlog", CARD, ".dispatch-complete"), "done");

		const removed = await pruneHusks({ repo: dir, backlogDir: path.join(dir, "backlog"), log: recorder() });

		expect(removed).toEqual([]);
		expect(fs.existsSync(path.join(dir, "backlog", CARD, ".dispatch-complete"))).toBe(true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("nothing is removed while a rebase is in progress", async () => {
	repo = makeRepo({
		".gitignore": ".dispatch-complete\n",
		[`backlog/${CARD}/CARD.md`]: "status: done\n",
	});
	const other = archivedElsewhere();
	// A rebase that stops on a conflict, as a person's or an agent's would.
	repo.write("README.md", "# local\n");
	repo.commit("local edit");
	other.write("README.md", "# remote\n");
	other.commit("remote edit");
	other.push();
	expect(repo.gitTry("pull", "--rebase").ok).toBe(false);
	expect(repo.exists(".git/rebase-merge")).toBe(true);

	expect(await prune()).toEqual([]);
	expect(repo.exists(`backlog/${CARD}/.dispatch-complete`)).toBe(true);
});
