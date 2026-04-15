const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BACKLOG_DIR = path.join(__dirname, '../../backlog');

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

function parseFrontmatter(content) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return null;
	const yaml = match[1];
	const data = {};
    const lines = yaml.split("\n");
	for (const line of lines) {
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
	return { match, data };
}

let migrated = 0;
let errors = 0;
const changedFiles = [];

console.log("Locating 'done' cards and backfilling completed dates via Git history...");

for (const entry of fs.readdirSync(BACKLOG_DIR)) {
	if (entry === "archive" || entry.startsWith(".")) continue;
	const folderPath = path.join(BACKLOG_DIR, entry);
	if (!fs.statSync(folderPath).isDirectory()) continue;

	const canonical = findCanonicalFile(folderPath);
	if (!canonical) continue;

	const content = fs.readFileSync(canonical, "utf-8");
	const parsed = parseFrontmatter(content);
    if (!parsed || parsed.data.status !== "done" || parsed.data.completed) continue;

    try {
        // Fetch real status: done date from git picking
        const gitOut = execSync(`git log -S"status: done" --format="%ct" -1 "${canonical}"`, { cwd: BACKLOG_DIR, encoding: 'utf8', stdio: 'pipe' }).trim();
        let dateStr;
        if (gitOut) {
            // Found exact transition time
            const d = new Date(parseInt(gitOut, 10) * 1000);
            dateStr = d.toISOString().split('T')[0];
        } else {
            // Fallback to frontmatter creation date (rare, e.g. file wasn't tracked properly or done instantly before commit)
            dateStr = parsed.data.created || new Date().toISOString().split('T')[0];
        }

        // Insert `completed: YYYY-MM-DD` right after status
        const oldFrontmatterBlock = parsed.match[0];
        const newFrontmatterBlock = oldFrontmatterBlock.replace(
            /(status:\s*done)/m, 
            `$1\ncompleted: ${dateStr}`
        );

        const newContent = content.replace(oldFrontmatterBlock, newFrontmatterBlock);
        fs.writeFileSync(canonical, newContent, "utf-8");
        changedFiles.push(canonical);
        
        console.log(`✅ [${dateStr}] ${entry}`);
        migrated++;
    } catch (e) {
        console.log(`❌ Error migrating ${entry}: ${e.message}`);
        errors++;
    }
}

console.log(`\nMigration Summary\nSuccessfully migrated: ${migrated}\nErrors: ${errors}`);

if (changedFiles.length > 0) {
    try {
        console.log("Committing changes...");
        execSync(`git add ${changedFiles.join(' ')}`, { cwd: BACKLOG_DIR, stdio: 'ignore' });
        execSync(`git commit -m "board: backfill completed dates"`, { cwd: BACKLOG_DIR, stdio: 'ignore' });
        console.log("Committed successfully.");
    } catch(e) {
        console.log("Error committing to Git: " + e.message);
    }
}
