const { test, expect } = require("bun:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { appendDispatchLedger } = require("../ledger");

test("appends one JSON line per call under .faru/dispatches.jsonl", () => {
	const wd = fs.mkdtempSync(path.join(os.tmpdir(), "faru-ledger-"));
	appendDispatchLedger(wd, { a: 1 });
	appendDispatchLedger(wd, { b: 2 });
	const lines = fs.readFileSync(path.join(wd, ".faru", "dispatches.jsonl"), "utf-8").trim().split("\n");
	expect(lines.map((l) => JSON.parse(l))).toEqual([{ a: 1 }, { b: 2 }]);
	fs.rmSync(wd, { recursive: true, force: true });
});
