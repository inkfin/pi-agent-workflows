# Pi Agent Orchestrator

The orchestrator adds a user-gated Ask → Plan → Build workflow to Pi.

## Modes

- **auto**: the foreground model chooses Ask for explanation or Plan for
  non-trivial implementation work.
- **ask**: read-only dialogue and investigation.
- **plan**: read-only investigation plus a versioned `ExecutionPlan`.
- **build**: entered only after the user confirms `/build`; edit tasks run in
  isolated worktrees.

The model cannot grant itself Build permission. `set_workflow_mode({mode:
"build"})` is always rejected.

## Commands

- `/plan [goal]`: enter Plan and optionally start planning the supplied goal.
- `/build`: confirm and execute the current valid plan revision.
- `/orchestrator actions`: open the TUI Build/Edit/Ask action selector.
- `/orchestrator auto|ask|plan`: switch read-only foreground mode.
- `/orchestrator edit [feedback]`: revise the current plan.
- `/orchestrator ask-followup [question]`: continue the current Ask/Plan turn.
- `/orchestrator status`: show plan, gate, build, and task status.
- `/orchestrator cancel`: terminate running workers (SIGTERM, then SIGKILL).
- `/orchestrator retry`: rerun the current revision after addressing failure.
- `/orchestrator inspect`: list retained diagnostic worktrees.
- `/orchestrator cleanup`: remove retained worktrees and `pi-orch/*` branches.
- `/orchestrator agents`: list resolved builtin/user/project profiles.
- `/orchestrator revisions`: inspect persisted plan artifacts and revision diffs.
- `Ctrl+Alt+B`: open the same confirmed Build path as `/build`.

## Configuration

Copy `.pi/orchestrator.json.example` to `.pi/orchestrator.json`, or put global
defaults in `~/.pi/agent/orchestrator.json`.

```json
{
  "foregroundModel": "provider/model-id",
  "foregroundThinking": "high",
  "workerModel": "provider/model-id",
  "maxParallel": 4,
  "maxTasks": 8,
  "taskTimeoutMs": 900000,
  "agentScope": "both"
}
```

Both model fields are optional. Without `workerModel`, workers inherit the
foreground model. If `foregroundModel` is absent, Plan keeps the current model.

`agentScope` is one of `builtin`, `user`, `project`, or `both`. Builtin profiles
always remain available. Project profiles under `.pi/agents` require an
interactive trust confirmation before each previously unapproved profile is
run. Non-interactive mode rejects unapproved project profiles.

## Plan artifact

`submit_plan` publishes a revision containing:

- summary and goal
- unresolved questions
- tasks with `id`, `kind`, `agent`, `dependsOn`, and `allowedPaths`

Build is disabled while questions or validation errors remain. Edit paths must
be safe repository-relative paths. Overlapping edit tasks need an explicit DAG
dependency.

## Execution phases

1. Read-only research that does not depend on edits runs in the current tree.
2. Edit tasks run in temporary branches/worktrees. A dependent edit receives
   all ancestor edit commits before it starts.
3. Changed tracked and untracked files are checked against `allowedPaths`.
4. Successful edit commits are cherry-picked into a temporary integration
   worktree and applied to main as unstaged changes.
5. Review/test tasks run against those integrated main-worktree changes.

The main tree must be clean before a plan containing edits starts. The
orchestrator never stashes, resets, commits, or pushes the main branch.

## RunLedger and Grove outcomes

Each approved Build receives stable `workItemId` and `buildAttemptId`, plus the
explicit `baseNodeId` and `baseCodeRevision` used by its workers. Orchestrator
appends versioned `orchestrator-run` session entries for started and finished
attempts, including failures and cancellation.

After a successful final integration it appends execution-outcome and approved
execution-plan `grove-attachment-proposal` entries. After the foreground agent
reports completion, it adds a Summary proposal to the same slot. These durable
session entries are the source of truth; the `grove:proposal-pending` EventBus
event only prompts foreground Grove to rescan. Workers never load Grove or
write its Tree Repo.

Grove materializes the first accepted proposal for a slot as a generic
SessionNode with an execution-outcome Attachment. Same-slot retries may amend
that draft safely. Ordinary Ask/Plan dialogue and unselected worktree outcomes
remain in RunLedger and do not create Grove nodes.

## Worker isolation

Workers start with:

```text
pi --mode json -p --no-session --no-extensions \
  --extension worker-guard.ts --no-skills --no-context-files
```

Read-only workers deny edit/write and enforce the bash allowlist. Edit workers
receive write tools only inside their temporary worktree. Project extensions,
skills, prompts, and context files are not auto-loaded into workers.

## Failure and recovery

- A worker failure blocks dependents.
- Edit/path/integration failures do not modify the main worktree.
- A review/test failure occurs after integration, so the unstaged changes stay
  available for diagnosis.
- Conflicting or failed worktrees are retained and listed by `inspect`.
- `cleanup` removes both worktrees and their temporary branches.
- Resuming a session never resumes an interrupted Build automatically; it
  returns to Plan and requires fresh approval.

## Verification

- `npm test` runs Grove plus orchestrator regression tests.
- `npm run test:coverage` runs separate Orchestrator and Grove coverage gates.
  Orchestrator enforces minimum 60% line, 70% function, and 55% branch coverage;
  Grove enforces 60% line, 65% function, and 55% branch coverage.
- The suite includes a real JSONL child process, SIGTERM-resistant
  cancellation, worker guard checks, untracked path-boundary checks, dependent
  edit worktrees, integration ordering, and post-integration review.
