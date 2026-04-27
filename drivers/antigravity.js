/**
 * Antigravity IDE driver for faru dispatch.
 *
 * Communicates with Antigravity IDE via Chrome DevTools Protocol (CDP).
 * The IDE must be launched with --remote-debugging-port=<port>.
 *
 * Core CDP functions adapted from antigravity-telegram-suite/src/cdp_controller.js
 * (MIT — Emre Türkmen / https://github.com/emreturkmencom/antigravity-telegram-suite)
 */

const CDP = require("chrome-remote-interface");
const http = require("http");

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

let activeWorkspacePattern = null;

function httpGet(url) {
	return new Promise((resolve, reject) => {
		http
			.get(url, (res) => {
				let data = "";
				res.on("data", (chunk) => (data += chunk));
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
	let filtered = targets.filter(
		(t) =>
			(t.type === "page" || t.type === "iframe" || t.type === "webview") &&
			t.webSocketDebuggerUrl &&
			!t.url.includes("devtools://"),
	);

	// If a workspace pattern is set, prefer matching targets
	if (activeWorkspacePattern) {
		const pat = activeWorkspacePattern.toLowerCase();
		const matching = filtered.filter((t) =>
			t.title.toLowerCase().includes(pat),
		);
		if (matching.length > 0) {
			filtered = matching;
		}
	}

	return filtered.sort((a, b) => {
		const aM = a.title.toLowerCase().includes("antigravity") ? 1 : 0;
		const bM = b.title.toLowerCase().includes("antigravity") ? 1 : 0;
		return bM - aM;
	});
}

// DOM expression to extract visible chat text
const CHAT_EXTRACT_EXPR = `
(function() {
  let t = "";
  try {
    const c = document.querySelector('.flex.w-full.grow.flex-col.overflow-hidden, #conversation, #chat, .interactive-session');
    if (c) {
      const btns = Array.from(c.querySelectorAll('button')).filter(b => b.innerText && b.innerText.includes('Thought for'));
      const hidden = [];
      btns.forEach(b => { if (b.parentElement) { hidden.push({ el: b.parentElement, d: b.parentElement.style.display }); b.parentElement.style.setProperty('display','none','important'); }});
      t = c.innerText || c.textContent || "";
      hidden.forEach(h => { h.el.style.display = h.d; });
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

// DOM expression to check if the agent is idle
const IDLE_CHECK_EXPR = `
(function() {
  const chatArea = document.querySelector('#conversation, #chat, #cascade');
  const stopIcon = chatArea ? chatArea.querySelector("svg.lucide-square, [data-tooltip-id*='cancel']") : null;
  const isGenerating = !!stopIcon;
  const editor = document.querySelector('[contenteditable="true"], textarea');
  const isInputDisabled = editor ? (editor.getAttribute('contenteditable') === 'false' || editor.disabled) : false;
  const isSpinning = Array.from(document.querySelectorAll('.codicon-loading, .loading, [class*="animate-spin"], [class*="spinner"], [class*="loader"]')).some(el => {
    if (el.offsetParent === null) return false;
    if (el.className.includes('h-3') && el.className.includes('w-3')) return false;
    const p = el.parentElement;
    if (p && (p.className.includes('opacity-') || p.className.includes('hidden'))) return false;
    return true;
  });
  const aaActive = !!window.__AA_BOT_OBSERVER_ACTIVE && !window.__AA_BOT_PAUSED;
  let hasPending = false;
  if (aaActive) {
    const texts = ['run','accept','allow','continue','retry'];
    const btns = Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null);
    hasPending = btns.some(b => { const x = (b.textContent||'').trim().toLowerCase(); return texts.some(t => x === t || x.startsWith(t + ' ')); });
  }
  const isIdle = !isGenerating && !isInputDisabled && !isSpinning && !hasPending;
  const hasChat = !!document.querySelector('#conversation, #chat, #cascade, .chat-input, .interactive-input-editor');
  return { hasChat, isGenerating, isIdle, isSpinning, hasPending };
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
    const editors = [...document.querySelectorAll('.interactive-input-editor textarea, #conversation textarea, #chat textarea, .chat-input textarea, [aria-label*="chat input" i] textarea, [contenteditable="true"]')]
      .filter(el => !el.className.includes('xterm'));
    const editor = editors.at(-1);
    if (!editor) return { found: false, reason: "no_editor" };
    editor.focus();
    try { document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); } catch(_) {}
    let inserted = false;
    try { inserted = !!document.execCommand("insertText", false, escapedText); } catch(_) {}
    if (!inserted) {
      if (editor.tagName === 'TEXTAREA') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(editor, escapedText); else editor.value = escapedText;
      } else { editor.textContent = escapedText; }
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: escapedText }));
    }
    await new Promise(r => setTimeout(r, 150));
    const submit = document.querySelector("svg.lucide-arrow-right, svg[class*='arrow-right'], svg[class*='send']")?.closest("button");
    if (submit && !submit.disabled) { setTimeout(() => submit.click(), 10); return { found: true, method: 'button' }; }
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
			if (val && val.found) {
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

async function waitForIdle(port, timeoutMs) {
	const start = Date.now();
	let idleCount = 0;

	while (Date.now() - start < timeoutMs) {
		let targets;
		try {
			targets = await resolveTargets(port);
		} catch (_) {
			await sleep(3000);
			continue;
		}

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

				if (val && val.hasChat) {
					if (val.isIdle && !val.isGenerating) {
						idleCount++;
						if (idleCount >= 4) return true;
					} else {
						idleCount = 0;
					}
					break;
				}
			} catch (_) {}
		}

		await sleep(2000);
	}
	return false;
}

