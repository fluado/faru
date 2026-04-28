#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");
const dispatch = require("./dispatch");
const kata = require("./kata");

const DOCS_ROOT = process.cwd();

function loadConfig() {
	const configPath = path.join(DOCS_ROOT, "faru.config.json");
	if (!fs.existsSync(configPath)) {
		console.error(`
  faru — git-native kanban board

  No faru.config.json found in this directory.

  Quick setup: copy the setup prompt from the README into your AI coding agent:
  https://github.com/fluado/faru#setup-prompt

  Or create faru.config.json manually:

  {
    "backlogDir": "./backlog",
    "port": 3333,
    "cardCategories": ["product", "ops", "bug"],
    "autoSync": true,
    "archiveDoneAfterDays": 14
  }
`);
		process.exit(1);
	}
	return JSON.parse(fs.readFileSync(configPath, "utf-8"));
}

const config = loadConfig();
const PORT = config.port;
const BACKLOG_DIR = path.resolve(DOCS_ROOT, config.backlogDir);
const ARCHIVE_DIR = path.join(BACKLOG_DIR, "archive");
const GOAL_FILE = path.join(DOCS_ROOT, "weekly-goal.md");

// --- Agent dispatch (optional) ---
const agentConfig = config.agent || null;
let agentDriver = null;
let agentSkillsDir = null;

if (agentConfig) {
	try {
		agentDriver = require(`./drivers/${agentConfig.driver}`);
		agentSkillsDir = path.resolve(DOCS_ROOT, agentConfig.skills || "./skills");
		log(`🤖 Agent dispatch enabled — driver: ${agentConfig.driver}, skills: ${agentConfig.skills}`);
	} catch (e) {
		console.error(`⚠  Failed to load agent driver "${agentConfig.driver}": ${e.message}`);
		console.error(`   Dispatch feature will be disabled.`);
	}
}

// --- Dojo (kata scheduler, optional) ---
const schedulerConfig = config.scheduler || null;
let kataDir = null;

if (schedulerConfig && schedulerConfig.kataDir) {
	kataDir = path.resolve(DOCS_ROOT, schedulerConfig.kataDir);
	if (!fs.existsSync(kataDir)) {
		fs.mkdirSync(kataDir, { recursive: true });
		log(`📁 Created kata directory: ${schedulerConfig.kataDir}`);
	}
	log(`🥋 Dojo enabled — kata dir: ${schedulerConfig.kataDir}`);
}

function resolveGitUser() {
	try {
		return execFileSync("git", ["config", "user.name"], {
			cwd: DOCS_ROOT,
			encoding: "utf-8",
		}).trim().toLowerCase();
	} catch (_) {
		return "";
	}
}

const gitUser = resolveGitUser();

function log(msg) {
	const ts = new Date().toLocaleTimeString("de-DE", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	console.log(`  [${ts}] ${msg}`);
}

// --- YAML Frontmatter Parser (minimal, no deps) ---

function parseFrontmatter(content) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return { data: {}, body: content };
	const yaml = match[1];
	const body = content.slice(match[0].length).trim();
	const data = {};
	const lines = yaml.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) { i++; continue; }
		const key = line.slice(0, colonIdx).trim();
		let val = line.slice(colonIdx + 1).trim();
		// Check if next lines are list items (YAML list)
		if (val === "" && i + 1 < lines.length && lines[i + 1].match(/^\s+-\s/)) {
			const items = [];
			i++;
			while (i < lines.length && lines[i].match(/^\s+-\s/)) {
				let item = lines[i].replace(/^\s+-\s+/, "").trim();
				if ((item.startsWith('"') && item.endsWith('"')) ||
					(item.startsWith("'") && item.endsWith("'"))) {
					item = item.slice(1, -1);
				}
				items.push(item);
				i++;
			}
			data[key] = items;
			continue;
		}
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		data[key] = val;
		i++;
	}
	return { data, body };
}

function serializeFrontmatter(data, body) {
	const lines = Object.entries(data).map(([k, v]) => {
		if (Array.isArray(v)) {
			if (v.length === 0) return `${k}:`;
			return `${k}:\n${v.map((item) => `  - ${item}`).join("\n")}`;
		}
		if (
			typeof v === "string" &&
			(v.includes(":") || v.includes("#") || v.includes('"'))
		) {
			return `${k}: "${v}"`;
		}
		return `${k}: ${v}`;
	});
	return `---\n${lines.join("\n")}\n---\n\n${body}`;
}

// --- Card Scanner ---

function findCanonicalFile(folderPath) {
	const files = fs.readdirSync(folderPath);
	const milestones = files.find((f) => f.endsWith("-milestones.md"));
	if (milestones) return path.join(folderPath, milestones);
	if (files.includes("CARD.md")) return path.join(folderPath, "CARD.md");
	const spec = files.find((f) => f.endsWith("-spec.md"));
	if (spec) return path.join(folderPath, spec);
	const anyMd = files.find((f) => f.endsWith(".md"));
	if (anyMd) return path.join(folderPath, anyMd);
	return null;
}

