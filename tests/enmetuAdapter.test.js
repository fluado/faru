/**
 * The adapter between faru's process and an embedded enmetu.
 *
 * No real enmetu and no real signals here: a fake module comes in through
 * `load` and a fake process through `proc`, so every exit code, signal and
 * retry is driven on purpose. The published package is exercised by
 * enmetuAdapter.integration.test.js.
 */

const path = require("path");
const { test, expect } = require("bun:test");
const { recorder } = require("./helpers/repo");
const { startSync } = require("../enmetuAdapter");

const ROOT = "/work/board";
const EXEC = "/opt/bun/bin/bun";
const CLI = path.join(__dirname, "..", "node_modules", "@fluado", "enmetu", "dist", "cli.js");
const RETRY_MS = 10;
const STARTED = `git sync: enmetu 0.1.0 for ${ROOT}`;
const STOPPING = "stopping git sync after its running cycle; press Ctrl-C again to quit at once";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(condition, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await sleep(5);
	}
}

/** A process that records signal handlers and exit codes instead of exiting. */
function fakeProc(versions = { node: "24.3.0", bun: "1.3.6" }) {
	const handlers = new Map();
	const exits = [];
	return {
		versions,
		execPath: EXEC,
		exits,
		on(signal, handler) {
			handlers.set(signal, [...(handlers.get(signal) || []), handler]);
		},
		exit(code) {
			exits.push(code);
		},
		signals: () => [...handlers.keys()].sort(),
		send(signal) {
			for (const handler of handlers.get(signal) || []) handler(signal);
		},
	};
}

/**
 * A fake @fluado/enmetu. Run n ends on its own with endings[n]; once the list
 * runs out, a run keeps going until stop(), which settles it with 0, or, with
 * holdStop, only when the test calls run.settle().
 */
function fakeEnmetu(endings = [], { holdStop = false } = {}) {
	const runs = [];
	const enmetu = {
		startEnmetu(options) {
			let settle;
			const done = new Promise((resolve) => {
				settle = resolve;
			});
			const run = { options, stops: 0, settle };
			runs.push(run);
			const ending = endings[runs.length - 1];
			if (ending !== undefined) settle(ending);
			return {
				done,
				stop() {
					run.stops++;
					if (!holdStop) settle(0);
					return done;
				},
			};
		},
	};
	return { runs, load: async () => enmetu };
}

function start(enmetu, proc, extra = {}) {
	const log = recorder();
	const out = [];
	const handle = startSync({
		root: ROOT,
		log,
		out: (text) => out.push(text),
		load: enmetu.load,
		proc,
		retryMs: RETRY_MS,
		...extra,
	});
	return { log, out, handle };
}

test("Node 22 gets one line, no load and no signal handler", async () => {
	let loads = 0;
	const proc = fakeProc({ node: "22.11.0" });
	const log = recorder();

	await startSync({
		root: ROOT,
		log,
		out: () => {},
		load: async () => {
			loads++;
			return {};
		},
		proc,
		retryMs: RETRY_MS,
	});

	expect(log.lines).toEqual(["git sync off: enmetu needs Node 24+ or Bun 1.3.6+ (this is Node 22.11.0)"]);
	expect(loads).toBe(0);
	expect(proc.signals()).toEqual([]);
});

test("a load that rejects says how to install enmetu and installs no handler", async () => {
	const proc = fakeProc();
	const log = recorder();

	await startSync({
		root: ROOT,
		log,
		out: () => {},
		load: () => Promise.reject(new Error("Cannot find package '@fluado/enmetu'")),
		proc,
		retryMs: RETRY_MS,
	});

	const faruDir = path.join(__dirname, "..");
	expect(log.lines).toEqual([
		`git sync off: @fluado/enmetu is not installed next to faru (${faruDir}); run bun install or npm install there`,
	]);
	expect(proc.signals()).toEqual([]);
});

