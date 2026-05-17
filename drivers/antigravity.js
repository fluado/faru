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
let pinnedTarget = null; // locked to one workspace for the duration of a chain

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

// Returns the pinned target, or resolves and pins the first matching target
async function getPinnedTarget(port) {
	if (pinnedTarget) {
		// Verify it's still reachable
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
  const chatArea = document.querySelector('#conversation');
  const cancelBtn = chatArea ? chatArea.querySelector('button[aria-label="Cancel"]') : null;
  const stopIcon = chatArea ? chatArea.querySelector("svg.lucide-square, [data-tooltip-id*='cancel']") : null;
  const isGenerating = !!cancelBtn || !!stopIcon;
  const editor = document.querySelector('[aria-label="Message input"][contenteditable="true"]');
  const isInputDisabled = editor ? editor.getAttribute('contenteditable') === 'false' : false;
  const spinnerRoot = chatArea || document;
  const isSpinning = Array.from(spinnerRoot.querySelectorAll('.codicon-loading, .loading, [class*="animate-spin"], [class*="spinner"], [class*="loader"]')).some(el => {
    if (el.offsetParent === null) return false;
    const className = String(el.className || '');
    if (className.includes('h-3') && className.includes('w-3')) return false;
    const p = el.parentElement;
    const parentClassName = String(p?.className || '');
    if (p && (parentClassName.includes('opacity-') || parentClassName.includes('hidden'))) return false;
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
  const hasChat = !!document.querySelector('#conversation');
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
    const editor = document.querySelector('[aria-label="Message input"][contenteditable="true"]');
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
    if (!inserted) {
      editor.textContent = escapedText;
      editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: escapedText }));
    }
    await new Promise(r => setTimeout(r, 150));
    return { found: true, method: 'keyboard' };
  } catch(err) { return { found: false, reason: err.message }; }
})()`,
				awaitPromise: true,
				returnByValue: true,
			});

			const val = res?.result?.value;
			if (val?.found) {
				console.log(`  [cdp] editor found — sending Enter`);
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
				} catch (enterErr) {
					console.log(`  [cdp] ⚠️ Enter keypress failed: ${enterErr.message}`);
				}
				await client.close();
				return;
			}
			if (val) {
				const reason = `${target.title?.substring(0, 25)}: ${val.reason}`;
				console.log(`  [cdp] ⚠️ Editor not found: ${reason}`);
				errors.push(reason);
			}
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
	let pollCount = 0;

	console.log(`  [wait] starting — sentinel: ${sentinelPath || "none"}, timeout: ${Math.round(timeoutMs/60000)}m`);
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
		pollCount++;
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
							if (pollCount % 10 === 1 || idleCount >= 2) {
								console.log(`  [wait] poll #${pollCount} — idle ${idleCount}/3, elapsed ${Math.round((Date.now()-start)/1000)}s`);
							}
							if (idleCount >= 3) {
								// Sentinel expected: only accept idle if sentinel exists
								if (sentinelPath) {
									try {
										if (fs.existsSync(sentinelPath)) return true;
									} catch (_) {}
									// Chat-diff proof: did agent produce any output?
									const currentChat = await getChatText(port);
									if (currentChat && currentChat !== lastChatSnapshot) {
										// Agent produced output but no sentinel — keep polling,
										// it may still be working (e.g. multi-step commit)
										console.log(`  [wait] Agent produced output but sentinel not found — continuing to poll`);
										idleCount = 0;
									} else {
										console.log(`  [wait] ⚠️ Agent idle but no output detected — continuing to poll`);
										idleCount = 0;
									}
								} else {
									// No sentinel expected: accept idle-alone (original ae5dede logic)
									return true;
								}
							}
						} else {
							if (idleCount > 0) {
								console.log(`  [wait] poll #${pollCount} — agent active (was idle ${idleCount}), resetting`);
							}
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

// Helper to grab current chat text for diff comparison
async function getChatText(port) {
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
			if (val && val.length > 0) return val;
		} catch (_) {}
	}
	return null;
}

// Helper to check if the editor element exists
async function editorExists(port) {
	const targets = await resolveTargets(port);
	for (const target of targets) {
		try {
			const client = await CDP({ target: target.webSocketDebuggerUrl });
			const { Runtime } = client;
			await Runtime.enable();
			const r = await Runtime.evaluate({
				expression: `!!document.querySelector('[aria-label="Message input"][contenteditable="true"]')`,
				returnByValue: true,
			});
			await client.close();
			if (r?.result?.value) return true;
		} catch (_) {}
	}
	return false;
}