function extractGoal(body) {
	// Grab all consecutive blockquote lines as one paragraph
	const lines = body.split("\n");
	const quoteLines = [];
	let started = false;
	for (const line of lines) {
		if (line.startsWith("> ")) {
			started = true;
			quoteLines.push(line.slice(2));
		} else if (started) {
			break;
		}
	}
	if (quoteLines.length === 0) return "";
	return quoteLines.join(" ").replace(/\*\*/g, "").trim();
}

function extractComments(body) {
	const comments = [];
	const idx = body.indexOf("## Comments");
	if (idx === -1) return comments;
	const section = body.slice(idx);
	const lines = section.split("\n");
	const re = /^- \*\*(.+?)\*\* \((.+?)\): (.+)$/;
	for (const line of lines) {
		const m = line.match(re);
		if (m) {
			comments.push({ author: m[1], date: m[2], text: m[3] });
		}
	}
	return comments;
}

function extractMilestones(folderPath, files) {
	const msFile = files.find((f) => f.endsWith("-milestones.md"));
	if (!msFile) return null;

	const prefix = msFile.replace("-milestones.md", "");
	const content = fs.readFileSync(path.join(folderPath, msFile), "utf-8");
	const headingRe = new RegExp(
		`^## ${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+):?\\s+(.+)`,
		"gm",
	);

	const milestones = [];
	let m;
	while ((m = headingRe.exec(content)) !== null) {
		const id = `${prefix}-${m[1]}`;
		milestones.push({
			id,
			title: m[2].trim(),
			done: files.includes(`${id}-report.md`),
		});
	}

	return milestones.length > 0 ? { prefix, milestones, file: msFile } : null;
}

function resolveLinks(links) {
	const resolved = [];
	for (const link of links) {
		const abs = path.resolve(DOCS_ROOT, link);
		// Security: must be within DOCS_ROOT
		if (!abs.startsWith(DOCS_ROOT)) continue;
		if (!fs.existsSync(abs)) continue;
		const stat = fs.statSync(abs);
		if (stat.isDirectory()) {
			const entries = fs.readdirSync(abs)
				.filter((f) => !f.startsWith("."))
				.slice(0, 50);
			resolved.push({
				path: link,
				name: path.basename(link),
				isDir: true,
				children: entries,
			});
		} else {
			resolved.push({
				path: link,
				name: path.basename(link),
				isDir: false,
			});
		}
	}
	return resolved;
}

function scanCards(includeArchive = false) {
	const cards = [];
	const targetDir = includeArchive ? path.join(BACKLOG_DIR, "archive") : BACKLOG_DIR;
	if (!fs.existsSync(targetDir)) return cards;
	const entries = fs.readdirSync(targetDir);

	for (const entry of entries) {
		if (entry === "archive" || entry.startsWith(".")) continue;
		const folderPath = path.join(targetDir, entry);
		if (!fs.statSync(folderPath).isDirectory()) continue;
		if (!/^\d{4}-\d{2}-\d{2}-.+/.test(entry)) continue;

		const canonical = findCanonicalFile(folderPath);
		const allFiles = fs
			.readdirSync(folderPath)
			.filter((f) => f.endsWith(".md"));
		const stat = fs.statSync(folderPath);

		if (canonical) {
			const content = fs.readFileSync(canonical, "utf-8");
			const { data, body } = parseFrontmatter(content);
			const dateMatch = entry.match(/^(\d{4}-\d{2}-\d{2})-(.+)/);
			// Comments live in CARD.md, not necessarily in the canonical (display) file
			const cardMdPath = path.join(folderPath, "CARD.md");
			let comments;
			if (fs.existsSync(cardMdPath) && canonical !== cardMdPath) {
				const cardContent = fs.readFileSync(cardMdPath, "utf-8");
				const { body: cardBody } = parseFrontmatter(cardContent);
				comments = extractComments(cardBody);
			} else {
				comments = extractComments(body);
			}
			cards.push({
				slug: entry,
				title: data.title || (dateMatch ? dateMatch[2] : entry),
				type: data.type || "product",
				status: data.status || "todo",
				assigned: data.assigned || "",
				created: data.created || (dateMatch ? dateMatch[1] : ""),
				edited: data.edited || "",
				canonicalFile: path.basename(canonical),
				files: allFiles,
				linkedFiles: resolveLinks(Array.isArray(data.links) ? data.links : []),
				goal: data.description || extractGoal(body),
				mtime: stat.mtimeMs,
				comments,
				commentCount: comments.length,
				isArchived: !!includeArchive,
				...(() => {
					const ms = extractMilestones(folderPath, allFiles);
					if (!ms) return { milestones: [], milestoneProgress: null };
					const done = ms.milestones.filter((m) => m.done).length;
					return {
						milestones: ms.milestones,
						milestoneProgress: {
							done,
							total: ms.milestones.length,
							prefix: ms.prefix,
						},
					};
				})(),
			});
		} else {
			const dateMatch = entry.match(/^(\d{4}-\d{2}-\d{2})-(.+)/);
			cards.push({
				slug: entry,
				title: dateMatch ? dateMatch[2] : entry,
				type: "product",
				status: "todo",
				assigned: "",
				created: dateMatch ? dateMatch[1] : "",
				canonicalFile: null,
				files: allFiles,
				goal: "",
				mtime: stat.mtimeMs,
			});
		}
	}

	cards.sort((a, b) => b.mtime - a.mtime);
	return cards;
}

