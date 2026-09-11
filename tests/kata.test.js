const { test, expect } = require("bun:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const kata = require("../kata");

function fakeDriver(delayMs) {
	const d = {
		runs: 0,
		async newSession() {},
		async execute() {
			d.runs++;
			await new Promise((r) => setTimeout(r, delayMs));
			return { success: true, output: "ok" };
		},
	};
	return d;
}

const fns = () => ({
	log() {},
	notifyReload() {},
	getDispatchState() { return { status: "idle" }; },
	// Longer than the fake run, so the retry finds the scheduler idle — as the 10-minute
	// production delay does after a kata that takes a few minutes.
	retryDelayMs: 150,
});

test("a kata skipped for a running kata lands in the ledger and is retried exactly once", async () => {
	const wd = fs.mkdtempSync(path.join(os.tmpdir(), "faru-kata-"));
	const kataDir = path.join(wd, "kata");
	fs.mkdirSync(kataDir);
	const k = { id: "lead-scout", title: "Lead Scout", body: "do the thing", model: null };
	const cfg = { workdir: wd };
	const f = fns();

	const driver = fakeDriver(80);
	const first = kata.runKata(k, kataDir, driver, cfg, f);
	const second = await kata.runKata(k, kataDir, driver, cfg, f);
	expect(second.success).toBe(false);
	expect(second.reason).toBe("kata-running");
	const r1 = await first;
	expect(r1.success).toBe(true);
	await new Promise((r) => setTimeout(r, 400));
	expect(driver.runs).toBe(2);

	const rows = fs.readFileSync(path.join(wd, ".faru", "dispatches.jsonl"), "utf-8")
		.trim().split("\n").map((l) => JSON.parse(l));
	const skipped = rows.filter((r) => r.errorType === "skipped");
	expect(skipped.length).toBe(1);
	expect(skipped[0].kata).toBe("lead-scout");
	expect(skipped[0].error).toBe("kata-running");
	expect(skipped[0].retryScheduled).toBe(true);
	fs.rmSync(wd, { recursive: true, force: true });
});

test("the driver receives the kata id in its config", async () => {
	const wd = fs.mkdtempSync(path.join(os.tmpdir(), "faru-kata-"));
	const kataDir = path.join(wd, "kata");
	fs.mkdirSync(kataDir);
	let seen = null;
	const driver = { async newSession() {}, async execute(_p, config) { seen = config.__kataId; return { success: true, output: "" }; } };
	await kata.runKata({ id: "seo-growth", title: "Seo Growth", body: "x", model: null }, kataDir, driver, { workdir: wd }, fns());
	expect(seen).toBe("seo-growth");
	fs.rmSync(wd, { recursive: true, force: true });
});
