/**
 * The subjects of enmetu's commits on a board, written by faru.
 *
 * enmetu asks faru for each commit it makes (its library option
 * commitMessage). faru answers what the board makes certain, without a model:
 * a card moved or assigned, cards archived, files added or removed. A plain
 * edit goes to the person's own commitMessageCommand when they set one in git
 * config, and otherwise reads "Update <title>". Titles come from the
 * documents: a card's frontmatter title, a markdown file's title or first
 * heading, an HTML file's <title>, else the file name made readable.
 *
 * Returning null leaves the subject to enmetu (commitSubject); faru does that
 * only when git cannot say what changed.
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

/** Titles longer than this are cut at their first separator; none is ever longer than TITLE_MAX. */
const TITLE_SPLIT_AT = 50;
const TITLE_MAX = 60;

/** The first 64 KiB of a document hold its frontmatter, heading or <title>. */
const READ_MAX = 65536;

/** Async, so a commit never blocks the board's HTTP server on git. Resolves null when git fails. */
function git(cwd, args) {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout) =>
			resolve(err ? null : stdout),
		);
	});
}

/**
 * The subject of the commit from parent to tree, for enmetu's commitMessage.
 * @param {{ root: string, parent: string, tree: string, runCommand: () => Promise<string|null> }} change
 * @param {{ backlogDir: string }} board  // absolute, as server.js resolves it
 * @returns {Promise<string|null>}
 */
async function boardCommitMessage({ root, parent, tree, runCommand }, { backlogDir }) {
	const board = boardPath(root, backlogDir);
	const changes = await changesOf(root, parent, tree);
	if (!changes || changes.length === 0) return null;
	const units = unitsOf(changes, board);

	// 1. Cards archived, nothing else: a plain move into <board>/archive.
	if (changes.every((c) => c.status === "R" && archiveMove(c, board))) {
		return `Archive ${await titleOf(units, root, parent, tree, board)}`;
	}

	// 2. A card's status or assignee, read from both sides of its CARD.md.
	const fields = await cardFieldChanges(changes, root, parent, tree, board);
	const moved = fields.filter((f) => f.status !== null);
	if (moved.length > 0) {
		return `Move ${moved[0].title} to ${moved[0].status}${more(moved.length - 1)}`;
	}
	const assigned = fields.filter((f) => f.assigned !== null);
	if (assigned.length > 0) {
		return `Assign ${assigned[0].title} to ${assigned[0].assigned}${more(assigned.length - 1)}`;
	}

	// 3. Only added or only removed files.
	if (changes.every((c) => c.status === "A")) return `Add ${await titleOf(units, root, parent, tree, board)}`;
	if (changes.every((c) => c.status === "D")) return `Remove ${await titleOf(units, root, parent, tree, board)}`;

	// 4. An edit: the person's command, else the title.
	const written = await runCommand();
	if (written) return written;
	return `Update ${await titleOf(units, root, parent, tree, board)}`;
}

/**
 * `git diff-tree -r -z -M` from parent to tree: status letter, path, the
 * source path of a rename, and the lines changed (numstat), largest first.
 */
async function changesOf(root, parent, tree) {
	const [names, numbers] = await Promise.all([
		git(root, ["diff-tree", "-r", "-z", "-M", "--name-status", parent, tree]),
		git(root, ["diff-tree", "-r", "-z", "-M", "--numstat", parent, tree]),
	]);
	if (names === null || numbers === null) return null;

	const changes = [];
	const fields = names.split("\0");
	for (let i = 0; i + 1 < fields.length; ) {
		const status = fields[i].charAt(0);
		if (status === "R" || status === "C") {
			changes.push({ status, from: fields[i + 1], path: fields[i + 2], size: 0 });
			i += 3;
		} else {
			changes.push({ status, from: null, path: fields[i + 1], size: 0 });
			i += 2;
		}
	}

	// numstat -z: "<added>\t<deleted>\t<path>\0", or "<added>\t<deleted>\t\0<from>\0<to>\0" for a rename.
	const sizes = new Map();
	const parts = numbers.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const match = parts[i].match(/^(-|\d+)\t(-|\d+)\t(.*)$/);
		if (!match) continue;
		const size = (parseInt(match[1], 10) || 0) + (parseInt(match[2], 10) || 0);
		if (match[3] === "") {
			sizes.set(parts[i + 2], size);
			i += 2;
		} else {
			sizes.set(match[3], size);
		}
	}
	for (const change of changes) change.size = sizes.get(change.path) || 0;
	return changes.sort((a, b) => b.size - a.size);
}

/**
 * The backlog folder as git names it inside the repository. enmetu hands over
 * the root as git resolved it, faru knows the backlog through the folder it
 * was started in, and the two can differ by a symbolic link (/tmp and
 * /private/tmp on macOS), so both are resolved first.
 */
function boardPath(root, backlogDir) {
	return path.relative(realPath(root), realPath(backlogDir)).split(path.sep).join("/");
}