// --- Card Mutations ---

function updateCard(slug, updates) {
	const folderPath = path.join(BACKLOG_DIR, slug);
	if (!fs.existsSync(folderPath)) throw new Error("Card not found");
	const canonical = findCanonicalFile(folderPath);
	if (!canonical) throw new Error("No canonical file found");

	const content = fs.readFileSync(canonical, "utf-8");
	const { data, body } = parseFrontmatter(content);
	Object.assign(data, updates);
	data.edited = new Date().toISOString().slice(0, 10);
	
	if (data.status === "done") {
		data.completed = data.completed || data.edited;
	} else if (data.completed !== undefined) {
		delete data.completed;
	}

	fs.writeFileSync(canonical, serializeFrontmatter(data, body), "utf-8");
	return data;
}

function createCard(title, type, assigned, status, description) {
	const today = new Date().toISOString().slice(0, 10);
	const typePart = type.toUpperCase();
	const slugPart = title
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "-")
		.replace(/(^-|-$)/g, "");
	const slug = `${today}-${typePart}-${slugPart}`;
	const folderPath = path.join(BACKLOG_DIR, slug);
	if (fs.existsSync(folderPath)) throw new Error("Card already exists");
	fs.mkdirSync(folderPath, { recursive: true });

	const data = {
		title,
		type: type.toLowerCase(),
		status: status || "todo",
		assigned: assigned || gitUser,
		created: today,
		edited: today,
	};
	if (description) data.description = description;
	
	if (data.status === "done") {
		data.completed = today;
	}

	const body = `# ${title}\n`;
	fs.writeFileSync(
		path.join(folderPath, "CARD.md"),
		serializeFrontmatter(data, body),
		"utf-8",
	);
	return slug;
}

function archiveCard(slug) {
	const src = path.join(BACKLOG_DIR, slug);
	if (!fs.existsSync(src)) throw new Error("Card not found");
	if (!fs.existsSync(ARCHIVE_DIR))
		fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
	fs.renameSync(src, path.join(ARCHIVE_DIR, slug));
}

function autoArchiveSweep() {
	const days = config.archiveDoneAfterDays;
	if (!days) return;
	const cutoff = Date.now() - days * 86400000;
	if (!fs.existsSync(BACKLOG_DIR)) return;
	const archived = [];

	for (const entry of fs.readdirSync(BACKLOG_DIR)) {
		if (entry === "archive" || entry.startsWith(".")) continue;
		const folderPath = path.join(BACKLOG_DIR, entry);
		if (!fs.statSync(folderPath).isDirectory()) continue;

		const canonical = findCanonicalFile(folderPath);
		if (!canonical) continue;

		const content = fs.readFileSync(canonical, "utf-8");
		const { data } = parseFrontmatter(content);
		if (data.status !== "done" || !data.completed) continue;

		const completedMs = new Date(data.completed).getTime();
		
		if (isNaN(completedMs) || completedMs > cutoff) continue;

		try {
			archiveCard(entry);
			archived.push(entry);
			log(`📦 auto-archived: ${entry}`);
		} catch (_) { /* skip */ }
	}

	if (archived.length > 0) {
		const paths = archived.flatMap((s) => [
			`backlog/${s}`,
			`backlog/archive/${s}`,
		]);
		gitCommit(`auto-archive ${archived.length} done card${archived.length === 1 ? "" : "s"}`, paths);
		notifyLiveReload();
	}
}

function addComment(slug, text) {
	const folderPath = path.join(BACKLOG_DIR, slug);
	if (!fs.existsSync(folderPath)) throw new Error("Card not found");
	const cardMd = path.join(folderPath, "CARD.md");
	const target = fs.existsSync(cardMd) ? cardMd : findCanonicalFile(folderPath);
	if (!target) throw new Error("No markdown file found");

	const content = fs.readFileSync(target, "utf-8");
	const now = new Date();
	const date = now.toISOString().slice(0, 10);
	const time = now.toTimeString().slice(0, 5);
	const author = gitUser || "anonymous";
	const line = `- **${author}** (${date} ${time}): ${text}`;

	let updated;
	if (content.includes("## Comments")) {
		updated = content.trimEnd() + "\n" + line + "\n";
	} else {
		updated = content.trimEnd() + "\n\n## Comments\n\n" + line + "\n";
	}
	fs.writeFileSync(target, updated, "utf-8");
	return { author, date: `${date} ${time}`, text };
}

// --- Git Helpers ---

