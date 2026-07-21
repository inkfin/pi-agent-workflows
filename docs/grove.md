# Grove SessionGraph

Grove records a small number of durable conversation states without tracking
every Ask/Plan turn. It uses a per-project jj Tree Repo at `.pi/tree`.

## What is recorded

- A **SessionNode** stores a SessionAnchor, content-addressed SessionSnapshot,
  code state, and stable `nodeId`.
- An **Edge** expresses lineage, context injection, or supersession.
- An **Attachment** records a Build outcome, plan, decision, research report,
  or context payload.
- Orchestrator's **RunLedger** retains all attempts. Only accepted durable
  proposals become Grove nodes.

Build and Summary are Attachment kinds, not node kinds. A new work item does
not pin its predecessor. The predecessor becomes effectively sealed only after
a successor lineage Edge exists; `pinned` means the user explicitly chose to
retain that exact state.

## Automatic outcome capture

Successful Orchestrator Builds append a durable proposal to the current Pi
session. Foreground Grove consumes proposals on session start or agent settled,
then atomically writes:

```text
SessionNode + optional lineage Edge + execution-outcome Attachment
```

Same-slot retries amend the unsealed draft using an expected revision and
monotonic sequence. Duplicate EventBus notifications, repeated settled hooks,
and session restart replay are idempotent.

After the foreground agent reports the completed Build, Orchestrator proposes a
`summary` Attachment with the same slot/sequence. Grove appends it to the
existing Node even if that Node has since become sealed; it never creates a
second “Summary node.”

Attachment payloads are canonicalized, redacted, content-addressed, and capped
at 256 KiB; oversized payloads retain a bounded preview plus truncation metadata.

Workers do not write Grove. Parallel worktree outcomes first remain in
RunLedger; explicitly preserved outcomes can become sibling Nodes sharing the
same `baseNodeId`.

## Tracking configuration

`.pi/grove.json` may contain:

```json
{
  "trackingMode": "auto",
  "autoSnapshot": true
}
```

- `auto`: use Orchestrator outcomes when a RunLedger exists, otherwise legacy
  dirty-worktree capture.
- `outcome`: semantic proposals only.
- `legacy`: dirty-worktree capture only.
- `off`: disable automatic capture.

Manual checkpoint, fork, context injection, goto, pin and sync remain available
in every mode.

## Commands

- `/grove`: open the near-fullscreen SessionGraph canvas.
- `/grove commit <label>`: create a pinned manual checkpoint.
- `/grove goto <node-id|label>`: restore a session by stable nodeId.
- `/grove fork`: fork from the current/selected SessionAnchor.
- `/grove merge <node>`: inject context and record a context Edge/Attachment.
- `/grove pick <node>`: inject context without changing Grove topology.
- `/grove auto keep|replace|split [node]`: override legacy draft handling.
- `/grove pin [node]`: record explicit user retention intent.
- `/grove edge add <kind> <from> <to>`: append a typed logical Edge.
- `/grove edge delete <edge-id>`: append an Edge tombstone.
- `/grove undo`: undo the last logical operation.
- `/grove sync config|push|pull`: configure or explicitly synchronize Tree Repo.

Drawing a context Edge never performs a code merge. Switching conversation
state and switching code workspace are separate operations.

## SessionGraph canvas

The canvas is keyboard-first and read-only with respect to graph topology:

- Arrow keys or `h/j/k/l` select the nearest node in that visual direction.
- `Tab` / `Shift+Tab` cycle nodes; uppercase `H/J/K/L` pan the camera.
- `+`, `-`, `0`, and `z` zoom, reset, and fit the graph.
- `/` filters nodes; non-matches remain visible but dimmed.
- `Enter` opens the selected node's anchored chat thread in a floating window.
- In a thread, `m` toggles maximized mode, `[` / `]` switch nodes, and
  `j/k` or PageUp/PageDown scroll.
- `a` opens the contextual action palette; `?` shows help; `q` / Esc returns
  to chat.

Lineage, context and supersedes relationships use distinct line styles. Node
colors are stable and adjacent nodes are assigned different palette slots;
glyphs and borders preserve meaning in monochrome terminals. Thread content is
clipped to the node's SessionAnchor even when the local session contains newer
turns.

The current extension also exposes foreground seams for `connectNodes`,
`disconnectEdge`, `gotoNode(nodeId)`, and `promoteWorktreeOutcome`. The full
drag-and-drop node editor is intentionally deferred.

## Privacy

Sync is off by default. A Tree Repo remote must be explicitly configured and
confirmed private (or payload encryption enabled). Redaction lowers accidental
exposure risk but is not a security boundary.