async function triggerNewChat(port) {
	const target = await getPinnedTarget(port);
	if (!target) return false;

	try {
		const client = await CDP({ target: target.webSocketDebuggerUrl });
		const { Input } = client;

		// Step 1: Cmd+E — focus/open the agent panel
		await Input.dispatchKeyEvent({
			type: "keyDown",
			key: "e",
			code: "KeyE",
			windowsVirtualKeyCode: 69,
			nativeVirtualKeyCode: 69,
			modifiers: 4, // Meta
		});
		await Input.dispatchKeyEvent({
			type: "keyUp",
			key: "e",
			code: "KeyE",
			windowsVirtualKeyCode: 69,
			nativeVirtualKeyCode: 69,
			modifiers: 4,
		});
		await sleep(1000);

		// Step 2: Cmd+Shift+L — new chat
		await Input.dispatchKeyEvent({
			type: "keyDown",
			key: "l",
			code: "KeyL",
			windowsVirtualKeyCode: 76,
			nativeVirtualKeyCode: 76,
			modifiers: 4 | 8, // Meta + Shift
		});
		await Input.dispatchKeyEvent({
			type: "keyUp",
			key: "l",
			code: "KeyL",
			windowsVirtualKeyCode: 76,
			nativeVirtualKeyCode: 76,
			modifiers: 4 | 8,
		});

		await client.close();

		// Step 3: Verify the editor element exists
		await sleep(1500);
		if (await editorExists(port)) return true;

		// Retry once after 2s
		console.log(`  [newChat] Editor not found after Cmd+E/Cmd+Shift+L — retrying in 2s`);
		await sleep(2000);
		if (await editorExists(port)) return true;

		console.log(`  [newChat] ⚠️ Editor still not found after retry`);
		return false;
	} catch (_) {}
	return false;
}

// Map config model IDs to IDE button text substrings
const MODEL_MAP = {
	"opus-4.6": "Opus 4.6",
	"sonnet-4.6": "Sonnet 4.6",
	"gemini-pro-3.1-high": "Gemini 3.1 Pro (High)",
	"gemini-pro-3.1-low": "Gemini 3.1 Pro (Low)",
	"gemini-3-flash": "Gemini 3 Flash",
	"gpt-oss-120b": "GPT-OSS 120B",
};

