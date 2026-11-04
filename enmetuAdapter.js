/**
 * Starts enmetu for the repository at root, in this process. Called only when autoSync is on.
 * Never rejects. Installs SIGINT, SIGTERM and SIGHUP handlers only once enmetu has loaded.
 * @returns {Promise<{ stop(): Promise<void> }>}
 */
async function startSync(_options) {
	throw new Error("not implemented");
}

module.exports = { startSync };
