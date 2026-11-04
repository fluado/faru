/**
 * The subjects faru writes for enmetu's commits.
 *
 * Real repositories: what changed between a parent and a tree is git's
 * answer, renames and all, and a stubbed git would answer for the test. Each
 * case commits for real and asks for the subject of that commit.
 */

const fs = require("fs");
const { test, expect, afterEach } = require("bun:test");
const { makeRepo } = require("./helpers/repo");
const { boardCommitMessage } = require("../commitMessages");

let repo = null;
afterEach(() => {
	if (repo) repo.cleanup();
	repo = null;
});

const CARD = "2026-11-04-OPS-LAUNCH-PLAN";

function card({ title = "Launch plan", status = "backlog", assigned = "yves", body = "Plan the launch.\n" } = {}) {
	return `---\ntitle: "${title}"\nstatus: ${status}\nassigned: ${assigned}\n---\n\n${body}`;
}

/** The subject faru writes for the last commit; runCommand answers with `command`, counting calls. */
async function subjectOfLastCommit(command = null) {
	const calls = { count: 0 };
	const subject = await boardCommitMessage(
		{
			root: repo.root,
			parent: repo.git("rev-parse", "HEAD^").trim(),
			tree: repo.git("rev-parse", "HEAD^{tree}").trim(),
			runCommand: async () => {
				calls.count++;
				return command;
			},
		},
		{ backlogDir: repo.at("backlog") },
	);
	return { subject, calls: calls.count };
}

test("a card whose status changed is moved, without asking the person's command", async () => {
	repo = makeRepo({ [`backlog/${CARD}/CARD.md`]: card() });
	repo.write(`backlog/${CARD}/CARD.md`, card({ status: "done" }));
	repo.commit("x");

	expect(await subjectOfLastCommit("From the command")).toEqual({ subject: "Move Launch plan to done", calls: 0 });
});

test("a card whose assignee changed is assigned", async () => {
	repo = makeRepo({ [`backlog/${CARD}/CARD.md`]: card() });
	repo.write(`backlog/${CARD}/CARD.md`, card({ assigned: "arbo" }));
	repo.commit("x");

	expect((await subjectOfLastCommit()).subject).toBe("Assign Launch plan to arbo");
});

test("a status change wins over an assignee change and counts the other moved cards", async () => {
	repo = makeRepo({
		[`backlog/${CARD}/CARD.md`]: card(),
		"backlog/2026-11-05-OPS-OTHER/CARD.md": card({ title: "Other" }),
	});
	repo.write(`backlog/${CARD}/CARD.md`, card({ status: "wip", assigned: "arbo" }));
	repo.write("backlog/2026-11-05-OPS-OTHER/CARD.md", card({ title: "Other", status: "done" }));
	repo.commit("x");

	const { subject } = await subjectOfLastCommit();

	expect(subject).toMatch(/^Move (Launch plan to wip|Other to done) and 1 more$/);
});

test("a new card is added under its title", async () => {
	repo = makeRepo();
	repo.write(`backlog/${CARD}/CARD.md`, card());
	repo.write(`backlog/${CARD}/notes.md`, "# Notes\n");
	repo.commit("x");

	expect((await subjectOfLastCommit()).subject).toBe("Add Launch plan");
});

test("a deleted card is removed under its title", async () => {
	repo = makeRepo({ [`backlog/${CARD}/CARD.md`]: card() });
	repo.git("rm", "-q", "-r", `backlog/${CARD}`);
	repo.git("commit", "-q", "-m", "x");

	expect((await subjectOfLastCommit()).subject).toBe("Remove Launch plan");
});

