/**
 * The outer net: a pre-commit hook carrying the same two checks as the guard.
 *
 * The guard in gitguard.js covers the daemon's own commits, which is where
 * broken content actually comes from. It cannot cover anyone else committing in
 * the same working tree — a person at a terminal, an agent session the board
 * dispatched, a script added later. None of those is the observed source today,
 * but the number of things with commit access only goes up.
 *
 * Two deliberate differences from the guard:
 *
 *   - The hook inspects STAGED CONTENT (`git show :path`), not the working
 *     tree. That is what is actually about to be committed.
 *   - The hook BLOCKS, because an exit code is the only thing a hook has. That
 *     is acceptable here precisely because it does not run for the daemon's own
 *     commits, which is the path that must never be blocked wholesale.
 *
 * The script is written into the repository rather than pointed at this
 * installation, so it keeps working if faru is moved, reinstalled or removed.
 * It is plain committed content and gets versioned with everything else.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const HOOKS_DIR = ".githooks";

/** Bumped when HOOK_SOURCE changes, so an installed hook is refreshed. */
const HOOK_VERSION = 1;

const HOOK_SOURCE = `#!/usr/bin/env node
// faru pre-commit hook v${HOOK_VERSION} — installed automatically, safe to commit.
//
// Refuses a commit that would record a file carrying conflict markers, or a
// .json file that does not parse. Both are things a failed merge or a torn
// write leaves behind, and both break every consumer that reads the file.
//
// To bypass once:  git commit --no-verify
"use strict";
const { execFileSync } = require("child_process");

const MARKER_START = /^<{7}(?: |\\t|$)/m;
const MARKER_END = /^>{7}(?: |\\t|$)/m;

function staged() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"], {
    encoding: "utf-8",
  });
  return out.split("\\0").filter(Boolean);
}

function stagedContent(file) {
  try {
    return execFileSync("git", ["show", \`:\${file}\`], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  } catch (_) {
    return null;
  }
}

const problems = [];
for (const file of staged()) {
  const content = stagedContent(file);
  if (content === null || content.includes("\\0")) continue;
  if (MARKER_START.test(content) && MARKER_END.test(content)) {
    problems.push(\`\${file}: carries conflict markers\`);
    continue;
  }
  if (file.endsWith(".json")) {
    try {
      JSON.parse(content);
    } catch (e) {
      problems.push(\`\${file}: does not parse as JSON (\${e.message})\`);
    }
  }
}

if (problems.length) {
  console.error("");
  console.error(\`Commit refused — \${problems.length} staged file(s) are not fit to commit:\`);
  for (const p of problems) console.error(\`  \${p}\`);
  console.error("");
  console.error("Resolve the conflict or fix the file, then stage it again.");
  console.error("To commit anyway: git commit --no-verify");
  console.error("");
  process.exit(1);
}
`;

function gitTry(root, args) {
	try {
		return { ok: true, out: execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: "pipe" }).trim() };
	} catch (e) {
		return { ok: false, out: "" };
	}
}

/**
 * Writes the hook and points core.hooksPath at it.
 *
 * Idempotent, and deliberately timid about one thing: if core.hooksPath is
 * already set to something else, that is somebody's deliberate configuration
 * and this leaves it alone. Taking it over would silently disable whatever
 * hooks they were running.
 *
 * Returns { installed, reason }.
 */
function installHooks({ root, log }) {
	const configured = gitTry(root, ["config", "--local", "core.hooksPath"]).out;
	if (configured && configured !== HOOKS_DIR) {
		return { installed: false, reason: `core.hooksPath is already set to ${configured}` };
	}

	const dir = path.join(root, HOOKS_DIR);
	const hookPath = path.join(dir, "pre-commit");

	let existing = null;
	try {
		existing = fs.readFileSync(hookPath, "utf-8");
	} catch (_) {
		/* not installed yet */
	}

	if (existing !== HOOK_SOURCE) {
		try {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(hookPath, HOOK_SOURCE, { mode: 0o755 });
			fs.chmodSync(hookPath, 0o755);
			if (log) log(existing === null ? `🪝 pre-commit hook installed` : `🪝 pre-commit hook updated`);
		} catch (e) {
			return { installed: false, reason: `could not write ${HOOKS_DIR}/pre-commit: ${e.message}` };
		}
	}

	if (configured !== HOOKS_DIR) {
		const set = gitTry(root, ["config", "--local", "core.hooksPath", HOOKS_DIR]);
		if (!set.ok) return { installed: false, reason: "could not set core.hooksPath" };
	}

	return { installed: true, reason: null };
}

module.exports = { installHooks, HOOK_SOURCE, HOOKS_DIR, HOOK_VERSION };
