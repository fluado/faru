/**
 * The sync cycle.
 *
 * Two groups, and the difference matters more than the individual assertions.
 *
 *   FEATURE GUARDS  — remote commits arrive, local commits survive, a quiet
 *                     cycle changes nothing. Green before and after any change
 *                     to the sync path. These exist to catch a "fix" that works
 *                     by quietly not syncing any more.
 *
 *   DEFECT PINS     — no markers left in the tree, no unmerged index, no stash
 *                     residue, the file readable throughout, an uncommitted
 *                     local write not destroyed by a colliding remote change.
 *
 * Real git throughout. The behaviours involved — `git stash` exiting 0 with
 * nothing to stash, `git commit` refusing an unmerged index, git unlinking a
 * file before rewriting it — are git's own, and a stub would define them away.
 */

const fs = require("fs");
const { test, expect, afterEach } = require("bun:test");
const { makeRepo, recorder } = require("./helpers/repo");
const { syncWithRemote } = require("../gitsync");

let repo = null;
afterEach(() => {
	if (repo) repo.cleanup();
	repo = null;
});

const SEED = { "state.json": '{"items": ["a"]}\n', "notes/plan.md": "# plan\n" };

/** Another clone pushes a change, the way any other machine or bot would. */
function remotePushes(rel, content, message = "remote edit") {
	const other = repo.clone(`w${Math.floor(performance.now()) % 1000}`);
	other.write(rel, content);
	other.commit(message);
	other.push();
	return other;
}

const hasMarkers = (text) => text.includes("<<<<<<<") && text.includes(">>>>>>>");

// ── feature guards — green before and after ─────────────────────────────────

test("I6 — remote commits actually arrive", async () => {
	repo = makeRepo(SEED);
	remotePushes("notes/plan.md", "# plan, revised\n");

	const result = await syncWithRemote({ repo: repo.root, log: recorder() });

	expect(result.status).toBe("synced");
	expect(result.pulled.length).toBe(1);
	expect(repo.read("notes/plan.md")).toBe("# plan, revised\n");
});

test("I7 — a local commit survives a sync that brings in remote work", async () => {
	repo = makeRepo(SEED);
	repo.write("notes/local.md", "local work\n");
	const localSha = repo.commit("local work");
	remotePushes("notes/plan.md", "# plan, revised\n");

	await syncWithRemote({ repo: repo.root, log: recorder() });

	// Rebased onto the remote, so the SHA moves — the CONTENT must not.
	expect(repo.read("notes/local.md")).toBe("local work\n");
	expect(repo.read("notes/plan.md")).toBe("# plan, revised\n");
	expect(repo.git("log", "--format=%s").split("\n")).toContain("local work");
	expect(localSha).toBeTruthy();
});

test("I8 — a clean tree with no remote change is left alone", async () => {
	repo = makeRepo(SEED);
	const before = repo.head();

	const result = await syncWithRemote({ repo: repo.root, log: recorder() });

	expect(result.status).toBe("unchanged");
	expect(repo.head()).toBe(before);
	expect(repo.status()).toBe("");
	expect(repo.stashList()).toEqual([]);
});

// ── defect pins ─────────────────────────────────────────────────────────────

test("I2 — no conflict markers are left in the working tree after a sync", async () => {
	repo = makeRepo(SEED);
	// The production shape: an uncommitted local write to the same file another
	// machine has just changed.
	repo.write("state.json", '{"items": ["a", "local"]}\n');
	remotePushes("state.json", '{"items": ["a", "remote"]}\n');

	await syncWithRemote({ repo: repo.root, log: recorder() });

	expect(hasMarkers(repo.read("state.json"))).toBe(false);
});

test("I4 — the index is never left unmerged after a sync", async () => {
	repo = makeRepo(SEED);
	repo.write("state.json", '{"items": ["a", "local"]}\n');
	remotePushes("state.json", '{"items": ["a", "remote"]}\n');

	await syncWithRemote({ repo: repo.root, log: recorder() });

	expect(repo.unmerged()).toEqual([]);
});

test("I5 — no stash residue is left behind, or it is reported", async () => {
	repo = makeRepo(SEED);
	repo.write("state.json", '{"items": ["a", "local"]}\n');
	remotePushes("state.json", '{"items": ["a", "remote"]}\n');
	const log = recorder();

	await syncWithRemote({ repo: repo.root, log });

	// A silently retained entry is the dangerous case: it gets replayed onto
	// unrelated content on some later cycle, writing markers into a file that
	// nobody touched in that cycle at all.
	expect(repo.stashList()).toEqual([]);
});

