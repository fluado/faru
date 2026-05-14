/**
 * Cursor IDE driver for faru dispatch.
 *
 * Standalone CDP driver for Cursor. Does not share code with the
 * Antigravity driver — each driver owns its own DOM selectors and
 * interaction logic so they can evolve independently.
 */

const CDP = require("chrome-remote-interface");
const http = require("http");

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

let pinnedTarget = null;

function httpGet(url) {
	return new Promise((resolve, reject) => {
		http
			.get(url, (res) => {
				let data = "";
				res.on("data", (chunk) => {
					data += chunk;
				});
				res.on("end", () => resolve(data));
			})
			.on("error", reject);
	});
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

async function resolveTargets(port) {
	const raw = await httpGet(`http://127.0.0.1:${port}/json`);
	const targets = JSON.parse(raw);
	return targets.filter(
		(t) =>
			(t.type === "page" || t.type === "iframe" || t.type === "webview") &&
			t.webSocketDebuggerUrl &&
			!t.url.includes("devtools://"),
	);
}

async function getPinnedTarget(port) {
	if (pinnedTarget) {
		try {
			const client = await CDP({ target: pinnedTarget.webSocketDebuggerUrl });
			await client.close();
			return pinnedTarget;
		} catch (_) {
			pinnedTarget = null;
		}
	}
	const targets = await resolveTargets(port);
	if (targets.length === 0) return null;
	pinnedTarget = targets[0];
	return pinnedTarget;
}

// ---------------------------------------------------------------------------
// DOM expressions (Cursor-specific)
// ---------------------------------------------------------------------------

const CHAT_EXTRACT_EXPR = `
(function() {
  let t = "";
  try {
    const container = document.querySelector('.composer-messages-container');
    if (container) {
      t = container.innerText || container.textContent || "";
    }
    t = t.replace(/Ask anything.*?\\/ for workflows/g, '');
    t = t.replace(/Send\\s*mic/g, '');
    t = t.replace(/Thinking.../g, '');
    t = t.replace(/Thought for \\d+s/gi, '');
    t = t.trim();
  } catch(_) {}
  return String(t);
})()
`;

const IDLE_CHECK_EXPR = `
(function() {
  const hasComposer = !!document.querySelector('.composer-messages-container, .aislash-editor-input, .composer-input-blur-wrapper');
  const stopButton = document.querySelector('button[aria-label*="Stop command" i], .ui-shell-tool-call__glass-stop, .send-with-mode .codicon-debug-stop');
  const isGenerating = !!stopButton;
  const editor = document.querySelector('.composer-input-blur-wrapper .aislash-editor-input[contenteditable="true"], .aislash-editor-input[contenteditable="true"]');
  const isInputDisabled = editor ? (editor.getAttribute('contenteditable') === 'false' || editor.classList.contains('aislash-editor-input-readonly')) : false;
  const isSpinning = Array.from(document.querySelectorAll('.codicon-loading, .loading, [class*="animate-spin"], [class*="spinner"], [class*="loader"]')).some(el => {
    if (el.offsetParent === null) return false;
    const className = String(el.className || '');
    if (className.includes('h-3') && className.includes('w-3')) return false;
    const p = el.parentElement;
    const parentClassName = String(p?.className || '');
    if (p && (parentClassName.includes('opacity-') || parentClassName.includes('hidden'))) return false;
    return true;
  });
  const hasPending = !!document.querySelector('button[aria-label*="Run" i], button[aria-label*="Continue" i], .composer-bar-input-buttons button');
  const isIdle = !isGenerating && !isInputDisabled && !isSpinning && !hasPending;
  return { hasChat: hasComposer, isGenerating, isIdle, isSpinning, hasPending };
})()
`;

// ---------------------------------------------------------------------------
// State for diff-based response extraction
// ---------------------------------------------------------------------------

let lastChatSnapshot = "";

async function snapshotChatState(port) {
	const targets = await resolveTargets(port);
	for (const target of targets) {
		try {
			const client = await CDP({ target: target.webSocketDebuggerUrl });
			const { Runtime } = client;
			await Runtime.enable();
			const r = await Runtime.evaluate({
				expression: CHAT_EXTRACT_EXPR,
				awaitPromise: true,
				returnByValue: true,
			});
			const val = r?.result?.value;
			await client.close();
			if (val && val.length > 0) {
				lastChatSnapshot = val;
				return;
			}
		} catch (_) {}
	}
}

async function getLatestResponse(port) {
	const targets = await resolveTargets(port);
	for (const target of targets) {
		try {
			const client = await CDP({ target: target.webSocketDebuggerUrl });
			const { Runtime } = client;
			await Runtime.enable();
			const r = await Runtime.evaluate({
				expression: CHAT_EXTRACT_EXPR,
				awaitPromise: true,
				returnByValue: true,
			});
			const val = r?.result?.value;
			await client.close();
			if (val && val.length > 0) {
				let diff = val;
				if (lastChatSnapshot && val.includes(lastChatSnapshot)) {
					diff = val
						.substring(
							val.lastIndexOf(lastChatSnapshot) + lastChatSnapshot.length,
						)
						.trim();
				}
				lastChatSnapshot = val;
				return diff || "[No new output]";
			}
		} catch (_) {}
	}
	return "[Failed to extract response]";
}

// ---------------------------------------------------------------------------
// Core actions
// ---------------------------------------------------------------------------

async function sendViaCDP(text, port) {
	const targets = await resolveTargets(port);
	const errors = [];

	for (const target of targets) {
		let client;
		try {
			client = await CDP({ target: target.webSocketDebuggerUrl });
			const { Runtime, Input } = client;
			await Runtime.enable();

			const res = await Runtime.evaluate({
				expression: `
(async function() {
  try {
    const escapedText = ${JSON.stringify(text)};
    const editor = document.querySelector('.composer-input-blur-wrapper .aislash-editor-input[contenteditable="true"], .aislash-editor-input[contenteditable="true"]');
    if (!editor) return { found: false, reason: "no_editor" };
    editor.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    let inserted = false;
    try { inserted = !!document.execCommand("insertText", false, escapedText); } catch(_) {}
    if (!inserted) editor.textContent = escapedText;
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: escapedText }));
    await new Promise(r => setTimeout(r, 150));
    const stopVisible = !!document.querySelector('button[aria-label*="Stop command" i], .ui-shell-tool-call__glass-stop, .send-with-mode .codicon-debug-stop');
    const submit = !stopVisible ? document.querySelector('.send-with-mode button:not([disabled]), .composer-bar-input-buttons button:not([disabled]), button[aria-label*="Send" i]:not([disabled])') : null;
    if (submit) { setTimeout(() => submit.click(), 10); return { found: true, method: 'button' }; }
    setTimeout(() => {
      ['keydown','keypress','keyup'].forEach(type => {
        editor.dispatchEvent(new KeyboardEvent(type, { bubbles:true, key:"Enter", code:"Enter", keyCode:13, which:13 }));
      });
    }, 10);
    return { found: true, method: 'keyboard' };
  } catch(err) { return { found: false, reason: err.message }; }
})()`,
				awaitPromise: true,
				returnByValue: true,
			});

			const val = res?.result?.value;
			if (val?.found) {
				await sleep(50);
				try {
					await Input.dispatchKeyEvent({
						type: "keyDown",
						key: "Enter",
						code: "Enter",
						windowsVirtualKeyCode: 13,
						nativeVirtualKeyCode: 13,
					});
					await Input.dispatchKeyEvent({
						type: "keyUp",
						key: "Enter",
						code: "Enter",
						windowsVirtualKeyCode: 13,
						nativeVirtualKeyCode: 13,
					});
				} catch (_) {}
				await client.close();
				return;
			}
			if (val)
				errors.push(`${target.title?.substring(0, 25)}: ${val.reason}`);
			await client.close();
		} catch (e) {
			if (e.message.includes("Promise was collected")) {
				try {
					if (client) await client.close();
				} catch (_) {}
				return;
			}
			errors.push(`${target.title?.substring(0, 25)}: ${e.message}`);
			try {
				if (client) await client.close();
			} catch (_) {}
		}
	}
	throw new Error(`CDP send failed: ${errors.join(" | ")}`);
}

async function waitForCompletion(port, timeoutMs, sentinelPath) {
	const fs = require("fs");
	const start = Date.now();
	let idleCount = 0;

	await sleep(5000);

	while (Date.now() - start < timeoutMs) {
		if (sentinelPath) {
			try {
				if (fs.existsSync(sentinelPath)) {
					return true;
				}
			} catch (_) {}
		}

		try {
			const targets = await resolveTargets(port);
			for (const target of targets) {
				try {
					const client = await CDP({ target: target.webSocketDebuggerUrl });
					const { Runtime } = client;
					await Runtime.enable();
					const check = await Runtime.evaluate({
						expression: IDLE_CHECK_EXPR,
						returnByValue: true,
					});
					const val = check?.result?.value;
					await client.close();

					if (val?.hasChat) {
						if (val.isIdle && !val.isGenerating) {
							idleCount++;
							if (idleCount >= 3) {
								if (sentinelPath) {
									try {
										if (fs.existsSync(sentinelPath)) return true;
									} catch (_) {}
								}
								return true;
							}
						} else {
							idleCount = 0;
						}
						break;
					}
				} catch (_) {}
			}
		} catch (_) {}

		await sleep(3000);
	}
	return false;
}

async function triggerNewChat(port) {
	const target = await getPinnedTarget(port);
	if (!target) return false;

	try {
		const client = await CDP({ target: target.webSocketDebuggerUrl });
		const { Input, Runtime } = client;
		await Runtime.enable();

		// Attempt 1: Click "New Agent" control in the DOM
		const clickResult = await Runtime.evaluate({
			expression: `(() => {
  const norm = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const isNewAgentControl = (el) => {
    const label = norm(el.getAttribute('aria-label'));
    const title = norm(el.getAttribute('title'));
    const tooltip = norm(el.getAttribute('data-tooltip') || el.getAttribute('data-tooltip-text') || el.getAttribute('data-title'));
    const text = norm(el.textContent);
    const haystack = [label, title, tooltip, text].join(' ');
    return haystack.includes('new agent');
  };
  const candidates = Array.from(document.querySelectorAll('a, button, [role="button"]'))
    .filter(el => el.offsetParent !== null)
    .filter(isNewAgentControl);
  const primary = candidates[0];
  if (!primary) return { clicked: false, reason: 'new-agent-control-not-found' };
  primary.click();
  return { clicked: true };
})()`,
			returnByValue: true,
		});
		if (clickResult?.result?.value?.clicked) {
			await client.close();
			return true;
		}

		// Attempt 2: Command Palette -> "new agent"
		await Input.dispatchKeyEvent({
			type: "keyDown",
			key: "P",
			code: "KeyP",
			windowsVirtualKeyCode: 80,
			nativeVirtualKeyCode: 80,
			modifiers: 4 | 8, // Meta + Shift
		});
		await Input.dispatchKeyEvent({
			type: "keyUp",
			key: "P",
			code: "KeyP",
			windowsVirtualKeyCode: 80,
			nativeVirtualKeyCode: 80,
			modifiers: 4 | 8,
		});
		await sleep(300);
		await Input.insertText({ text: "new agent" });
		await sleep(300);
		await Input.dispatchKeyEvent({
			type: "keyDown",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			nativeVirtualKeyCode: 13,
		});
		await Input.dispatchKeyEvent({
			type: "keyUp",
			key: "Enter",
			code: "Enter",
			windowsVirtualKeyCode: 13,
			nativeVirtualKeyCode: 13,
		});
		await sleep(500);
		const commandPaletteResult = await Runtime.evaluate({
			expression: `(() => {
  return !!document.querySelector('.composer-messages-container, .aislash-editor-input, .composer-input-blur-wrapper');
})()`,
			returnByValue: true,
		});
		if (commandPaletteResult?.result?.value) {
			await client.close();
			return true;
		}

		// Attempt 3: Cmd+N
		await Input.dispatchKeyEvent({
			type: "keyDown",
			key: "n",
			code: "KeyN",
			windowsVirtualKeyCode: 78,
			nativeVirtualKeyCode: 78,
			modifiers: 4, // Meta
		});
		await Input.dispatchKeyEvent({
			type: "keyUp",
			key: "n",
			code: "KeyN",
			windowsVirtualKeyCode: 78,
			nativeVirtualKeyCode: 78,
			modifiers: 4,
		});
		await sleep(500);
		const keyboardResult = await Runtime.evaluate({
			expression: `(() => {
  return !!document.querySelector('.composer-messages-container, .aislash-editor-input, .composer-input-blur-wrapper');
})()`,
			returnByValue: true,
		});
		await client.close();
		return !!keyboardResult?.result?.value;
	} catch (_) {}
	return false;
}

async function stopAgent(port) {
	const targets = await resolveTargets(port);
	for (const target of targets) {
		try {
			const client = await CDP({ target: target.webSocketDebuggerUrl });
			const { Runtime } = client;
			await Runtime.enable();
			const res = await Runtime.evaluate({
				expression: `
(() => {
  const stop = document.querySelector('button[aria-label*="Stop command" i], .ui-shell-tool-call__glass-stop, .send-with-mode .codicon-debug-stop');
  if (stop) { const btn = stop.closest('button') || stop; btn.click(); return true; }
  return false;
})()`,
				returnByValue: true,
			});
			await client.close();
			return res.result?.value || false;
		} catch (_) {}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Driver interface
// ---------------------------------------------------------------------------

module.exports = {
	async execute(prompt, config, sentinelPath) {
		const port = config.cdpPort;
		const timeout = (config.timeoutMinutes || 15) * 60_000;
		await snapshotChatState(port);
		await sendViaCDP(prompt, port);

		const completed = await waitForCompletion(port, timeout, sentinelPath);
		if (!completed) {
			await stopAgent(port);
			return { success: false, output: "Timeout — agent did not finish within " + (config.timeoutMinutes || 15) + " minutes" };
		}
		if (sentinelPath) {
			try { require("fs").unlinkSync(sentinelPath); } catch (_) {}
		}
		const output = await getLatestResponse(port);
		return { success: true, output };
	},

	async isAvailable(config) {
		try {
			const targets = await resolveTargets(config.cdpPort);
			for (const target of targets) {
				try {
					const client = await CDP({ target: target.webSocketDebuggerUrl });
					const { Runtime } = client;
					await Runtime.enable();
					const check = await Runtime.evaluate({
						expression: IDLE_CHECK_EXPR,
						returnByValue: true,
					});
					await client.close();
					const val = check?.result?.value;
					if (val?.hasChat) return true;
				} catch (_) {}
			}
		} catch (_) {}
		return false;
	},

	async newSession(config) {
		const started = await triggerNewChat(config.cdpPort);
		if (!started) {
			throw new Error("Unable to open a new agent session in Cursor via CDP");
		}
		await sleep(3000);
	},

	async setModel(_config, _modelId) {
		// Model selection not implemented for Cursor UI
	},

	async abort(config) {
		pinnedTarget = null;
		return await stopAgent(config.cdpPort);
	},

	releaseWorkspace() {
		pinnedTarget = null;
	},
};
