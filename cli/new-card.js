#!/usr/bin/env node
/**
 * faru — headless card creation.
 *
 * Usage:
 *   node cli/new-card.js title="Update landing page copy" type=ops
 *   make new-card title="Update landing page copy" type=ops
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = process.cwd();

// --- Parse args: title="..." type=... ---

const args = {};
for (const arg of process.argv.slice(2)) {
	const eq = arg.indexOf("=");
	if (eq === -1) continue;
	const key = arg.slice(0, eq);
	let val = arg.slice(eq + 1);
	if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
		val = val.slice(1, -1);
	}
	args[key] = val;
}

if (!args.title) {
	console.error('Usage: node cli/new-card.js title="Card title" type=ops');
	process.exit(1);
}

const title = args.title;
const type = args.type || "ops";

// --- Resolve git user ---

function resolveGitUser() {
	try {
		return execFileSync("git", ["config", "user.name"], {
			cwd: ROOT,
			encoding: "utf-8",
		}).trim().toLowerCase();
	} catch (_) {
		return "";
	}
}

// --- Create card ---

const today = new Date().toISOString().slice(0, 10);
const typePart = type.toUpperCase();
const slugPart = title
	.toUpperCase()
	.replace(/[^A-Z0-9]+/g, "-")
	.replace(/(^-|-$)/g, "");
const slug = `${today}-${typePart}-${slugPart}`;

// Load config for backlogDir
let backlogDir = "./backlog";
try {
	const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "faru.config.json"), "utf-8"));
	if (cfg.backlogDir) backlogDir = cfg.backlogDir;
} catch (_) {
	// no config — use default
}

const folderPath = path.resolve(ROOT, backlogDir, slug);
if (fs.existsSync(folderPath)) {
	console.error(`Card already exists: ${slug}`);
	process.exit(1);
}

fs.mkdirSync(folderPath, { recursive: true });

const assigned = resolveGitUser();
const frontmatter = [
	"---",
	`title: ${title}`,
	`type: ${type}`,
	`status: todo`,
	assigned ? `assigned: ${assigned}` : null,
	`created: ${today}`,
	"---",
]
	.filter(Boolean)
	.join("\n");

const content = `${frontmatter}\n\n# ${title}\n`;
fs.writeFileSync(path.join(folderPath, "CARD.md"), content, "utf-8");

console.log(`✔ Created ${slug}`);
