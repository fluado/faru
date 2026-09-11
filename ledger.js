/**
 * faru dispatch ledger — one JSON line per run in `<workdir>/.faru/dispatches.jsonl`.
 *
 * Shared by the agent drivers and the kata scheduler, so that a kata that was skipped lands in
 * the same file as a kata that ran. Before 2026-09-11 each driver carried its own copy of this
 * function and the scheduler wrote nothing: a skipped morning looked exactly like a crash.
 */

const fs = require("fs");
const path = require("path");

function appendDispatchLedger(workdir, payload) {
	const dir = path.join(workdir, ".faru");
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const fp = path.join(dir, "dispatches.jsonl");
	fs.appendFileSync(fp, JSON.stringify(payload) + "\n", "utf-8");
}

module.exports = { appendDispatchLedger };