test("cards moved into the archive are archived, counted by card", async () => {
	repo = makeRepo({
		[`backlog/${CARD}/CARD.md`]: card({ status: "done" }),
		[`backlog/${CARD}/notes.md`]: "# Notes\n",
		"backlog/2026-11-05-OPS-OTHER/CARD.md": card({ title: "Other", status: "done" }),
	});
	fs.mkdirSync(repo.at("backlog/archive"), { recursive: true });
	repo.git("mv", `backlog/${CARD}`, `backlog/archive/${CARD}`);
	repo.git("mv", "backlog/2026-11-05-OPS-OTHER", "backlog/archive/2026-11-05-OPS-OTHER");
	repo.git("commit", "-q", "-m", "x");

	expect((await subjectOfLastCommit()).subject).toMatch(/^Archive (Launch plan|Other) and 1 more$/);
});

test("an edit takes the message of the person's command", async () => {
	repo = makeRepo({ [`backlog/${CARD}/CARD.md`]: card() });
	repo.write(`backlog/${CARD}/CARD.md`, card({ body: "Plan the launch for Monday.\n" }));
	repo.commit("x");

	expect(await subjectOfLastCommit("Launch plan: launch moved to Monday\n")).toEqual({
		subject: "Launch plan: launch moved to Monday\n",
		calls: 1,
	});
});

test("an edit without a command is an update of the card's title", async () => {
	repo = makeRepo({ [`backlog/${CARD}/CARD.md`]: card() });
	repo.write(`backlog/${CARD}/CARD.md`, card({ body: "Plan the launch for Monday.\n" }));
	repo.commit("x");

	expect(await subjectOfLastCommit(null)).toEqual({ subject: "Update Launch plan", calls: 1 });
});

test("a file outside the board is named by its first heading, the largest change first", async () => {
	repo = makeRepo({ "weekly-goal.md": "# Weekly goal\n\nShip.\n", "notes/a.md": "a\n" });
	repo.write("weekly-goal.md", "# Weekly goal\n\nShip the launch.\nThen rest.\nThen more.\n");
	repo.write("notes/a.md", "b\n");
	repo.commit("x");

	expect((await subjectOfLastCommit()).subject).toBe("Update Weekly goal and 1 more");
});

test("an HTML file is named by its <title>, a file without one by its readable name", async () => {
	repo = makeRepo({ "wireframes/04-fact.html": "<title>Fact page</title>\n", "data/lead_list.csv": "a\n" });
	repo.write("wireframes/04-fact.html", "<title>Fact page</title>\n<p>new</p>\n");
	repo.commit("x");

	expect((await subjectOfLastCommit()).subject).toBe("Update Fact page");

	repo.write("data/lead_list.csv", "a\nb\n");
	repo.commit("y");

	expect((await subjectOfLastCommit()).subject).toBe("Update lead list");
});

test("a card without a title is named by its slug, the date dropped", async () => {
	repo = makeRepo({ [`backlog/${CARD}/CARD.md`]: "---\nstatus: backlog\n---\n\nBody\n" });
	repo.write(`backlog/${CARD}/CARD.md`, "---\nstatus: done\n---\n\nBody\n");
	repo.commit("x");

	expect((await subjectOfLastCommit()).subject).toBe("Move OPS LAUNCH PLAN to done");
});

test("a board reached through a symbolic link is still the board git names (/tmp and /private/tmp on macOS)", async () => {
	repo = makeRepo({ [`backlog/${CARD}/CARD.md`]: card() });
	repo.write(`backlog/${CARD}/CARD.md`, card({ status: "done" }));
	repo.commit("x");
	const link = `${repo.tmp}/linked`;
	fs.symlinkSync(repo.root, link);

	const subject = await boardCommitMessage(
		{
			root: fs.realpathSync(repo.root),
			parent: repo.git("rev-parse", "HEAD^").trim(),
			tree: repo.git("rev-parse", "HEAD^{tree}").trim(),
			runCommand: async () => null,
		},
		{ backlogDir: `${link}/backlog` },
	);

	expect(subject).toBe("Move Launch plan to done");
});

test("git that cannot read the change leaves the subject to enmetu", async () => {
	repo = makeRepo();
	const subject = await boardCommitMessage(
		{ root: repo.root, parent: "0".repeat(40), tree: "1".repeat(40), runCommand: async () => "x" },
		{ backlogDir: repo.at("backlog") },
	);

	expect(subject).toBeNull();
});