test("startEnmetu gets the root and a sink that passes enmetu's text on unchanged", async () => {
	const enmetu = fakeEnmetu();
	const proc = fakeProc();
	const { log, out, handle } = start(enmetu, proc);
	const sync = await handle;

	expect(enmetu.runs.length).toBe(1);
	const { options } = enmetu.runs[0];
	expect(Object.keys(options).sort()).toEqual(["log", "repo"]);
	expect(options.repo).toBe(ROOT);
	const line = "2026-11-04T12:00:05.120Z INFO  c2  COMMITTED local changes\n";
	options.log.write(line);
	expect(out).toEqual([line]);
	expect(log.lines).toEqual([STARTED]);
	expect(proc.signals()).toEqual(["SIGHUP", "SIGINT", "SIGTERM"]);

	await sync.stop();
});

test.each([
	[1, "git sync stopped after an unexpected error (enmetu's line above says which); restart faru to try again"],
	[2, "git sync off: enmetu.config.json is invalid (enmetu's line above says why); fix it, then restart faru"],
	[
		3,
		`git sync halted. Why: ${EXEC} ${CLI} status --repo ${ROOT}. Once fixed: ${EXEC} ${CLI} resume --repo ${ROOT}, then restart faru`,
	],
	[4, "git sync off: another enmetu already syncs this repository"],
])("exit %d logs its line and starts no second run", async (code, line) => {
	const enmetu = fakeEnmetu([code]);
	const { log, handle } = start(enmetu, fakeProc());
	await handle;

	await sleep(RETRY_MS * 10);

	expect(enmetu.runs.length).toBe(1);
	expect(log.lines).toEqual([STARTED, line]);
});

test("exit 5 starts again after retryMs and logs one line for two in a row", async () => {
	const enmetu = fakeEnmetu([5, 5]);
	const { log, handle } = start(enmetu, fakeProc());
	const sync = await handle;

	// Two runs that find the repository not ready, then one that keeps running.
	await until(() => enmetu.runs.length === 3);
	await sleep(RETRY_MS * 5);

	expect(enmetu.runs.length).toBe(3);
	expect(log.lines).toEqual([
		STARTED,
		"git sync not started: the repository is not ready (enmetu's line above says why); trying again every minute",
	]);

	await sync.stop();
});

test("a first SIGINT stops the run once and exits 0", async () => {
	const enmetu = fakeEnmetu();
	const proc = fakeProc();
	const { log, handle } = start(enmetu, proc);
	await handle;

	proc.send("SIGINT");
	await until(() => proc.exits.length > 0);

	expect(enmetu.runs[0].stops).toBe(1);
	expect(proc.exits).toEqual([0]);
	// A run that ends because faru stopped it gets no line of its own.
	expect(log.lines).toEqual([STARTED, STOPPING]);
});

test("the same signal again within 500 ms is the same stop", async () => {
	const enmetu = fakeEnmetu([], { holdStop: true });
	const proc = fakeProc();
	const { handle } = start(enmetu, proc);
	await handle;

	// A forwarding parent delivers a copy of the first signal.
	proc.send("SIGINT");
	proc.send("SIGINT");
	await sleep(20);

	expect(enmetu.runs[0].stops).toBe(1);
	expect(proc.exits).toEqual([]);

	enmetu.runs[0].settle(0);
	await until(() => proc.exits.length > 0);
	expect(proc.exits).toEqual([0]);
});

test("a different signal, or the same one after 500 ms, exits 130 at once", async () => {
	const different = fakeEnmetu([], { holdStop: true });
	const procA = fakeProc();
	await start(different, procA).handle;

	procA.send("SIGINT");
	procA.send("SIGTERM");

	expect(procA.exits).toEqual([130]);

	const later = fakeEnmetu([], { holdStop: true });
	const procB = fakeProc();
	await start(later, procB).handle;

	procB.send("SIGINT");
	await sleep(600);
	procB.send("SIGINT");

	expect(procB.exits).toEqual([130]);
	expect(later.runs[0].stops).toBe(1);
});

test("a signal during the retry wait exits 0 without a new start", async () => {
	const enmetu = fakeEnmetu([5]);
	const proc = fakeProc();
	const { handle } = start(enmetu, proc, { retryMs: 200 });
	await handle;
	await sleep(20); // the first run has ended with 5; its retry is pending

	proc.send("SIGTERM");
	await until(() => proc.exits.length > 0);
	await sleep(300); // past the retry that was cleared

	expect(enmetu.runs.length).toBe(1);
	expect(proc.exits).toEqual([0]);
});