async function selectModel(port, modelId) {
	if (!modelId) return;
	if (!MODEL_MAP[modelId]) {
		console.log(`  [model] Unknown model ID "${modelId}" — known: ${Object.keys(MODEL_MAP).join(", ")}`);
		return;
	}
	const needle = MODEL_MAP[modelId];

	// Retry loop — the model selector DOM may not be ready right after newSession
	for (let attempt = 0; attempt < 5; attempt++) {
		const retryTarget = await getPinnedTarget(port);
		if (!retryTarget) {
			await sleep(1000);
			continue;
		}

		try {
			const client = await CDP({ target: retryTarget.webSocketDebuggerUrl });
			const { Runtime } = client;
			await Runtime.enable();

			// Check if already selected
			const currentCheck = await Runtime.evaluate({
				expression: `(() => {
  const active = document.querySelector('.flex.min-w-0.max-w-full.cursor-pointer');
  return active ? active.textContent.trim() : '';
})()`,
				returnByValue: true,
			});
			const current = currentCheck.result?.value || "";
			if (current.includes(needle)) {
				await client.close();
				return; // already selected
			}

			// If we couldn't find the selector at all, wait and retry
			if (!current) {
				await client.close();
				await sleep(1000);
				continue;
			}

			// Click the model selector to open dropdown
			await Runtime.evaluate({
				expression: `(() => {
  const selector = document.querySelector('.flex.min-w-0.max-w-full.cursor-pointer');
  if (selector) selector.click();
})()`,
			});
			await sleep(600);

			// Click the target model in the dropdown
			const clickResult = await Runtime.evaluate({
				expression: `(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const target = btns.find(b => b.textContent.includes('${needle}') && b.className.includes('px-2'));
  if (target) { target.click(); return true; }
  return false;
})()`,
				returnByValue: true,
			});
			await sleep(500);

			if (!clickResult.result?.value) {
				// Dropdown opened but model button not found — close dropdown and retry
				await Runtime.evaluate({
					expression: `document.body.click()`,
				});
				await client.close();
				console.log(`  [model] Attempt ${attempt + 1}: dropdown opened but "${needle}" not found — retrying`);
				await sleep(1000);
				continue;
			}

			// Verify the switch actually worked
			const verifyCheck = await Runtime.evaluate({
				expression: `(() => {
  const active = document.querySelector('.flex.min-w-0.max-w-full.cursor-pointer');
  return active ? active.textContent.trim() : '';
})()`,
				returnByValue: true,
			});
			await client.close();

			const after = verifyCheck.result?.value || "";
			if (after.includes(needle)) {
				return; // success
			}
			console.log(`  [model] Attempt ${attempt + 1}: selection did not take effect (active: "${after}")`);
			await sleep(1000);
		} catch (e) {
			console.log(`  [model] Attempt ${attempt + 1} error: ${e.message}`);
			await sleep(1000);
		}
	}
	console.log(`  [model] Failed to select "${needle}" after 5 attempts — proceeding with current model`);
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
  const cancelBtn = document.querySelector('button[aria-label="Cancel"]');
  if (cancelBtn) { cancelBtn.click(); return true; }
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
		console.log(`  [driver] execute() start — sentinel: ${sentinelPath || "none"}, timeout: ${config.timeoutMinutes || 15}m`);
		const preSendSnapshot = lastChatSnapshot;
		await snapshotChatState(port);
		await sendViaCDP(prompt, port);
		console.log(`  [driver] prompt sent via CDP — verifying delivery`);

		// Verify the prompt actually landed in the chat
		await sleep(2000);
		const postSend = await getChatText(port);
		if (postSend && preSendSnapshot && postSend === preSendSnapshot) {
			// Chat didn't change — prompt may not have been delivered. Retry once.
			console.log(`  [driver] ⚠️ chat unchanged after send — retrying once`);
			await sendViaCDP(prompt, port);
			await sleep(2000);
			const retryCheck = await getChatText(port);
			if (retryCheck && retryCheck === preSendSnapshot) {
				console.log(`  [driver] ❌ prompt not visible after retry — aborting`);
				return { success: false, output: "Prompt was not delivered to the agent — chat text unchanged after send + retry" };
			}
		}
		console.log(`  [driver] ✓ prompt delivery confirmed`);

		// Capture baseline for chat-diff comparison during polling
		await snapshotChatState(port);

		// Race: sentinel file vs idle detection vs timeout
		const completed = await waitForCompletion(port, timeout, sentinelPath);
		if (!completed) {
			console.log(`  [driver] ⏱️ waitForCompletion returned false — timeout`);
			await stopAgent(port);
			return { success: false, output: "Timeout — agent did not finish within " + (config.timeoutMinutes || 15) + " minutes" };
		}

		// Kata result honesty: sentinel expected but not found
		const fs = require("fs");
		let sentinelMissing = false;
		if (sentinelPath) {
			try {
				if (fs.existsSync(sentinelPath)) {
					console.log(`  [driver] ✅ sentinel found — cleaning up`);
					fs.unlinkSync(sentinelPath);
				} else {
					console.log(`  [driver] ⚠️ completion declared but sentinel not found`);
					sentinelMissing = true;
				}
			} catch (_) {
				sentinelMissing = true;
			}
		}
		const output = await getLatestResponse(port);
		if (sentinelMissing) {
			return { success: true, output: `⚠️ Sentinel file not found — agent may not have completed the task.\n${output}` };
		}
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
					if (val?.hasChat && val.isIdle) return true;
				} catch (_) {}
			}
		} catch (_) {}
		return false;
	},

	async newSession(config) {
		activeWorkspacePattern = config.workspacePattern || null;
		const started = await triggerNewChat(config.cdpPort);
		if (!started) {
			throw new Error("Unable to open a new agent session in Antigravity via CDP");
		}
		await sleep(3000);
	},

	async setModel(config, modelId) {
		activeWorkspacePattern = config.workspacePattern || null;
		await selectModel(config.cdpPort, modelId);
	},

	async abort(config) {
		pinnedTarget = null;
		return await stopAgent(config.cdpPort);
	},

	// Called by dispatch.js after chain completes (success or failure)
	releaseWorkspace() {
		pinnedTarget = null;
	},
};
