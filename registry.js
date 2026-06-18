/**
 * faru driver registry — multi-driver support.
 *
 * Loads one or more agent drivers and routes requests by context
 * ("dispatch" for board cards, "dojo" for kata tasks).
 *
 * Backward-compatible: if `agent.drivers` is absent, falls back to
 * loading the single `agent.driver` exactly as before.
 *
 * Config shape (.faru.local.json):
 *
 *   {
 *     "agent": {
 *       "driver": "antigravity",
 *       "drivers": {
 *         "antigravity": { "cdpPort": 9333, ... },
 *         "agy": { "workdir": ".", ... }
 *       },
 *       "routing": {
 *         "dojo": "agy"
 *       }
 *     }
 *   }
 */

// ---------------------------------------------------------------------------
// Registry factory
// ---------------------------------------------------------------------------

/**
 * Create a driver registry from the agent config block.
 *
 * @param {object} agentConfig — the `config.agent` object from faru.config.json / .faru.local.json
 * @param {function} log — logging function (server.js log())
 * @returns {{ getDriver, getDriverConfig, getDefaultDriver, getDefaultConfig, allDriverNames }}
 */
function createRegistry(agentConfig, log) {
	const defaultDriverName = agentConfig.driver;
	if (!defaultDriverName) {
		throw new Error("agent.driver is required");
	}

	// Resolve routing table: context → driver name
	const routing = agentConfig.routing || {};
	const driverForContext = {
		dispatch: defaultDriverName,
		dojo: routing.dojo || defaultDriverName,
	};

	// Collect all driver names that need loading
	const driverNames = new Set(Object.values(driverForContext));

	// Load driver modules and build per-driver config
	const drivers = {};       // name → module
	const driverConfigs = {}; // name → merged config

	// Per-driver config blocks (if declared)
	const perDriverBlocks = agentConfig.drivers || {};

	for (const name of driverNames) {
		try {
			drivers[name] = require(`./drivers/${name}`);
		} catch (e) {
			log(`⚠  Failed to load driver "${name}": ${e.message}`);
			continue;
		}

		// Merge: base agentConfig + per-driver overrides.
		// The per-driver block takes precedence for transport-specific fields
		// (cdpPort, workdir, etc.) while inheriting shared fields
		// (timeoutMinutes, verify, commentAuthor, skills, etc.).
		driverConfigs[name] = {
			...agentConfig,
			...(perDriverBlocks[name] || {}),
			driver: name,
		};
	}

	// Validate that the default driver actually loaded
	if (!drivers[defaultDriverName]) {
		throw new Error(
			`Default driver "${defaultDriverName}" failed to load — dispatch will be disabled`
		);
	}

	// Log what we loaded
	const loadedNames = Object.keys(drivers);
	if (loadedNames.length > 1) {
		const routingDesc = Object.entries(driverForContext)
			.map(([ctx, drv]) => `${ctx}→${drv}`)
			.join(", ");
		log(`🤖 Multi-driver enabled: ${loadedNames.join(", ")} (${routingDesc})`);
	} else {
		log(`🤖 Agent dispatch enabled — driver: ${loadedNames[0]}`);
	}

	return {
		/**
		 * Get the driver module for a given context.
		 * @param {"dispatch"|"dojo"} context
		 */
		getDriver(context) {
			const name = driverForContext[context] || defaultDriverName;
			return drivers[name] || drivers[defaultDriverName];
		},

		/**
		 * Get the merged config for a given context.
		 * @param {"dispatch"|"dojo"} context
		 */
		getDriverConfig(context) {
			const name = driverForContext[context] || defaultDriverName;
			return driverConfigs[name] || driverConfigs[defaultDriverName];
		},

		/** Get the default driver module (for availability checks, abort, etc.) */
		getDefaultDriver() {
			return drivers[defaultDriverName];
		},

		/** Get the default driver config. */
		getDefaultConfig() {
			return driverConfigs[defaultDriverName];
		},

		/** All loaded driver names. */
		allDriverNames: loadedNames,

		/** The default driver name. */
		defaultDriverName,

		/** The routing table. */
		routing: driverForContext,
	};
}

module.exports = { createRegistry };
