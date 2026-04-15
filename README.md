<p align="center">
  <img src="public/favicon.svg" width="80" height="80" alt="faru">
</p>

<h1 align="center">faru</h1>

<p align="center">Git-native kanban board. Cards are markdown files.</p>

<p align="center"><sub>/ˈfa.ru/ — Esperanto for "do!"</sub></p>

Built for teams where agents do the work and humans steer. Agents create cards via CLI, the board updates live. One kanban board, two kinds of workers, everything stored as markdown files you can read, edit, and version-control.

## Quick Start

```bash
npx github:fluado/faru
```

That's it. Faru reads your `backlog/` directory, parses YAML frontmatter from markdown files, and renders a kanban board with three columns: **Todo**, **WIP**, **Done**.

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
---

# Implement OAuth flow

Details go here.
```

Drag cards between columns. Edit titles and descriptions inline. Faru commits and pushes changes automatically.

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
| `archiveDoneAfterDays` | (Optional) Automatically move `done` cards edited more than N days ago to archive. Runs on server start and every 12 hours. |

## Creating Cards

Via CLI:

```bash
make new-card title="Fix login bug" type=bug
```

Or just tell your agent:

> Create a card: make a folder `backlog/YYYY-MM-DD-TYPE-TITLE/` containing a `CARD.md` with this format:
> ```
> ---
> title: <title>
> type: <type>
> status: todo
> assigned: <user>
> created: <date>
> description: <one-line summary>
> ---
> # <title>
> ```

Cards are just markdown folders. Any tool that can write files can create them.

## Features

- **Zero dependencies** — single `server.js`, no `node_modules`
- **Live reload** — edit cards in your editor, board updates instantly
- **Git sync** — auto-commit on change, push on commit, poll remote for updates
- **Drag & drop** — move cards between columns
- **Inline editing** — click titles and descriptions to edit
- **Cross-platform** — macOS, Windows, Linux

## Philosophy

faru has 3 columns: Todo, WIP, Done. You can't add more. This is intentional.

More columns means more places for work to stall. "In Review," "Blocked," "Ready for QA" are symptoms, not workflow stages. If something is blocked, fix the blocker or move it back to Todo. If it's in review, it's still WIP.

This comes from lean thinking and trunk-based development. Minimize work in progress. Ship small. Keep things moving. A card is either not started, being worked on, or done. Three states is enough.

## Contributing

We built faru for ourselves. We use it every day at fluado and we're sharing it because it might be useful to others.

This is not a community project. We don't have the bandwidth to review PRs, triage issues, or maintain a roadmap for external contributors. If you open an issue with a good idea, we might pick it up when it aligns with what we need. No promises.

Fork it, break it, make it yours. Have fun.

## License

MIT — Built at [fluado](https://fluado.com).