test("I5 — a stale stash entry is never replayed onto a later clean cycle", async () => {
	repo = makeRepo(SEED);
	// `git stash` on a CLEAN tree prints "No local changes to save" and exits 0.
	// Any code that treats a non-throwing stash as "I stashed something" will pop
	// on a cycle where it stashed nothing — and pop whatever was left over.
	repo.write("state.json", '{"items": ["a", "leftover"]}\n');
	repo.git("stash", "--include-untracked");
	expect(repo.stashList().length).toBe(1);
	remotePushes("notes/plan.md", "# unrelated remote change\n");

	await syncWithRemote({ repo: repo.root, log: recorder() });

	// The leftover entry must still be on the stack, unapplied: this cycle had a
	// clean tree and no business touching it.
	expect(repo.stashList().length).toBe(1);
	expect(repo.read("state.json")).toBe('{"items": ["a"]}\n');
});

test("I1 — an uncommitted local write is not destroyed by a colliding remote change", async () => {
	repo = makeRepo(SEED);
	const local = '{"items": ["a", "local"]}\n';
	repo.write("state.json", local);
	remotePushes("state.json", '{"items": ["a", "remote"]}\n');

	await syncWithRemote({ repo: repo.root, log: recorder() });

	// Either the local content is still in the working tree, or it is safely in a
	// local commit. What it must never be is silently gone, or buried under
	// markers that the next auto-commit will push.
	const onDisk = repo.read("state.json");
	const inHistory = repo.git("log", "--all", "-p", "--", "state.json");
	const survived = onDisk.includes('"local"') || inHistory.includes('"local"');

	expect(hasMarkers(onDisk)).toBe(false);
	expect(survived).toBe(true);
});

test("I9 — a retrying reader sees a usable file throughout a sync", async () => {
	repo = makeRepo(SEED);
	repo.write("state.json", '{"items": ["a", "local"]}\n');
	remotePushes("state.json", '{"items": ["a", "remote"]}\n');

	// git does not write working-tree files atomically: it unlinks and rewrites.
	// No change to THIS module can close that window — a rebase has to put the
	// base content on disk before it can replay anything on top of it. What can
	// be closed is the reader's exposure to it, and that is what is asserted
	// here: the same bounded-retry policy the consuming process uses.
	//
	// The backoff must YIELD, not spin. A busy-wait blocks the event loop, which
	// also blocks the git subprocess doing the rewriting — so every attempt lands
	// inside the same frozen instant and the retry buys nothing.
	const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
	const read = async (attempts) => {
		for (let i = 0; i < attempts; i++) {
			try {
				return JSON.parse(await fs.promises.readFile(repo.at("state.json"), "utf-8"));
			} catch (_) {
				if (i === attempts - 1) return null;
				await sleep(20);
			}
		}
		return null;
	};

	let naiveNulls = 0;
	let retryNulls = 0;
	let samples = 0;
	let stop = false;
	const sampling = (async () => {
		while (!stop) {
			samples++;
			if ((await read(1)) === null) naiveNulls++;
			if ((await read(4)) === null) retryNulls++;
			await sleep(1);
		}
	})();

	await syncWithRemote({ repo: repo.root, log: recorder() });
	stop = true;
	await sampling;

	console.log(`      torn/absent reads: naive ${naiveNulls}/${samples}, with 4 attempts ${retryNulls}/${samples}`);
	expect(samples).toBeGreaterThan(0);
	expect(retryNulls).toBe(0);
});

test("window — the working tree barely disagrees with the writer", async () => {
	repo = makeRepo(SEED);
	const local = '{"items": ["a", "local"]}\n';
	repo.write("state.json", local);
	remotePushes("notes/plan.md", "# unrelated remote change\n");

	// Nothing on the remote touches state.json, so every sample that does not
	// show the writer's content is pure exposure.
	//
	// This cannot reach zero here. `git rebase` checks out the base and replays
	// on top, so the tree necessarily passes through older content for as long as
	// that takes. Stashing made the window span the whole network round-trip of
	// the fetch; committing first reduces it to the replay. Removing it entirely
	// is a data-shape question, not a sync question, and is not what this module
	// can answer.
	let staleSamples = 0;
	let samples = 0;
	const sampler = setInterval(() => {
		samples++;
		let text = null;
		try {
			text = fs.readFileSync(repo.at("state.json"), "utf-8");
		} catch (_) {
			staleSamples++; // absent counts as stale: the writer cannot read it either
			return;
		}
		if (text !== local) staleSamples++;
	}, 1);

	await syncWithRemote({ repo: repo.root, log: recorder() });
	clearInterval(sampler);

	const share = staleSamples / samples;
	console.log(`      window: ${staleSamples}/${samples} samples (${(share * 100).toFixed(1)}%) saw a tree the writer did not write`);

	// The stash path scored 100% of samples on this same test. The bound is set
	// well above what commit-then-rebase measures and well below that, so a
	// regression to a whole-tree stash fails here loudly.
	expect(repo.read("state.json")).toBe(local);
	expect(share).toBeLessThan(0.25);
});
