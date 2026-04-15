<p align="center">
  <img src="public/favicon.svg" width="80" height="80" alt="faru">
</p>

<h1 align="center">faru</h1>

<p align="center">Git-native kanban board. Cards are markdown files.</p>

![faru board](https://raw.githubusercontent.com/fluado/faru/main/screenshot.png)

## Quick Start

```bash
npx faru
```

That's it. Faru reads your `backlog/` directory, parses YAML frontmatter from markdown files, and renders a kanban board with three columns: **Todo**, **WIP**, **Done**.

## How It Works

Every card is a folder inside `backlog/` following the naming convention `YYYY-MM-DD-TYPE-TITLE/`. Each folder contains a `CARD.md` (or any `.md` file) with YAML frontmatter:

```yaml
---
title: Implement OAuth flow
type: product
status: wip
assigned: yvg
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

## License

MIT — Built at [fluado](https://fluado.com).
