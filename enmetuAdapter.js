/**
 * Runs @fluado/enmetu inside faru's process when autoSync is on.
 *
 * enmetu is the one automatic git writer: it commits, rebases, pushes and
 * pulls the repository faru serves, and faru only writes files. This module
 * adapts enmetu's library entry to faru's process: operating system signals
 * become stop(), an exit code becomes one log line and, for exit 5 only, a
 * later start; enmetu's own lines go to faru's stdout unchanged.
 *
 * enmetu is ESM and is loaded by a dynamic import from startSync only, so a
 * faru with autoSync off never loads it. faru reads nothing below the package
 * entry except the package.json the package exports.
 */

const path = require("path");

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** A forwarding parent (caffeinate under `make start`, a multiplexer) can deliver a copy of the first signal. */
const SAME_STOP_MS = 500;

const DEFAULT_RETRY_MS = 60000;

/** Strategy map: exit code of a run that ended without stop() -> faru's line and whether it starts again. */
const ENDED = {
	1: { retry: false, line: () => "git sync stopped after an unexpected error (enmetu's line above says which); restart faru to try again" },
	2: { retry: false, line: () => "git sync off: enmetu.config.json is invalid (enmetu's line above says why); fix it, then restart faru" },
	3: { retry: false, line: (cli) => `git sync halted. Why: ${cli("status")}. Once fixed: ${cli("resume")}, then restart faru` },
	4: { retry: false, line: () => "git sync off: another enmetu already syncs this repository" },
	5: { retry: true, line: () => "git sync not started: the repository is not ready (enmetu's line above says why); trying again every minute" },
};

/**
 * Starts enmetu for the repository at root, in this process. Called only when autoSync is on.
 * Never rejects. Installs SIGINT, SIGTERM and SIGHUP handlers only once enmetu has loaded.
 * @param {{
 *   root: string,                        // DOCS_ROOT
 *   log: (line: string) => void,         // faru's log()
 *   out: (text: string) => void,         // where enmetu's own lines go, unchanged
 *   load?: () => Promise<object>,        // default: () => import("@fluado/enmetu")
 *   proc?: { on, exit, versions, execPath },  // default: process
 *   retryMs?: number,                    // default 60000; exit 5 only
 * }} options
 * @returns {Promise<{ stop(): Promise<void> }>}  // the handle the signal handlers use; tests call it
 */
async function startSync({
	root,
	log,
	out,
	load = () => import("@fluado/enmetu"),
	proc = process,
	retryMs = DEFAULT_RETRY_MS,
}) {
	const inert = { stop: async () => {} };

	// 1. Below enmetu's floor the import itself may fail in confusing ways.
	const refusal = runtimeRefusal(proc.versions);
	if (refusal) {
		log(`git sync off: enmetu needs Node 24+ or Bun 1.3.6+ (this is ${refusal})`);
		return inert;
	}

	// 2. A clone whose node_modules predates the dependency has no enmetu.
	let enmetu;
	try {
		enmetu = await load();
	} catch (_) {
		log(`git sync off: @fluado/enmetu is not installed next to faru (${__dirname}); run bun install or npm install there`);
		return inert;
	}

	const pkg = enmetuPackage();
	// A command that runs on this machine without a global install.
	const cli = (cmd) => `${proc.execPath} ${pkg.cli} ${cmd} --repo ${root}`;

	let run = null;
	let retryTimer = null;
	let stopping = null;
	let notReadyLogged = false;

	function stop() {
		if (!stopping) {
			clearTimeout(retryTimer);
			retryTimer = null;
			stopping = run.stop().then(() => {});
		}
		return stopping;
	}

	// 3. Signals become a stop after the running cycle; a second one quits at once.
	let firstSignal = null;
	function onSignal(signal) {
		if (!firstSignal) {
			firstSignal = { signal, at: Date.now() };
			log("stopping git sync after its running cycle; press Ctrl-C again to quit at once");
			stop().then(() => proc.exit(0));
			return;
		}
		if (signal === firstSignal.signal && Date.now() - firstSignal.at <= SAME_STOP_MS) return;
		// enmetu's journal recovers the interrupted cycle at the next start.
		proc.exit(130);
	}
	for (const signal of SIGNALS) proc.on(signal, () => onSignal(signal));

	// 4 and 5. Start, and decide what an end without stop() means.
	function begin() {
		run = launch(enmetu, root, out);
		run.done.then((code) => {
			if (stopping) return;
			const ended = ENDED[code];
			if (!ended) {
				log(`git sync stopped (enmetu exit ${code}); restart faru to try again`);
				return;
			}
			if (!ended.retry || !notReadyLogged) log(ended.line(cli));
			if (!ended.retry) return;
			// Exit 5 is cleared by the next command of a person or agent (a
			// rebase finished, a branch checked out); the others need a person.
			notReadyLogged = true;
			retryTimer = setTimeout(() => {
				retryTimer = null;
				if (!stopping) begin();
			}, retryMs);
		});
	}
	begin();
	log(`git sync: enmetu ${pkg.version} for ${root}`);

	return { stop };
}

/**
 * startEnmetu returns at once and its done never rejects. A throw here means a
 * broken install; it is reported like enmetu reports an unexpected error, so
 * startSync still never rejects.
 */
function launch(enmetu, root, out) {
	try {
		return enmetu.startEnmetu({ repo: root, log: { write: (text) => out(text) } });
	} catch (error) {
		out(`enmetu: ${error && error.message}\n`);
		return { done: Promise.resolve(1), stop: () => Promise.resolve(1) };
	}
}

/** Bun 1.3.6 or newer, else Node 24 or newer; returns the refused runtime, or null. */
function runtimeRefusal(versions) {
	if (versions.bun) return atLeast(versions.bun, [1, 3, 6]) ? null : `Bun ${versions.bun}`;
	return atLeast(versions.node, [24, 0, 0]) ? null : `Node ${versions.node}`;
}

function atLeast(version, minimum) {
	const parts = String(version).split(".").map((part) => parseInt(part, 10) || 0);
	for (let i = 0; i < minimum.length; i++) {
		const part = parts[i] || 0;
		if (part !== minimum[i]) return part > minimum[i];
	}
	return true;
}

/** The installed version and CLI, through the package.json the package exports. */
function enmetuPackage() {
	try {
		const manifest = require.resolve("@fluado/enmetu/package.json");
		return {
			version: require(manifest).version,
			cli: path.join(path.dirname(manifest), "dist", "cli.js"),
		};
	} catch (_) {
		return { version: "unknown", cli: "enmetu" };
	}
}

module.exports = { startSync, ENDED };