function gitCommit(message, paths) {
	if (!config.autoSync) return;
	try {
		for (const p of paths) {
			execFileSync("git", ["add", p], { cwd: DOCS_ROOT, stdio: "pipe" });
		}
		// Check if there's anything staged
		try {
			execFileSync("git", ["diff", "--cached", "--quiet"], {
				cwd: DOCS_ROOT,
				stdio: "pipe",
			});
			return; // nothing staged
		} catch (_) {
			// diff --cached returns exit 1 if there are staged changes — that's what we want
		}
		execFileSync("git", ["commit", "-m", `board: ${message}`], {
			cwd: DOCS_ROOT,
			stdio: "pipe",
		});
		log(`📝 committed: ${message}`);
		// Push immediately
		execFile("git", ["push"], { cwd: DOCS_ROOT }, (err, _out, stderr) => {
			if (err) {
				log(`⚠  git push failed: ${stderr.trim() || err.message}`);
				return;
			}
			log(`⬆  pushed`);
			// Update SHA so the next poll doesn't trigger a redundant pull
			try {
				lastKnownRemoteSha = execFileSync("git", ["rev-parse", "HEAD"], {
					cwd: DOCS_ROOT,
					encoding: "utf-8",
				}).trim();
			} catch (_) {
				/* best effort */
			}
		});
	} catch (e) {
		log(`⚠  git commit failed: ${e.message}`);
	}
}

// --- HTTP Server ---

function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(data));
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

const MIME = {
	".html": "text/html",
	".css": "text/css",
	".js": "application/javascript",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
};

