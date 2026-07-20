# pi-agent-workflow

Personal pi agent workflow toolkit. Three layers:

1. **Commands** — `/plan`, `/review`, `/commit`, `/todo`, `/context`
2. **Project Tree** — branch-based session management (`/branch`)
3. **Sync** — multi-machine session sync via tree merge (`/sync`)

## Architecture

```
.pi/extensions/commands/     — Phase 1: common commands (active)
.pi/extensions/project-tree/ — Phase 2: local project tree (planned)
.pi/extensions/sync/         — Phase 3: session sync (planned)
.pi/extensions/shared/       — shared utilities
```

## Key Decisions

- One branch = one pi session file — we don't modify pi's kernel
- /fork → /branch create — unified branch concept
- Sync is explicit push/pull, never automatic
- Conflicts = branches in the tree, not file-level merges
- Merge strategy: context-inject (bring another branch's summary into current dialog)

## Development

This project is itself a pi project. Active development is tracked in TODO.md.

### Using the extension

```bash
# From this project directory (auto-discovered as .pi/extensions/)
pi

# From another project (install as local package)
pi install /Users/inkfin/dev/Code/pi-agent
```
