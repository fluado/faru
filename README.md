<p align="center">
  <img src="public/favicon.svg" width="80" height="80" alt="faru">
</p>

<h1 align="center">faru</h1>

<p align="center">Git-native kanban board. Cards are markdown files.</p>

<p align="center"><sub>/ˈfa.ru/ — Esperanto for "do!"</sub></p>

Built for teams where agents do the work and humans steer. Agents create and manage cards as markdown files, the board renders them live. One kanban board, two kinds of workers, everything stored in git.

## Quick Start

1. Copy the [setup prompt](#setup-prompt) below into your AI coding agent
2. Let it create `faru.config.json`, a `backlog/` directory, and a few starter cards
3. Run:

```bash
npx github:fluado/faru
```

## Setup Prompt

Copy this into your AI coding agent (Cursor, Copilot, Claude Code, Windsurf, etc.) to bootstrap faru in your project:

<details>
<summary>Click to expand the setup prompt</summary>

~~~
Set up a faru kanban board in this repository.

faru is a git-native kanban board that renders markdown files as cards.

### Step 1: Create faru.config.json in the project root

```json
{
  "backlogDir": "./backlog",
  "port": 3333,
  "cardCategories": ["product", "ops", "bug"],
  "autoSync": true,
  "archiveDoneAfterDays": 14
}
```

- backlogDir: path to the backlog directory (relative to project root)
- port: local server port
- cardCategories: the card types available in the UI (lowercase)
- autoSync: if true, faru auto-commits and pushes changes via git
- archiveDoneAfterDays: cards marked "done" are auto-archived after N days

Adjust cardCategories to match this project (e.g. "feature", "bug", "infra", "docs").

### Step 2: Create the backlog/ directory with 3-5 starter cards

Each card is a folder inside backlog/ following this naming convention:

  backlog/YYYY-MM-DD-TYPE-TITLE/CARD.md

Folder name format: YYYY-MM-DD-TYPE-TITLE
- YYYY-MM-DD: today's date
- TYPE: uppercase category (must match one of cardCategories)
- TITLE: uppercase, hyphens instead of spaces

Each CARD.md has YAML frontmatter:

```yaml
---
title: Human-readable title
type: category (lowercase, from cardCategories)
status: todo
assigned: <your git username from `git config user.name`>
created: YYYY-MM-DD
edited: YYYY-MM-DD
description: One-line summary of what this card is about
---

# Card Title

Details, context, or acceptance criteria go here.
```

Look at the codebase, README, open issues, or TODOs to create 3-5 cards
that reflect real work for this project. Set status to "todo" for all of them.

### Step 3: Create weekly-goal.md in the project root

A single line of text describing the focus for the current week. Example:

  Ship OAuth integration and close all P0 bugs.

### Step 4: Verify the structure

```
project-root/
├── faru.config.json
├── weekly-goal.md
└── backlog/
    ├── 2025-04-20-PRODUCT-OAUTH-LOGIN/
    │   └── CARD.md
    ├── 2025-04-20-BUG-DASHBOARD-CRASH/
    │   └── CARD.md
    └── 2025-04-20-OPS-CI-PIPELINE/
        └── CARD.md
```

### Step 5: Run the board

```bash
npx github:fluado/faru
```
~~~

</details>

## How It Works

Every card is a folder inside `backlog/` following the naming convention `YYYY-MM-DD-TYPE-TITLE/`. Each folder contains a `CARD.md` (or any `.md` file) with YAML frontmatter:

```yaml
---
title: Implement OAuth flow
type: product
status: wip
assigned: alice
created: 2026-04-15
description: Add OAuth 2.0 login flow with PKCE for the dashboard.
links:
  - specs/oauth-design.md
---

# Implement OAuth flow

Details go here.
```

Drag cards between columns. Edit titles and descriptions inline. Faru commits and pushes changes automatically.

### Links & References

If your card relates to external documentation, specs, or folders outside of the `backlog/` hierarchy, you can link them directly to the card via a `links:` array in the frontmatter. All listed references will appear in the card's sidebar and open directly in your editor when clicked.

### Card Folders

Each card folder can contain multiple files. All files are listed in the card detail view. Faru picks the primary file for frontmatter in this order:

1. `*-milestones.md`
2. `CARD.md`
3. `*-spec.md`
4. Any `.md` file

Structure the rest however you want.

### Milestones & Progress

If your card folder contains a `PREFIX-milestones.md` file with `## PREFIX-N:` headings, faru tracks progress automatically:

```
backlog/2026-04-14-INFRA-MY-PROJECT/
  VX-milestones.md      ← defines VX-1, VX-2, VX-3
  VX-1-report.md        ← VX-1 is done
  VX-2-report.md        ← VX-2 is done
  CARD.md
```

The board shows `● 2/3` on the card tile. A milestone is "done" when a matching `PREFIX-N-report.md` file exists in the same folder. You can add milestones from the card detail view — they append to the milestones file.

A milestones file uses the same YAML frontmatter as a card, plus `## PREFIX-N: Title` headings for each milestone:

```yaml
---
title: My Project
type: infra
status: wip
assigned: alice
created: 2026-04-14
edited: 2026-04-14
description: Short summary of the project
---

# VX Milestones

## VX-1: Research & Design

> Scope, acceptance criteria, tickets, etc.

## VX-2: Implementation

> ...

## VX-3: Deployment

> ...
```

To break a card into milestones, tell your agent:

> Break this card into milestones. Create a `PREFIX-milestones.md` file in the card folder with `## PREFIX-N: Title` headings. Use the card's frontmatter. When a milestone is complete, create a `PREFIX-N-report.md` file in the same folder.

## Config

Create a `faru.config.json` in your project root (all fields required):

```json
{
  "backlogDir": "./backlog",
  "port": 3333,
  "cardCategories": ["product", "ops", "bug"],
  "autoSync": true,
  "archiveDoneAfterDays": 14
}
```

| Field | Description |
|---|---|
| `backlogDir` | Path to your backlog directory, relative to project root |
| `port` | Server port |
| `cardCategories` | Category labels for the type dropdown |
| `autoSync` | `true` = auto-commit, push, and poll remote. `false` = local only |
| `archiveDoneAfterDays` | Automatically move `done` cards older than N days to archive |

## Creating Cards

Tell your agent:

> Create a new faru card in the `backlog/` folder for [describe the task]. Use today's date, set status to todo, and assign it to me.

Cards are folders with markdown files. Any tool that can write files can create them. The board UI also lets you create cards directly.

## Features

- **Zero dependencies** — single `server.js`, no `node_modules`
- **Weekly Goal** — set a high-level focus via an editable board banner that saves directly to `weekly-goal.md` in your project root
- **Card detail view** — click a card to open a full modal with editable metadata sidebar (type, status, assigned), progress bar, milestone checklist, file browser, and comments thread
- **External links** — attach references or external spec folders to any card via a `links:` array in the YAML frontmatter
- **Comments** — add comments from the card detail view. Stored as `## Comments` in `CARD.md`, visible as a badge on card tiles
- **Milestones from UI** — add new milestones directly from the card detail. Auto-creates the milestones file if one doesn't exist yet
- **Archive** — archive cards from the detail view. Toggle the archive view to browse archived cards. Auto-archive sweeps `done` cards older than N days (configurable)
- **Open in editor** — click any file in the card sidebar to open it in your default editor
- **Live reload** — edit cards in your editor, board updates instantly
- **Git sync** — auto-commit on change, push on commit, poll remote every 5s and pull when changed
- **Drag & drop** — move cards between columns
- **Inline editing** — click titles and descriptions to edit in-place
- **Assignee detection** — reads `git config user.name`, populates assignee dropdowns from existing cards
- **Cross-platform** — macOS, Windows, Linux

## Philosophy

The board is a view layer. Your editor is the workspace.

Cards are markdown files. You can edit them in VS Code, Vim, or whatever you use — the board picks up changes instantly via live reload. The card detail view handles quick metadata tweaks (status, assignee, type), but for anything beyond that, click "Open in Editor" and you're in your real environment with full editing power, search, git history, and AI assistance. The board doesn't try to be an editor. It shows you the state of work and gets out of the way.

faru has 3 columns: Todo, WIP, Done. You can't add more. This is intentional.

More columns means more places for work to stall. "In Review," "Blocked," "Ready for QA" are symptoms, not workflow stages. If something is blocked, fix the blocker or move it back to Todo. If it's in review, it's still WIP.

This comes from lean thinking and trunk-based development. Minimize work in progress. Ship small. Keep things moving. A card is either not started, being worked on, or done. Three states is enough.

## FAQ

<details>
<summary>Where does faru run?</summary>

On your machine. Faru is a local dev server — you run `npx github:fluado/faru` in the directory where your `faru.config.json` lives, open `http://localhost:3333` in your browser, and "Open in Editor" opens files in your local editor. Your AI agent doesn't need faru running at all. The agent just writes markdown files and pushes via git. Faru polls the remote every 5 seconds and pulls changes automatically.

</details>

<details>
<summary>Will faru pollute my git history?</summary>

When `autoSync` is `true`, faru commits every change with a `board: ` prefix (`board: move X to wip`, `board: comment on Y`). These are real commits on whatever branch is checked out. If you want a clean main branch, you have two options:

- Set `"autoSync": false` — faru becomes read-only from git's perspective. You commit manually.
- Run faru on a dedicated branch and merge to main on your own terms.

In practice, board commits are small and only touch files inside your `backlogDir`. They won't appear in diffs for your source code.

</details>

## Contributing

We built faru for ourselves. We use it every day at fluado and we're sharing it because it might be useful to others.

This is not a community project. We don't have the bandwidth to review PRs, triage issues, or maintain a roadmap for external contributors. If you open an issue with a good idea, we might pick it up when it aligns with what we need. No promises.

Fork it, break it, make it yours. Have fun.

## License

MIT — Built at [fluado](https://fluado.com).
