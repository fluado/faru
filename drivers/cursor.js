/**
 * Cursor IDE driver for faru dispatch.
 *
 * Reuses the CDP implementation from the Antigravity driver, but applies
 * Cursor-friendly defaults so faru can be configured with "driver": "cursor".
 */

const antigravityDriver = require("./antigravity");

function withCursorDefaults(config) {
	const base = config || {};
	// Cursor window titles are often document/workspace-based, so a strict
	// workspace pattern can accidentally filter out the active target.
	return {
		...base,
		workspacePattern: base.workspacePattern || null,
	};
}

module.exports = {
	async execute(prompt, config, sentinelPath) {
		return antigravityDriver.execute(
			prompt,
			withCursorDefaults(config),
			sentinelPath,
		);
	},

	async isAvailable(config) {
		return antigravityDriver.isAvailable(withCursorDefaults(config));
	},

	async newSession(config) {
		await antigravityDriver.newSession(withCursorDefaults(config));
	},

	async setModel(config, modelId) {
		await antigravityDriver.setModel(withCursorDefaults(config), modelId);
	},

	async abort(config) {
		return antigravityDriver.abort(withCursorDefaults(config));
	},

	releaseWorkspace() {
		if (typeof antigravityDriver.releaseWorkspace === "function") {
			antigravityDriver.releaseWorkspace();
		}
	},
};
