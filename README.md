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
---

# Implement OAuth flow

Details go here.
```

Drag cards between columns. Edit titles and descriptions inline. Faru commits and pushes changes automatically.

## Config

Create a `faru.config.json` in your project root (all fields required):

```json
{
  "backlogDir": "./backlog",
  "port": 3333,
  "cardCategories": ["product", "ops", "bug"],
  "autoSync": true
}
```

| Field | Description |
|---|---|
| `backlogDir` | Path to your backlog directory, relative to project root |
| `port` | Server port |
| `cardCategories` | Category labels for the type dropdown |
| `autoSync` | `true` = auto-commit, push, and poll remote. `false` = local only |

## CLI

Create cards without the browser:

```bash
make new-card title="Fix login bug" type=bug
```

Or directly:

```bash
node cli/new-card.js title="Fix login bug" type=bug
```

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