function serveStatic(res, filePath) {
	if (!fs.existsSync(filePath)) {
		res.writeHead(404);
		res.end("Not found");
		return;
	}
	const ext = path.extname(filePath);
	res.writeHead(200, {
		"Content-Type": MIME[ext] || "application/octet-stream",
	});
	fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, `http://localhost:${PORT}`);

	// --- API Routes ---

	if (url.pathname === "/api/whoami" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ user: gitUser }));
		return;
	}

	if (url.pathname === "/api/config" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				cardCategories: config.cardCategories,
				port: config.port,
				agentEnabled: !!(agentConfig && agentDriver),
				dojoEnabled: !!kataDir,
			}),
		);
		return;
	}

	if (url.pathname === "/api/assignees" && req.method === "GET") {
		const allCards = scanCards();
		const set = new Set();
		if (gitUser) set.add(gitUser);
		for (const c of allCards) {
			if (c.assigned) set.add(c.assigned);
		}
		const assignees = [...set].sort();
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(assignees));
		return;
	}

	// --- Weekly Goal ---

	if (url.pathname === "/api/goal" && req.method === "GET") {
		let text = "";
		if (fs.existsSync(GOAL_FILE)) {
			text = fs.readFileSync(GOAL_FILE, "utf-8").trim();
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ text }));
		return;
	}

	if (url.pathname === "/api/goal" && req.method === "PUT") {
		try {
			const body = await readBody(req);
			const text = (body.text || "").trim();
			fs.writeFileSync(GOAL_FILE, text + "\n", "utf-8");
			gitCommit(`goal: ${text.slice(0, 50)}`, [GOAL_FILE]);
			log(`Goal updated: "${text.slice(0, 60)}"`);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true }));
		} catch (e) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: e.message }));
		}
		return;
	}

	if (url.pathname === "/api/cards" && req.method === "GET") {
		const isArchived = url.searchParams.get("archive") === "1";
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(scanCards(isArchived)));
		return;
	}

	if (url.pathname.match(/^\/api\/cards\/([^/]+)$/) && req.method === "PATCH") {
		const slug = decodeURIComponent(url.pathname.split("/")[3]);
		try {
			const body = await readBody(req);
			const result = updateCard(slug, body);
			if (body.status) {
				gitCommit(`move ${slug} to ${body.status}`, [`backlog/${slug}`]);
			} else if (body.type) {
				gitCommit(`retype ${slug} to ${body.type}`, [`backlog/${slug}`]);
			} else if (body.title) {
				gitCommit(`rename ${slug}`, [`backlog/${slug}`]);
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(result));
		} catch (e) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: e.message }));
		}
		return;
	}

	if (url.pathname === "/api/cards" && req.method === "POST") {
		try {
			const body = await readBody(req);
			const slug = createCard(
				body.title,
				body.type || "ops",
				body.assigned || "",
				body.status,
				body.description,
			);
			gitCommit(`create ${slug} as ${body.status || "todo"}`, [
				`backlog/${slug}`,
			]);
			res.writeHead(201, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ slug }));
		} catch (e) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: e.message }));
		}
		return;
	}

	if (
		url.pathname.match(/^\/api\/cards\/([^/]+)\/archive$/) &&
		req.method === "POST"
	) {
		const slug = decodeURIComponent(url.pathname.split("/")[3]);
		try {
			archiveCard(slug);
			gitCommit(`archive ${slug}`, [
				`backlog/${slug}`,
				`backlog/archive/${slug}`,
			]);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ archived: true }));
		} catch (e) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: e.message }));
		}
		return;
	}

	if (
		url.pathname.match(/^\/api\/cards\/([^/]+)\/comments$/) &&
		req.method === "POST"
	) {
		const slug = decodeURIComponent(url.pathname.split("/")[3]);
		try {
			const body = await readBody(req);
			if (!body.text || !body.text.trim()) throw new Error("Empty comment");
			const comment = addComment(slug, body.text.trim());
			gitCommit(`comment on ${slug}`, [
				`backlog/${slug}`,
			]);
			res.writeHead(201, { "Content-Type": "application/json" });
			res.end(JSON.stringify(comment));
		} catch (e) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: e.message }));
		}
		return;
	}

	if (
		url.pathname.match(/^\/api\/cards\/([^/]+)\/milestones$/) &&
		req.method === "POST"
	) {
		const slug = decodeURIComponent(url.pathname.split("/")[3]);
		try {
			const body = await readBody(req);
			if (!body.title || !body.title.trim())
				throw new Error("Empty milestone title");
			const title = body.title.trim();

			const folderPath = path.join(BACKLOG_DIR, slug);
			if (!fs.existsSync(folderPath)) throw new Error("Card not found");

			const files = fs
				.readdirSync(folderPath)
				.filter((f) => f.endsWith(".md"));
			const msFile = files.find((f) => f.endsWith("-milestones.md"));

			let prefix;
			let msPath;

			if (msFile) {
				prefix = msFile.replace("-milestones.md", "");
				msPath = path.join(folderPath, msFile);
			} else {
				if (!body.prefix || !body.prefix.trim())
					throw new Error("Prefix required for new milestones file");
				prefix = body.prefix.trim().toUpperCase();
				const fileName = `${prefix}-milestones.md`;
				msPath = path.join(folderPath, fileName);

				// Read card frontmatter to seed the milestones file
				const canonical = findCanonicalFile(folderPath);
				let msData = {};
				if (canonical) {
					const content = fs.readFileSync(canonical, "utf-8");
					const { data } = parseFrontmatter(content);
					msData = {
						title: data.title || slug,
						type: data.type || "product",
						status: data.status || "todo",
						assigned: data.assigned || "",
						created: new Date().toISOString().slice(0, 10),
						edited: new Date().toISOString().slice(0, 10),
					};
				}
				const header = serializeFrontmatter(
					msData,
					`# ${prefix} Milestones`,
				);
				fs.writeFileSync(msPath, header, "utf-8");
			}

			// Find the next milestone number
			const content = fs.readFileSync(msPath, "utf-8");
			const headingRe = new RegExp(
				`## ${prefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}-(\\d+)`,
				"g",
			);
			let maxNum = 0;
			let hm;
			while ((hm = headingRe.exec(content)) !== null) {
				const n = parseInt(hm[1], 10);
				if (n > maxNum) maxNum = n;
			}
			const nextId = `${prefix}-${maxNum + 1}`;

			// Append the milestone stub
			const stub = `\n\n---\n\n## ${nextId}: ${title}\n\n> Placeholder — expand with planning.\n`;
			fs.appendFileSync(msPath, stub, "utf-8");

			gitCommit(`add milestone ${nextId} to ${slug}`, [
				`backlog/${slug}`,
			]);
			res.writeHead(201, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ id: nextId, title }));
		} catch (e) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: e.message }));
		}
		return;
	}

	// Open file with default OS app
	if (url.pathname.match(/^\/api\/open$/) && req.method === "POST") {
		try {
			const body = await readBody(req);
			const slug = body.slug;
			const file = body.file;
			const linkedPath = body.linkedPath;

			let target;
			if (body.kataFile && kataDir) {
				// Kata file — relative to kataDir
				target = path.resolve(kataDir, body.kataFile);
				if (!target.startsWith(kataDir)) throw new Error("Path outside kata dir");
				if (!fs.existsSync(target)) throw new Error("Kata file not found");
			} else if (linkedPath) {
				// Linked files are relative to DOCS_ROOT
				target = path.resolve(DOCS_ROOT, linkedPath);
				if (!target.startsWith(DOCS_ROOT)) throw new Error("Path outside root");
				if (!fs.existsSync(target)) throw new Error("Linked path not found");
			} else {
				const folderPath = path.join(BACKLOG_DIR, slug);
				if (!fs.existsSync(folderPath)) throw new Error("Card not found");
				if (file) {
					target = path.join(folderPath, file);
					if (!fs.existsSync(target)) throw new Error("File not found");
				} else {
					const canonical = findCanonicalFile(folderPath);
					target = canonical || folderPath;
				}
			}

			const opener = process.platform === "darwin" ? "open"
				: process.platform === "win32" ? "start"
				: "xdg-open";
			execFile(opener, [target], (err) => {
				if (err) console.error("Failed to open:", err.message);
			});

			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ opened: true, path: path.basename(target) }));
		} catch (e) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: e.message }));
		}
		return;
	}

	// --- Dojo Routes ---

	if (url.pathname === "/api/dojo/kata" && req.method === "GET") {
		if (!kataDir) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("[]");
			return;
		}
		const kataList = kata.scanKata(kataDir);
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(kataList));
		return;
	}

	if (url.pathname === "/api/dojo/kata" && req.method === "POST") {
		if (!kataDir) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Dojo not configured" }));
			return;
		}
		try {
			const body = await readBody(req);
			const name = body.name;
			const schedule = body.schedule;
			const prompt = body.prompt;
			if (!name || !schedule || !prompt) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "name, schedule, and prompt are required" }));
				return;
			}
			const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
			const filePath = path.join(kataDir, `${slug}.md`);
			if (fs.existsSync(filePath)) {
				res.writeHead(409, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Kata already exists" }));
				return;
			}
			const content = `---\nschedule: ${schedule}\n---\n\n${prompt}\n`;
			fs.writeFileSync(filePath, content, "utf-8");
			log(`🥋 Kata created: ${slug}`);
			// Restart scheduler to pick up new kata
			if (agentDriver && agentConfig) {
				kata.startScheduler(kataDir, agentDriver, agentConfig, kataFns);
			}
			res.writeHead(201, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ created: true, id: slug }));
		} catch (e) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: e.message }));
		}
		return;
	}

	if (url.pathname.match(/^\/api\/dojo\/kata\/[^/]+\/run$/) && req.method === "POST") {
		if (!kataDir || !agentDriver || !agentConfig) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Dojo or agent not configured" }));
			return;
		}
		const kataId = decodeURIComponent(url.pathname.split("/")[4]);
		const kataList = kata.scanKata(kataDir);
		const k = kataList.find((x) => x.id === kataId);
		if (!k) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Kata not found" }));
			return;
		}
		res.writeHead(202, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ running: true, kataId }));
		// Fire and forget
		kata.runKata(k, kataDir, agentDriver, agentConfig, kataFns).catch((e) => {
			log(`❌ Kata run failed: ${e.message}`);
		});
		return;
	}

	if (url.pathname === "/api/dojo/sweeps" && req.method === "GET") {
		if (!kataDir) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end("[]");
			return;
		}
		// Return sweeps without content (just metadata for timeline)
		const sweeps = kata.scanSweeps(kataDir).map((s) => ({
			kataId: s.kataId,
			kataTitle: s.kataTitle,
			date: s.date,
			file: s.file,
			summary: s.summary,
		}));
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(sweeps));
		return;
	}

	if (url.pathname.match(/^\/api\/dojo\/sweeps\/[^/]+\/[^/]+$/) && req.method === "GET") {
		if (!kataDir) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Dojo not configured" }));
			return;
		}
		const parts = url.pathname.split("/");
		const kataId = decodeURIComponent(parts[4]);
		const sweepFile = decodeURIComponent(parts[5]);
		const filePath = path.join(kataDir, kataId, sweepFile);
		if (!fs.existsSync(filePath)) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Sweep not found" }));
			return;
		}
		const content = fs.readFileSync(filePath, "utf-8");
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ content }));
		return;
	}

	// --- Agent Dispatch Routes ---

	if (url.pathname === "/api/dispatch/status" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		const s = dispatch.getState();
		res.end(JSON.stringify({
			status: s.status,
			currentCard: s.card?.slug || null,
			currentSkill: s.chain[s.currentIndex]?.skill || null,
			chainIndex: s.currentIndex,
			chainLength: s.chain.length,
			startedAt: s.startedAt,
			log: s.log,
		}));
		return;
	}

	if (url.pathname === "/api/dispatch/skills" && req.method === "GET") {
		const skills = agentSkillsDir ? dispatch.listSkills(agentSkillsDir) : [];
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(skills));
		return;
	}

	if (url.pathname === "/api/dispatch/available" && req.method === "GET") {
		if (!agentDriver || !agentConfig) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ available: false, reason: "not configured" }));
			return;
		}
		try {
			const available = await agentDriver.isAvailable(agentConfig);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ available }));
		} catch (e) {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ available: false, reason: e.message }));
		}
		return;
	}

	if (url.pathname.match(/^\/api\/cards\/[^/]+\/dispatch$/) && req.method === "POST") {
		if (!agentDriver || !agentConfig) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Agent dispatch not configured" }));
			return;
		}
		const ds = dispatch.getState();
		if (ds.status === "running") {
			res.writeHead(409, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "A dispatch is already running", currentCard: ds.card?.slug }));
			return;
		}
		try {
			const slug = decodeURIComponent(url.pathname.split("/")[3]);
			const body = await readBody(req);
			const chain = body.chain;
			if (!chain || !Array.isArray(chain) || chain.length === 0) {
				res.writeHead(400, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "chain is required and must be a non-empty array" }));
				return;
			}

			// Find the card data
			const allCards = scanCards();
			const card = allCards.find(c => c.slug === slug);
			if (!card) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Card not found" }));
				return;
			}

			// Read card body for the prompt
			const folderPath = path.join(BACKLOG_DIR, slug);
			const canonical = findCanonicalFile(folderPath);
			let cardBody = "";
			if (canonical) {
				const content = fs.readFileSync(canonical, "utf-8");
				const parsed = parseFrontmatter(content);
				cardBody = parsed.body;
			}

			const cardData = {
				slug: card.slug,
				title: card.title,
				goal: card.goal,
				type: card.type,
				files: card.files,
				body: cardBody,
			};

			// Respond immediately — dispatch runs async
			res.writeHead(202, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ dispatched: true, slug, chain: chain.map(s => s.skill) }));

			// Fire and forget
			dispatch.runDispatch(cardData, chain, agentDriver, agentConfig, {
				addComment: (s, text, author) => {
					// Write comment with faru-agent author
					const folderP = path.join(BACKLOG_DIR, s);
					if (!fs.existsSync(folderP)) return;
					const cardMd = path.join(folderP, "CARD.md");
					const target = fs.existsSync(cardMd) ? cardMd : findCanonicalFile(folderP);
					if (!target) return;
					const content = fs.readFileSync(target, "utf-8");
					const now = new Date();
					const date = now.toISOString().slice(0, 10);
					const time = now.toTimeString().slice(0, 5);
					const line = `- **${author || "faru-agent"}** (${date} ${time}): ${text}`;
					let updated;
					if (content.includes("## Comments")) {
						updated = content.trimEnd() + "\n" + line + "\n";
					} else {
						updated = content.trimEnd() + "\n\n## Comments\n\n" + line + "\n";
					}
					fs.writeFileSync(target, updated, "utf-8");
				},
				updateCard,
				skillsDir: agentSkillsDir,
				backlogDir: BACKLOG_DIR,
				log,
				notifyReload: () => notifyLiveReload(),
			}).catch(e => {
				log(`❌ Dispatch crashed: ${e.message}`);
			});
		} catch (e) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: e.message }));
		}
		return;
	}

	if (url.pathname === "/api/dispatch/abort" && req.method === "POST") {
		if (!agentDriver) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Agent dispatch not configured" }));
			return;
		}
		const slug = dispatch.abortDispatch();
		if (slug && agentDriver) {
			try { await agentDriver.abort(agentConfig); } catch (_) {}
			try {
				// Write abort comment with faru-agent author
				const folderP = path.join(BACKLOG_DIR, slug);
				if (fs.existsSync(folderP)) {
					const cardMd = path.join(folderP, "CARD.md");
					const target = fs.existsSync(cardMd) ? cardMd : findCanonicalFile(folderP);
					if (target) {
						const content = fs.readFileSync(target, "utf-8");
						const now = new Date();
						const date = now.toISOString().slice(0, 10);
						const time = now.toTimeString().slice(0, 5);
						const line = `- **faru-agent** (${date} ${time}): ⛔ Dispatch aborted by user`;
						let updated;
						if (content.includes("## Comments")) {
							updated = content.trimEnd() + "\n" + line + "\n";
						} else {
							updated = content.trimEnd() + "\n\n## Comments\n\n" + line + "\n";
						}
						fs.writeFileSync(target, updated, "utf-8");
					}
				}
			} catch (_) {}
			notifyLiveReload();
		}
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ aborted: !!slug, slug }));
		return;
	}

	if (url.pathname === "/api/dispatch/suggest" && req.method === "POST") {
		try {
			const body = await readBody(req);
			const skills = agentSkillsDir ? dispatch.listSkills(agentSkillsDir) : [];
			const chain = dispatch.suggestChain(body, skills);
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(chain));
		} catch (e) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: e.message }));
		}
		return;
	}

	// --- SSE Live Reload ---
	if (url.pathname === "/api/live-reload" && req.method === "GET") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write("data: connected\n\n");
		liveClients.add(res);
		req.on("close", () => liveClients.delete(res));
		return;
	}

	// --- Static Files ---
	const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
	serveStatic(res, path.join(__dirname, "public", filePath));
});

