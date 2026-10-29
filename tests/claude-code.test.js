const { test, expect } = require("bun:test");
const fs = require("fs");
const os = require("os");
const path = require("path");
const driver = require("../drivers/claude-code");

test("without a command the driver starts claude from PATH", () => {
	expect(driver.resolveClaudeCommand({})).toBe("claude");
	expect(driver.resolveClaudeCommand({ command: "  " })).toBe("claude");
	expect(driver.resolveClaudeCommand(undefined)).toBe("claude");
});

test("a bare command name stays a PATH lookup", () => {
	expect(driver.resolveClaudeCommand({ command: "claude-sandboxed" })).toBe("claude-sandboxed");
});

test("~/ in the command is the home directory", () => {
	expect(driver.resolveClaudeCommand({ command: "~/.local/bin/claude-sandboxed" })).toBe(
		path.join(os.homedir(), ".local/bin/claude-sandboxed"),
	);
});

test("an absolute command is used as given, a relative one starts at the project root", () => {
	expect(driver.resolveClaudeCommand({ command: "/opt/wrap/claude" })).toBe("/opt/wrap/claude");
	expect(driver.resolveClaudeCommand({ command: "bin/claude-wrap" })).toBe(
		path.resolve(process.cwd(), "bin/claude-wrap"),
	);
});

test("execute starts the configured command and logs which one ran", async () => {
	const wd = fs.mkdtempSync(path.join(os.tmpdir(), "faru-claude-code-"));
	const fake = path.join(wd, "fake-claude");
	// Stands in for claude: records its arguments, drains stdin, answers with
	// one stream-json result event.
	fs.writeFileSync(
		fake,
		[
			"#!/bin/sh",
			'printf "%s\\n" "$@" > "$(dirname "$0")/args.txt"',
			"cat > /dev/null",
			'echo \'{"type":"result","result":"ok","total_cost_usd":0,"num_turns":1}\'',
			"",
		].join("\n"),
	);
	fs.chmodSync(fake, 0o755);

	const config = { command: fake, workdir: wd };
	await driver.newSession(config, { workdir: wd });
	const result = await driver.execute("hello", config);
	driver.releaseWorkspace();

	expect(result.success).toBe(true);
	expect(result.output).toBe("ok");
	const args = fs.readFileSync(path.join(wd, "args.txt"), "utf-8").split("\n");
	expect(args[0]).toBe("-p");
	expect(args).toContain("stream-json");
	const log = JSON.parse(fs.readFileSync(path.join(wd, result.logFile), "utf-8"));
	expect(log.run.command).toBe(fake);

	fs.rmSync(wd, { recursive: true, force: true });
});
