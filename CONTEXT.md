# pi-agent-workflow

Personal pi agent workflow toolkit. Three layers:

1. **Commands** — `/plan`, `/review`, `/commit`, `/todo`, `/context`
2. **Grove (local tree)** — jj-backed session tree, one per project (`/grove`)
3. **Grove (sync)** — cross-machine session discovery & fetch via a central Registry

## Architecture

```
.pi/extensions/commands/      — Phase 1: common commands (active)
.pi/extensions/grove/         — Phase 2–3: grove local tree + sync
.pi/extensions/shared/        — shared utilities
tests/                        — grove e2e + unit checks (npm test)
docs/adr/                     — architecture decisions
docs/ref/                     — external project investigations
```

## Language

**Grove**:
The session-tree system as a whole: per-project trees plus the cross-machine registry.
_Avoid_: project-tree, branch tree

**Session**:
A single pi conversation. Storage for turns; not itself a unit of the tree.

**Turn**:
One exchange within a session. Turns are ephemeral; most never become nodes.

**Node**:
A durable point in a project's session history: a checkpoint, fork, merge, auto, or frontier.
_Avoid_: branch

**Checkpoint**:
A Node explicitly named by the user to mark a position (always pinned).

**SessionAnchor**:
A durable pointer into a pi session (`entryId`, `entryHash`, `ordinal`, `prefixHash`).
Used for goto/fork recovery after compaction. Not related to the Cursor product.

**Tree Repo**:
The per-project store holding Nodes and content-addressed Session Snapshots.
Its remote boundary equals the privacy/collaboration boundary.

**Session Snapshot**:
Immutable conversation content addressed by `snapshotId` (`objects/<sha256>.jsonl`).

**Registry**:
The shared catalog of projects and sessions across machines. Metadata only; never holds Session Snapshots.

**Origin**:
The machine where a Node was created. Provenance, not identity. Each origin owns one sync bookmark.

**Lifecycle** (auto Nodes):
`draft` → `pinned` → `published`. Only draft Nodes without children may be auto-amended.

## Relationships

- A **Session** contains many **Turns**; only a few become **Nodes**
- A **Node** belongs to exactly one **Tree Repo** and may reference one **Session Snapshot**
- A **Node** records its **Origin** and a **SessionAnchor**
- The **Registry** catalogs many **Tree Repos** but contains no **Session Snapshots**

## Key Decisions

- Node is the durable unit; a Session is storage, not a tree citizen
- Tree backend: jj CLI behind a `TreeBackend` interface, git-backed storage — [ADR-0001](docs/adr/0001-tree-backend-jj-cli.md)
- Sync topology: per-project Tree Repos + central metadata Registry — [ADR-0002](docs/adr/0002-sync-topology-per-project-repos.md)
- Not using Entire as backend — [ADR-0003](docs/adr/0003-not-using-entire-as-backend.md)
- Grove schema, SessionAnchor, coordinator, harness auto, sync protocol — [ADR-0004](docs/adr/0004-grove-schema-and-consistency.md)
- Manifest schema is `v: 1`; until the first release it evolves in place, then becomes a compatibility boundary
- Sync stays explicit (triggered by user or agent command), never background-automatic
- Conflicts surface as branches in the tree, not file-level merges
- Merge strategy: context-inject (`context_merge`) — works across machines and projects
- `/grove` is the unified entry point; pi's built-in `/tree` stays untouched
- Privacy: remotes must be private; sync default-off; a project may opt out of the Registry

## Example dialogue

> **Dev:** "When I checkpoint on my office Mac, does the Registry get the conversation?"
> **Expert:** "No. The Checkpoint and its Session Snapshot stay in the project's Tree Repo. The Registry only learns that the session exists, which remote holds it, and its Origin machine."

> **Dev:** "Does 'SessionAnchor' mean Cursor?"
> **Expert:** "No. It is a Grove term for a position inside a pi session (entryId + content hashes)."

## Flagged ambiguities

- "branch" means a jj bookmark only at the backend boundary; the durable Grove unit is the **Node**.
- **SessionAnchor** means a position in a pi session and has no Cursor product dependency.

## Development

This project is itself a pi project. Active development is tracked in TODO.md.

### Using the extension

```bash
# From this project directory (auto-discovered as .pi/extensions/)
pi

# From another project (install as local package)
pi install /Users/inkfin/dev/Code/pi-agent
```