const liveClients = new Set();

function notifyLiveReload() {
	for (const client of liveClients) {
		client.write("data: reload\n\n");
	}
}

// Watch public/ for changes (live-reload)
const PUBLIC_DIR = path.join(__dirname, "public");
let debounceTimer = null;
fs.watch(PUBLIC_DIR, { recursive: true }, (eventType, filename) => {
	if (!filename) return;
	clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		log(`♻  ${filename} changed — reloading browsers`);
		notifyLiveReload();
	}, 200);
});

// Watch entire repo for changes (auto-commit + live-reload for backlog)
let repoCommitTimer = null;
let repoReloadTimer = null;
const repoChanges = new Set();
fs.watch(DOCS_ROOT, { recursive: true }, (eventType, filename) => {
	if (
		!filename ||
		filename.includes(".DS_Store") ||
		filename.startsWith(".git") ||
		filename.includes("node_modules") ||
		syncing
	)
		return;
	// Notify browsers when backlog files change (card status edits, etc.)
	if (
		filename.startsWith("backlog" + path.sep) ||
		filename.startsWith("backlog/")
	) {
		clearTimeout(repoReloadTimer);
		repoReloadTimer = setTimeout(() => {
			log(
				`♻  backlog change detected (${path.basename(filename)}) — refreshing boards`,
			);
			notifyLiveReload();
		}, 300);
	}
	repoChanges.add(filename);
	clearTimeout(repoCommitTimer);
	repoCommitTimer = setTimeout(() => {
		const files = [...repoChanges];
		repoChanges.clear();

		// Group by top-level directory
		const byDir = {};
		for (const f of files) {
			const parts = f.split(path.sep);
			const dir = parts[0];
			const rest = parts.slice(1).join(path.sep);
			if (!byDir[dir]) byDir[dir] = [];
			if (rest) byDir[dir].push(rest);
		}

		const dirs = Object.keys(byDir);
		let msg;
		if (dirs.length === 1) {
			const dir = dirs[0];
			const inner = byDir[dir];
			if (inner.length === 0) {
				msg = `update ${dir}`;
			} else if (inner.length <= 2) {
				msg = `${dir}: update ${inner.map((f) => path.basename(f)).join(", ")}`;
			} else {
				msg = `${dir}: update ${inner.length} files`;
			}
		} else {
			msg = `update ${dirs.join(", ")}`;
		}

		gitCommit(msg, ["."]);
	}, 5000); // 5s debounce — lets multi-file saves settle
});

