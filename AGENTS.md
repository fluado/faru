# Faru Agent Rules

Node.js git-native kanban board. Cards are markdown files in `backlog/`. Pluggable agent drivers in `drivers/`. Serial FIFO dispatch queue.

## Boundaries

These constraints protect architectural integrity. When one conflicts
with your task, pause and report the conflict to the user.

- The filesystem is the source of truth — cards live as markdown in `backlog/`, not in a database.
- Config is split: `faru.config.json` (shared, committed) vs `.faru.local.json` (local, gitignored). Driver choice and machine-specific options belong in `.faru.local.json`.
- Do not start the server unless explicitly asked — the agent cannot interact with the UI.
- Git commits: descriptive messages. Board auto-sync commits use a `board: ` prefix when `autoSync` is enabled.
- New agent drivers go in `drivers/` and must implement the driver interface — see `.cursor/rules/driver-pattern.mdc`.
- Dispatch runs one card at a time via a FIFO queue — do not bypass serial execution — see `.cursor/rules/dispatch-pattern.mdc`.
- Card folder naming, frontmatter, and milestones follow strict conventions — see `.cursor/rules/card-conventions.mdc`.

## Commands

| Action | Command |
|--------|---------|
| Start server | `make start` |
| Dev (watch) | `make dev` |
| Publish subtree | `make publish` |

There is no typecheck, lint, or test suite. Do not add tooling unless explicitly requested.

## Verification

Before considering work complete:

1. Read `README.md` for card conventions, dispatch, drivers, and kata if your change touches those areas.
2. Manually verify config changes parse as valid JSON.
3. For driver changes, confirm the module exports the required interface functions.

## Commit Protocol

- Descriptive commit messages.
- If you encounter an error you cannot resolve after two attempts, report it to the user with the full output.

## Architecture (read rules for details)

- **Card conventions**: Backlog structure, CARD.md frontmatter, milestones — see `.cursor/rules/card-conventions.mdc`
- **Driver pattern**: Pluggable agent drivers — see `.cursor/rules/driver-pattern.mdc`
- **Dispatch pattern**: Skill chains, FIFO queue, verification pass — see `.cursor/rules/dispatch-pattern.mdc`

## Key Files

| File | Role |
|------|------|
| `server.js` | HTTP server, board API, config merge |
| `dispatch.js` | Skill-chain orchestrator and FIFO queue |
| `registry.js` | Multi-driver registry and config routing |
| `kata.js` | Dojo kata scheduler |
| `drivers/*.js` | Agent driver implementations |
