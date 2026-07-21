# Orchestrator: Ask → Plan → Build with isolated workers

## Status

Accepted

## Context

Pi core does not ship plan mode or subagent scheduling. Users want a Cursor-like loop: a strong foreground model for dialogue and planning, parallel workers for execution, a visible plan artifact, and an explicit Build gate before writes.

## Decision

1. Ship a first-party `orchestrator` extension that owns `/plan`, `/build`, and `/orchestrator`.
2. Workflow modes are `auto | ask | plan | build`.
   - The foreground model may call `set_workflow_mode` to enter **ask** or **plan** on its own.
   - Entering **build** is rejected from the model; only UI Build or `/build` after user confirmation enables writes.
3. Plans are structured `ExecutionPlan` artifacts via `submit_plan` (revisioned, DAG-validated). Free-text numbered lists are not the source of truth.
4. Workers are separate `pi --mode json -p --no-session` processes with bounded concurrency.
5. Isolation policy:
   - Research / review / test workers share the current workspace behind an
     explicitly loaded read-only worker guard.
   - Edit workers each get a temporary git worktree from a shared baseline.
   - Dependent edit workers receive ancestor edit commits before starting.
   - Review/test runs only after aggregate changes have entered the main
     worktree.
   - Successful builds are applied to the main worktree as **unstaged** changes. The orchestrator never commits or pushes the user's main branch, and never rewrites user git config.
6. Dirty main worktrees block Build when edit tasks exist; no automatic stash/reset.
7. Project-local agent profiles require interactive trust approval. Worker
   subprocesses disable implicit project extensions, skills, prompts, and
   context files.

## Consequences

- Commands extension no longer registers `/plan`.
- Users must keep the main tree clean before Build with edits.
- Conflict or path-boundary failures leave diagnostics and leftover worktrees inspectable via `/orchestrator inspect|cleanup`.
- Extension depends on `git` and a `pi` binary on PATH for workers.
- Operational commands, settings, execution phases, and recovery behavior are
  documented in [Orchestrator](../orchestrator.md).