// --- Git Sync: poll remote SHA every 5s, pull only when changed ---
const SYNC_INTERVAL = 5_000; // 5 seconds
let lastKnownRemoteSha = null;
let syncing = false;

function checkRemote() {
	execFile(
		"git",
		["ls-remote", "origin", "HEAD"],
		{ cwd: DOCS_ROOT },
		(err, stdout) => {
			if (err) return; // network blip — skip silently
			const remoteSha = stdout.split(/\s/)[0];
			if (!remoteSha) return;

			// First run — just record the SHA
			if (!lastKnownRemoteSha) {
				lastKnownRemoteSha = remoteSha;
				return;
			}

			if (remoteSha === lastKnownRemoteSha) return; // no change
			lastKnownRemoteSha = remoteSha;

			// Remote changed — pull
			syncing = true;
			const localHead = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: DOCS_ROOT,
				encoding: "utf-8",
			}).trim();
			execFile(
				"git",
				["pull", "--rebase"],
				{ cwd: DOCS_ROOT },
				(pullErr, pullOut, pullStderr) => {
					syncing = false;
					if (pullErr) {
						log(`⚠  git pull failed: ${pullStderr.trim() || pullErr.message}`);
						return;
					}
					// Show what commits came in (from old local HEAD to new HEAD)
					execFile(
						"git",
						["log", `${localHead}..HEAD`, "--oneline", "--reverse"],
						{ cwd: DOCS_ROOT },
						(logErr, logOut) => {
							const msgs = logErr ? "" : logOut.trim();
							if (msgs) {
								log(
									`⬇  synced from remote:\n${msgs
										.split("\n")
										.map((l) => `       ${l}`)
										.join("\n")}`,
								);
							} else {
								log(`⬇  synced from remote`);
							}
						},
					);
					notifyLiveReload();
				},
			);
		},
	);
}