async function waitForCompletion(port, timeoutMs, sentinelPath) {
	const fs = require("fs");
	const start = Date.now();

	// Give the agent a few seconds to start working before polling
	await sleep(5000);

	while (Date.now() - start < timeoutMs) {
		// Primary: check for sentinel file
		if (sentinelPath) {
			try {
				if (fs.existsSync(sentinelPath)) {
					return true;
				}
			} catch (_) {}
		}

		// Fallback: check if agent is idle via UI
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

					if (val && val.hasChat && val.isIdle && !val.isGenerating) {
						// Double-check sentinel before trusting idle (agent may still be writing)
						await sleep(2000);
						if (sentinelPath) {
							try {
								if (fs.existsSync(sentinelPath)) return true;
							} catch (_) {}
						}
					}
				} catch (_) {}
			}
		} catch (_) {}

		await sleep(3000);
	}
	return false;
}

async function triggerNewChat(port) {
	const targets = await resolveTargets(port);
	for (const target of targets) {
		try {
			const client = await CDP({ target: target.webSocketDebuggerUrl });
			const { Input, Runtime } = client;
			await Runtime.enable();

			// Method 1: Try Cmd+E (Open Agent Manager → new conversation)
			try {
				await Input.dispatchKeyEvent({
					type: "keyDown",
					key: "e",
					code: "KeyE",
					windowsVirtualKeyCode: 69,
					nativeVirtualKeyCode: 69,
					modifiers: 4, // Meta (Cmd on Mac)
				});
				await Input.dispatchKeyEvent({
					type: "keyUp",
					key: "e",
					code: "KeyE",
					windowsVirtualKeyCode: 69,
					nativeVirtualKeyCode: 69,
					modifiers: 4,
				});
				await sleep(1500);
			} catch (_) {}

			// Method 2: Also try clicking any "New Chat" / "+" button as fallback
			const res = await Runtime.evaluate({
				expression: `
(() => {
  const btn = document.querySelector('[aria-label*="New Chat" i], [title*="New Chat" i], [class*="new-chat"]');
  if (btn) { btn.click(); return "button"; }
  return "keyboard";
})()`,
				returnByValue: true,
			});

			await client.close();
			return true;
		} catch (_) {}
	}
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
  const stopIcon = document.querySelector("svg.lucide-square, [data-tooltip-id*='cancel'], [aria-label*='Stop'], [title*='Stop']");
  if (stopIcon) { const btn = stopIcon.closest('button') || stopIcon; btn.click(); return true; }
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
		activeWorkspacePattern = config.workspacePattern || null;
		await snapshotChatState(port);
		await sendViaCDP(prompt, port);

		// Race: sentinel file vs idle detection vs timeout
		const completed = await waitForCompletion(port, timeout, sentinelPath);
		if (!completed) {
			await stopAgent(port);
			return { success: false, output: "Timeout — agent did not finish within " + (config.timeoutMinutes || 15) + " minutes" };
		}
		// Clean up sentinel
		if (sentinelPath) {
			try { require("fs").unlinkSync(sentinelPath); } catch (_) {}
		}
		const output = await getLatestResponse(port);
		return { success: true, output };
	},

	async isAvailable(config) {
		activeWorkspacePattern = config.workspacePattern || null;
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
					if (val && val.hasChat && val.isIdle) return true;
				} catch (_) {}
			}
		} catch (_) {}
		return false;
	},

	async newSession(config) {
		activeWorkspacePattern = config.workspacePattern || null;
		await triggerNewChat(config.cdpPort);
		await sleep(2000);
	},

	async abort(config) {
		return await stopAgent(config.cdpPort);
	},
};
