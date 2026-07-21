# pi-agent-workflow

Personal pi agent workflow toolkit. Three layers:

1. **Commands** — `/review`, `/commit`, `/todo`, `/context`
2. **Orchestrator** — Cursor-style Ask → Plan → Build (`/plan`, `/build`, `/orchestrator`)
3. **Grove** — jj-backed session tree + optional cross-machine sync (`/grove`)

## Architecture

```
.pi/extensions/commands/       — workflow commands
.pi/extensions/orchestrator/   — Ask/Plan/Build + parallel workers
.pi/extensions/grove/          — session tree + sync
.pi/extensions/shared/         — shared utilities
tests/                         — grove + orchestrator checks (npm test)
docs/adr/                      — architecture decisions
docs/ref/                      — external project investigations
```

## Language

**Orchestrator**:
Foreground agent that dialogues, plans, and verifies. Workers are short-lived Pi subprocesses.

**Ask / Plan / Build**:
Read-only dialogue, read-only planning with a versioned ExecutionPlan, and user-approved execution. The model may enter Ask/Plan; only the user may enter Build.

**ExecutionPlan**:
Structured plan artifact (`submit_plan`) with revision, open questions, and DAG tasks. The TUI panel always binds Build to the current revision.

**Grove**:
The session-tree system as a whole: per-project trees plus the cross-machine registry.
_Avoid_: project-tree, branch tree

**Session**:
A single pi conversation. Storage for turns; not itself a unit of the tree.

**Turn**:
One exchange within a session. Turns are ephemeral; most never become nodes.

**Node**:
A durable, navigable point in a project's session history. Its stable `nodeId` is
independent from jj change-id. Build, Summary, checkpoint and fork are capture
reasons or Attachments, not Node kinds.
_Avoid_: branch

**Edge**:
An explicit `lineage`, `context`, or `supersedes` relationship between two Nodes.
The semantic graph does not use jj commit parents as its topology.

**Attachment**:
An immutable, content-addressed outcome attached to a Node, such as an execution
outcome, plan, decision, research report, or context injection.

**RunLedger**:
Orchestrator's append-only execution history. It retains successful, failed, and
cancelled attempts; only accepted durable outcomes become Grove Nodes.

**Checkpoint**:
A manually captured, explicitly named Node (always pinned).

**SessionAnchor**:
A durable pointer into a pi session (`entryId`, `entryHash`, `ordinal`, `prefixHash`).
Used for goto/fork recovery after compaction. Not related to the Cursor product.

**Tree Repo**:
The per-project jj-backed store holding GraphTransactions and content-addressed
Session Snapshots/Attachment payloads. jj topology is physical storage only.
Its remote boundary equals the privacy/collaboration boundary.

**Session Snapshot**:
Immutable conversation content addressed by `snapshotId` (`objects/<sha256>.jsonl`).

**Registry**:
The shared catalog of projects and sessions across machines. Metadata only; never holds Session Snapshots.

**Origin**:
The machine where a Node was created. Provenance, not identity. Each origin owns one sync bookmark.

**Effective sealed**:
A Node cannot be amended after it is explicitly sealed, pinned, published, or has
an active outgoing lineage Edge. `pinned` represents user intent only.

## Relationships

- A **Session** contains many **Turns**; only a few become **Nodes**
- A **Node** belongs to exactly one **Tree Repo** and may reference one **Session Snapshot**
- A **Node** records its **Origin** and a **SessionAnchor**; **Attachments** explain its outcomes
- **Edges** define the user graph independently from the jj storage DAG
- The **Orchestrator RunLedger** proposes outcomes; foreground Grove is the only Tree Repo writer
- The **Registry** catalogs many **Tree Repos** but contains no **Session Snapshots**
- Workers never write Grove; accepted worktree outcomes can become sibling Nodes from an explicit base

## Key Decisions

- Node is the durable unit; a Session is storage, not a tree citizen
- Tree backend: jj CLI behind a `TreeBackend` interface, git-backed storage — [ADR-0001](docs/adr/0001-tree-backend-jj-cli.md)
- Sync topology: per-project Tree Repos + central metadata Registry — [ADR-0002](docs/adr/0002-sync-topology-per-project-repos.md)
- Not using Entire as backend — [ADR-0003](docs/adr/0003-not-using-entire-as-backend.md)
- Grove schema, SessionAnchor, coordinator, harness auto, sync protocol — [ADR-0004](docs/adr/0004-grove-schema-and-consistency.md)
- Grove SessionGraph, Attachments, RunLedger outcome protocol, and foreground single-writer — [ADR-0006](docs/adr/0006-grove-session-graph-and-outcomes.md)
- Manifest schema is `v: 1`; until the first release it evolves in place, then becomes a compatibility boundary
- Orchestrator Ask → Plan → Build with worktree-isolated edit workers — [ADR-0005](docs/adr/0005-orchestrator-ask-plan-build.md)
- Sync stays explicit (triggered by user or agent command), never background-automatic
- Graph conflicts surface as sibling Nodes or unapplied Edges, not silent overwrites
- Context injection is an Attachment plus typed Edge; it never implies a code merge
- `/grove` is the unified entry point; pi's built-in `/tree` stays untouched
- Privacy: remotes must be private; sync default-off; a project may opt out of the Registry

## Example dialogue

> **Dev:** "When I checkpoint on my office Mac, does the Registry get the conversation?"
> **Expert:** "No. The Checkpoint and its Session Snapshot stay in the project's Tree Repo. The Registry only learns that the session exists, which remote holds it, and its Origin machine."

> **Dev:** "Does 'SessionAnchor' mean Cursor?"
> **Expert:** "No. It is a Grove term for a position inside a pi session (entryId + content hashes)."

> **Dev:** "Can the agent start Build by itself?"
> **Expert:** "No. It can enter Ask/Plan and revise the plan. Build requires your click or `/build`."

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