if (config.autoSync) {
	setInterval(checkRemote, SYNC_INTERVAL);

	// Initial push on startup (flush any unpushed local commits)
	execFile("git", ["push"], { cwd: DOCS_ROOT }, (err, _out, stderr) => {
		if (err) {
			log(`⚠  initial push failed: ${stderr.trim() || err.message}`);
			return;
		}
		const result = stderr.trim();
		if (result && !result.includes("Everything up-to-date")) {
			log(`⬆  initial push: ${result}`);
		}
	});
}

const syncLabel = config.autoSync ? 'ON' : 'OFF';
const archiveLabel = config.archiveDoneAfterDays
	? `${config.archiveDoneAfterDays}d`
	: 'OFF';
const dojoLabel = kataDir ? 'ON' : 'OFF';

// Kata functions — shared between cron scheduler and manual run
const kataFns = {
	log,
	notifyReload: notifyLiveReload,
	getDispatchState: dispatch.getState,
};

server.listen(PORT, () => {
	console.log(`\n  ┌──────────────────────────────────────┐`);
	console.log(`  │                                      │`);
	console.log(`  │   faru                               │`);
	console.log(`  │   http://localhost:${PORT}              │`);
	console.log(`  │   live-reload: ON                    │`);
	console.log(`  │   git sync: ${syncLabel.padEnd(25)}│`);
	console.log(`  │   auto-archive: ${archiveLabel.padEnd(19)}│`);
	console.log(`  │   dojo: ${dojoLabel.padEnd(27)}│`);
	console.log(`  │                                      │`);
	console.log(`  └──────────────────────────────────────┘\n`);

	if (config.archiveDoneAfterDays) {
		autoArchiveSweep();
		setInterval(autoArchiveSweep, 12 * 60 * 60 * 1000);
	}

	// Start kata scheduler if dojo and agent are both configured
	if (kataDir && agentDriver && agentConfig) {
		const count = kata.startScheduler(kataDir, agentDriver, agentConfig, kataFns);
		log(`🥋 Dojo scheduler started — ${count} kata scheduled`);
	}
});
