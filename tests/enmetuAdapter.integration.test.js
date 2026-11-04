/**
 * startSync with the published @fluado/enmetu, under Bun, on throwaway
 * repositories. Where fs.watch fails (a sandbox), enmetu falls back to its
 * poll; the 200 ms intervals of the seed keep both paths well inside the
 * deadlines below.
 */

const path = require("path");
const { test, expect, afterEach } = require("bun:test");
const { makeRepo, recorder, git } = require("./helpers/repo");
const { startSync } = require("../enmetuAdapter");

const SUBJECT = "board: local changes";
const LOCKED = "git sync off: another enmetu already syncs this repository";
const SEED = {
	"enmetu.config.json": `${JSON.stringify({ quietMs: 200, pollMs: 200, commitSubject: SUBJECT })}\n`,
};

/** The test runner's own process must keep its signals and must not exit. */
const PROC = { on() {}, exit() {}, versions: process.versions, execPath: process.execPath };

let repo = null;
const handles = [];
afterEach(async () => {
	for (const handle of handles.splice(0)) await handle.stop();
	if (repo) repo.cleanup();
	repo = null;
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * The harness sets core.hooksPath to "" to keep the host's hooks out. git
 * refuses an empty hooks path in `rev-parse --git-path hooks`, which enmetu
 * runs to locate the repository, so this clone's hooks path names a directory
 * that does not exist: still no hooks, and a path git accepts.
 */
function makeClone() {
	const clone = makeRepo(SEED);
	clone.git("config", "core.hooksPath", path.join(clone.tmp, "no-hooks"));
	return clone;
}

async function until(condition, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await sleep(50);
	}
	return false;
}

async function liveness() {
	const { readEnmetuState } = await import("@fluado/enmetu");
	return (await readEnmetuState(repo.root)).liveness;
}

test("a card written on a clone reaches the origin as a board: local changes commit", async () => {
	repo = makeClone();
	const out = [];
	const sync = await startSync({ root: repo.root, log: recorder(), out: (text) => out.push(text), proc: PROC });
	handles.push(sync);

	repo.write("backlog/2026-11-04-OPS-X/CARD.md", "---\ntitle: X\nstatus: todo\n---\n\n# X\n");
	const newest = () => git(repo.originPath, ["log", "-1", "--format=%s"]).trim();
	const arrived = await until(() => newest() === SUBJECT, 15000);
	if (!arrived) console.log(out.join(""));

	expect(arrived).toBe(true);
	await sync.stop();
	expect(await liveness()).toBe("stopped");
}, 30000);

test("a second startSync on the same clone logs the exit-4 line and does not retry", async () => {
	repo = makeClone();
	const first = await startSync({ root: repo.root, log: recorder(), out: () => {}, proc: PROC });
	handles.push(first);
	expect(await until(async () => ["running", "unrecorded"].includes(await liveness()), 15000)).toBe(true);

	let starts = 0;
	const log = recorder();
	const second = await startSync({
		root: repo.root,
		log,
		out: () => {},
		proc: PROC,
		retryMs: 10,
		load: async () => {
			const enmetu = await import("@fluado/enmetu");
			return {
				startEnmetu: (options) => {
					starts++;
					return enmetu.startEnmetu(options);
				},
			};
		},
	});
	handles.push(second);

	expect(await until(() => log.lines.includes(LOCKED), 15000)).toBe(true);
	await sleep(300); // 30 retry intervals
	expect(starts).toBe(1);
}, 30000);
