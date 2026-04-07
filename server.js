const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile, execFileSync } = require("child_process");

const PORT = 3333;
const DOCS_ROOT = path.resolve(__dirname, "..");
const BACKLOG_DIR = path.join(DOCS_ROOT, "backlog");
const ARCHIVE_DIR = path.join(BACKLOG_DIR, "archive");

// Map git user.name → board assignee slug
const GIT_USER_MAP = {
	yvg: "yves",
	"Arbo von Monkiewitsch": "arbo",
};

function resolveGitUser() {
	try {
		const raw = execFileSync("git", ["config", "user.name"], {
			cwd: DOCS_ROOT,
			encoding: "utf-8",
		}).trim();
		return GIT_USER_MAP[raw] || raw.toLowerCase();
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
	for (const line of yaml.split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx === -1) continue;
		const key = line.slice(0, colonIdx).trim();
		let val = line.slice(colonIdx + 1).trim();
		if (
			(val.startsWith('"') && val.endsWith('"')) ||
			(val.startsWith("'") && val.endsWith("'"))
		) {
			val = val.slice(1, -1);
		}
		data[key] = val;
	}
	return { data, body };
}

function serializeFrontmatter(data, body) {
	const lines = Object.entries(data).map(([k, v]) => {
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

function scanCards() {
	const cards = [];
	if (!fs.existsSync(BACKLOG_DIR)) return cards;
	const entries = fs.readdirSync(BACKLOG_DIR);

	for (const entry of entries) {
		if (entry === "archive" || entry.startsWith(".")) continue;
		const folderPath = path.join(BACKLOG_DIR, entry);
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
				goal: data.description || extractGoal(body),
				mtime: stat.mtimeMs,
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
		type,
		status: status || "todo",
		assigned: assigned || gitUser,
		created: today,
	};
	if (description) data.description = description;
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

// --- Git Helpers ---

function gitCommit(message, paths) {
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

	if (url.pathname === "/api/cards" && req.method === "GET") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(scanCards()));
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

	// Open file with default OS app
	if (url.pathname.match(/^\/api\/open$/) && req.method === "POST") {
		try {
			const body = await readBody(req);
			const slug = body.slug;
			const file = body.file;
			const folderPath = path.join(BACKLOG_DIR, slug);
			if (!fs.existsSync(folderPath)) throw new Error("Card not found");

			let target;
			if (file) {
				target = path.join(folderPath, file);
				if (!fs.existsSync(target)) throw new Error("File not found");
			} else {
				const canonical = findCanonicalFile(folderPath);
				target = canonical || folderPath;
			}

			execFile("open", [target], (err) => {
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

server.listen(PORT, () => {
	console.log(`\n  ┌──────────────────────────────────────┐`);
	console.log(`  │                                      │`);
	console.log(`  │   faru                               │`);
	console.log(`  │   http://localhost:${PORT}              │`);
	console.log(`  │   live-reload: ON                    │`);
	console.log(`  │   auto-commit: repo-wide (5s)        │`);
	console.log(`  │   git sync: push on commit           │`);
	console.log(`  │   git sync: poll remote (5s)         │`);
	console.log(`  │                                      │`);
	console.log(`  └──────────────────────────────────────┘\n`);
});