/** fs.realpathSync, also for a folder that does not exist yet (a board before its first card). */
function realPath(dir) {
	try {
		return fs.realpathSync(dir);
	} catch (_) {
		const parent = path.dirname(dir);
		return parent === dir ? dir : path.join(realPath(parent), path.basename(dir));
	}
}

/** The card a board path belongs to: its slug and whether it is archived; null outside a card. */
function cardOf(file, board) {
	if (!file || !file.startsWith(`${board}/`)) return null;
	const parts = file.slice(board.length + 1).split("/");
	if (parts[0] === "archive") {
		return parts.length >= 3 && !parts[1].startsWith(".") ? { slug: parts[1], archived: true } : null;
	}
	return parts.length >= 2 && !parts[0].startsWith(".") ? { slug: parts[0], archived: false } : null;
}

function archiveMove(change, board) {
	const from = cardOf(change.from, board);
	const to = cardOf(change.path, board);
	return from && to && !from.archived && to.archived && from.slug === to.slug;
}

/** What the subject names: one entry per card, one per file outside cards, largest change first. */
function unitsOf(changes, board) {
	const units = [];
	const seen = new Set();
	for (const change of changes) {
		const card = cardOf(change.path, board) || cardOf(change.from, board);
		const key = card ? `card:${card.slug}` : `file:${change.path}`;
		if (seen.has(key)) continue;
		seen.add(key);
		units.push({ card, change });
	}
	return units;
}

/** The largest unit's title, and how many more there are. */
async function titleOf(units, root, parent, tree, board) {
	const [first] = units;
	const title = first.card
		? await cardTitle(first.card.slug, root, parent, tree, board)
		: await fileTitle(first.change, root, parent, tree);
	return `${title}${more(units.length - 1)}`;
}

function more(count) {
	return count > 0 ? ` and ${count} more` : "";
}

/**
 * Status and assignee changes of the cards whose CARD.md changed, read from
 * both sides; a field that did not change is null.
 */
async function cardFieldChanges(changes, root, parent, tree, board) {
	const found = [];
	for (const change of changes) {
		if (change.status !== "M" && change.status !== "R") continue;
		const card = cardOf(change.path, board);
		if (!card || path.posix.basename(change.path) !== "CARD.md") continue;
		const [before, after] = await Promise.all([
			show(root, parent, change.from || change.path),
			show(root, tree, change.path),
		]);
		if (before === null || after === null) continue;
		const old = frontmatter(before);
		const now = frontmatter(after);
		const status = now.status && now.status !== old.status ? now.status : null;
		const assigned = now.assigned && now.assigned !== old.assigned ? now.assigned : null;
		if (status === null && assigned === null) continue;
		found.push({ title: shortTitle(now.title) || readableSlug(card.slug), status, assigned });
	}
	return found;
}

async function cardTitle(slug, root, parent, tree, board) {
	for (const [rev, dir] of [
		[tree, `${board}/${slug}`],
		[tree, `${board}/archive/${slug}`],
		[parent, `${board}/${slug}`],
		[parent, `${board}/archive/${slug}`],
	]) {
		const text = await show(root, rev, `${dir}/CARD.md`);
		if (text === null) continue;
		const title = shortTitle(frontmatter(text).title);
		if (title) return title;
	}
	return readableSlug(slug);
}

/** A markdown file's frontmatter title or first heading, an HTML file's <title>, else its readable name. */
async function fileTitle(change, root, parent, tree) {
	const text = await show(root, change.status === "D" ? parent : tree, change.path);
	const ext = path.posix.extname(change.path).toLowerCase();
	let title = null;
	if (text !== null && ext === ".md") {
		title = frontmatter(text).title || (text.match(/^#\s+(.+)$/m) || [])[1];
	} else if (text !== null && (ext === ".html" || ext === ".htm")) {
		title = (text.match(/<title>([^<]+)<\/title>/i) || [])[1];
	}
	return shortTitle(title) || readableSlug(path.posix.basename(change.path, path.posix.extname(change.path)));
}

/** The first READ_MAX characters of a file at a revision; null when it is not there. */
async function show(root, rev, file) {
	const text = await git(root, ["show", `${rev}:${file}`]);
	return text === null ? null : text.slice(0, READ_MAX);
}

/** The scalar fields of a frontmatter block, quotes removed, as faru's own parser reads them. */
function frontmatter(content) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	const data = {};
	if (!match) return data;
	for (const line of match[1].split("\n")) {
		const colon = line.indexOf(":");
		if (colon <= 0 || /^\s/.test(line)) continue;
		let value = line.slice(colon + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		data[line.slice(0, colon).trim()] = value;
	}
	return data;
}

function shortTitle(title) {
	if (!title) return null;
	let text = String(title).trim();
	if (text.length > TITLE_SPLIT_AT) text = text.split(/\s+[|–-]\s+/)[0];
	return text.slice(0, TITLE_MAX).trim() || null;
}

/** 2026-11-04-OPS-LAUNCH-PLAN -> OPS LAUNCH PLAN; notes_v2 -> notes v2. */
function readableSlug(name) {
	return shortTitle(name.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/[-_]+/g, " ")) || name;
}

module.exports = { boardCommitMessage };
