/**
 * orchestrator/lib/scheduler.ts — DAG-aware bounded parallel execution
 */

import type { AgentConfig } from "./agents";
import { readyTasks } from "./plan";
import { isFailedResult, mapWithConcurrencyLimit, runSubagent, type RunnerResult } from "./runner";
import type { BuildRunState, ExecutionPlan, OrchestratorConfig, PlanTask, TaskRunState } from "../types";
import {
  applyAggregateAsUnstaged,
  assertPathsAllowed,
  changedFiles,
  cherryPickCommit,
  cleanupOrchResources,
  commitWorktreeChanges,
  createIntegrationBranch,
  createTaskWorktree,
  currentHeadSha,
  gitRoot,
  isWorkingTreeClean,
  removeWorktree,
  type WorktreeSlot,
} from "./worktree";

export interface SchedulerHooks {
  onUpdate: (build: BuildRunState) => void;
  resolveAgent: (name: string) => AgentConfig | undefined;
  researchTools: string[];
  editTools: string[];
  modelOverride?: string;
  /** Test seam; production uses runSubagent. */
  runAgent?: typeof runSubagent;
}

function taskState(task: PlanTask): TaskRunState {
  return {
    id: task.id,
    status: "pending",
    agent: task.agent,
    kind: task.kind,
  };
}

export async function executePlan(opts: {
  cwd: string;
  plan: ExecutionPlan;
  config: OrchestratorConfig;
  workItemId: string;
  buildAttemptId: string;
  sequence: number;
  baseNodeId: string | null;
  baseCodeRevision: string | null;
  signal?: AbortSignal;
  hooks: SchedulerHooks;
}): Promise<BuildRunState> {
  const runId = opts.buildAttemptId;
  const build: BuildRunState = {
    workItemId: opts.workItemId,
    buildAttemptId: opts.buildAttemptId,
    sequence: opts.sequence,
    planRevision: opts.plan.revision,
    status: "running",
    baseNodeId: opts.baseNodeId,
    baseCodeRevision: opts.baseCodeRevision,
    workspaceEffect: "none",
    startedAt: new Date().toISOString(),
    tasks: opts.plan.tasks.map(taskState),
    leftoverWorktrees: [],
  };

  const emit = () => opts.hooks.onUpdate({ ...build, tasks: build.tasks.map((t) => ({ ...t })) });

  const root = gitRoot(opts.cwd);
  if (!root) {
    build.status = "failed";
    build.integrateError = "Not a git repository.";
    build.finishedAt = new Date().toISOString();
    emit();
    return build;
  }

  const hasEdit = opts.plan.tasks.some((t) => t.kind === "edit");
  if (hasEdit) {
    const { clean, status } = isWorkingTreeClean(root);
    if (!clean) {
      build.status = "failed";
      build.integrateError = `Working tree must be clean before Build.\n${status}`;
      build.finishedAt = new Date().toISOString();
      emit();
      return build;
    }
  }

  const baselineSha = currentHeadSha(root);
  build.baselineSha = baselineSha;
  emit();

  const completed = new Set<string>();
  const failed = new Set<string>();
  const slots: WorktreeSlot[] = [];
  const commits: Array<{ taskId: string; sha: string }> = [];
  const taskOrder = topo(opts.plan.tasks);
  const byId = new Map(opts.plan.tasks.map((task) => [task.id, task]));
  let cancelled = false;

  const runOne = async (task: PlanTask): Promise<void> => {
    if (opts.signal?.aborted || cancelled) {
      const ts = build.tasks.find((t) => t.id === task.id)!;
      ts.status = "cancelled";
      return;
    }
    const agent = opts.hooks.resolveAgent(task.agent);
    const ts = build.tasks.find((t) => t.id === task.id)!;
    if (!agent) {
      ts.status = "failed";
      ts.error = `Unknown agent "${task.agent}"`;
      failed.add(task.id);
      emit();
      return;
    }

    ts.status = "running";
    ts.startedAt = new Date().toISOString();
    emit();

    let cwd = root;
    let slot: WorktreeSlot | undefined;
    let taskBaseSha = baselineSha;
    if (task.kind === "edit") {
      try {
        slot = createTaskWorktree(root, baselineSha, task.id, runId);
        slots.push(slot);
        ts.worktreePath = slot.path;
        ts.branch = slot.branch;
        cwd = slot.path;
        // A dependent edit must see every completed ancestor edit. Each task
        // still gets its own branch, but its starting tree includes the DAG
        // state it declared via dependsOn.
        for (const ancestorId of taskOrder) {
          const commit = commits.find((item) => item.taskId === ancestorId);
          if (!commit || !dependsOnTask(task, ancestorId, byId)) continue;
          const pick = cherryPickCommit(slot.path, commit.sha);
          if (!pick.ok) {
            throw new Error(
              `Could not prepare dependency "${ancestorId}" for "${task.id}": ${pick.error}`,
            );
          }
        }
        taskBaseSha = currentHeadSha(slot.path);
      } catch (err: any) {
        ts.status = "failed";
        ts.error = err?.message ?? String(err);
        failed.add(task.id);
        emit();
        return;
      }
    }
    ts.baseCodeRevision = taskBaseSha;

    const tools =
      task.kind === "edit"
        ? opts.hooks.editTools
        : agent.tools ?? opts.hooks.researchTools;

    let result: RunnerResult;
    try {
      const runAgent = opts.hooks.runAgent ?? runSubagent;
      result = await runAgent({
        cwd,
        agent: { ...agent, tools },
        task: [
          task.goal,
          [
            "\nExecution identity (read-only metadata):",
            `workItemId: ${opts.workItemId}`,
            `buildAttemptId: ${opts.buildAttemptId}`,
            `baseNodeId: ${opts.baseNodeId ?? "(none)"}`,
            `baseCodeRevision: ${taskBaseSha}`,
            "Never access or write Grove state; return results only to the foreground Orchestrator.",
          ].join("\n"),
          task.kind === "edit"
            ? `\nYou may only modify these paths:\n${task.allowedPaths.map((p) => `- ${p}`).join("\n")}`
            : "\nRead-only investigation. Do not modify files.",
        ].join("\n"),
        modelOverride: opts.hooks.modelOverride || opts.config.workerModel,
        signal: opts.signal,
        timeoutMs: opts.config.taskTimeoutMs,
        mutating: task.kind === "edit",
        onUpdate: (partial) => {
          ts.outputPreview = partial.stdoutText.slice(0, 400);
          ts.model = partial.model;
          emit();
        },
      });
    } catch (err: any) {
      ts.status = "failed";
      ts.error = err?.message ?? String(err);
      ts.finishedAt = new Date().toISOString();
      failed.add(task.id);
      emit();
      return;
    }

    ts.model = result.model;
    ts.outputPreview = result.stdoutText.slice(0, 400);
    ts.summary = result.stdoutText.slice(0, 2000);
    ts.finishedAt = new Date().toISOString();

    if (opts.signal?.aborted) {
      ts.status = "cancelled";
      cancelled = true;
      emit();
      return;
    }

    if (isFailedResult(result)) {
      ts.status = "failed";
      ts.error = result.errorMessage || result.stderr || `exit ${result.exitCode}`;
      failed.add(task.id);
      emit();
      return;
    }

    if (task.kind === "edit" && slot) {
      // Compare against the dependency-enriched task base, not the global
      // baseline, so ancestor edits are not mistaken for this task's output.
      const changed = changedFiles(slot.path, taskBaseSha);
      const gate = assertPathsAllowed(changed, task.allowedPaths);
      if (!gate.ok) {
        ts.status = "failed";
        ts.error = `Path boundary violated: ${gate.offenders.join(", ")}`;
        failed.add(task.id);
        emit();
        return;
      }
      const committed = commitWorktreeChanges(slot.path, `pi-orch: ${task.id}`);
      if (committed.committed && committed.sha) {
        commits.push({ taskId: task.id, sha: committed.sha });
        ts.resultRevision = committed.sha;
      }
    }

    ts.status = "succeeded";
    completed.add(task.id);
    emit();
  };

  const started = new Set<string>();
  const postTaskIds = new Set(
    opts.plan.tasks
      .filter(
        (task) =>
          task.kind === "review" ||
          task.kind === "test" ||
          (task.kind !== "edit" && hasEditAncestor(task, byId)),
      )
      .map((task) => task.id),
  );
  const preTasks = opts.plan.tasks.filter((task) => !postTaskIds.has(task.id));
  const postTasks = opts.plan.tasks.filter((task) => postTaskIds.has(task.id));

  async function runPhase(phaseTasks: PlanTask[]): Promise<void> {
    const phaseIds = new Set(phaseTasks.map((task) => task.id));
    while (
      phaseTasks.some((task) => !completed.has(task.id) && !failed.has(task.id))
    ) {
      if (opts.signal?.aborted || cancelled) {
        cancelled = true;
        return;
      }
      for (const task of phaseTasks) {
        if (completed.has(task.id) || failed.has(task.id) || started.has(task.id)) continue;
        if ((task.dependsOn ?? []).some((dependency) => failed.has(dependency))) {
          const state = build.tasks.find((item) => item.id === task.id)!;
          state.status = "blocked";
          state.error = "Blocked by failed dependency";
          failed.add(task.id);
        }
      }

      const ready = readyTasks(opts.plan.tasks, completed, failed).filter(
        (task) => phaseIds.has(task.id) && !started.has(task.id),
      );
      if (!ready.length) {
        for (const task of phaseTasks) {
          if (completed.has(task.id) || failed.has(task.id)) continue;
          const state = build.tasks.find((item) => item.id === task.id)!;
          state.status = "blocked";
          state.error = state.error || "No runnable path in this execution phase";
          failed.add(task.id);
        }
        return;
      }

      for (const task of ready) {
        started.add(task.id);
        build.tasks.find((item) => item.id === task.id)!.status = "queued";
      }
      emit();
      await mapWithConcurrencyLimit(ready, opts.config.maxParallel, runOne);
    }
  }

  // Research that does not depend on edits and all edit work happen first.
  await runPhase(preTasks);

  if (cancelled || opts.signal?.aborted) {
    build.status = "cancelled";
    for (const t of build.tasks) {
      if (t.status === "pending" || t.status === "queued" || t.status === "running") {
        t.status = "cancelled";
      }
    }
    cleanupOrchResources(root, slots);
    build.leftoverWorktrees = [];
    build.finishedAt = new Date().toISOString();
    emit();
    return build;
  }

  if (failed.size > 0) {
    build.status = "failed";
    build.leftoverWorktrees = slots.map((s) => s.path);
    build.finishedAt = new Date().toISOString();
    emit();
    return build;
  }

  // Integrate every edit before post-edit review/test. This deliberately
  // makes the main worktree dirty only after all edit workers have succeeded.
  if (commits.length > 0) {
    let integrate: { path: string; branch: string } | undefined;
    try {
      integrate = createIntegrationBranch(root, baselineSha, runId);
      // Topological order of plan tasks
      const order = topo(opts.plan.tasks);
      for (const id of order) {
        const c = commits.find((x) => x.taskId === id);
        if (!c) continue;
        const pick = cherryPickCommit(integrate.path, c.sha);
        if (!pick.ok) {
          build.status = "failed";
          build.integrateError = `Conflict integrating "${id}": ${pick.error}`;
          build.leftoverWorktrees = [...slots.map((s) => s.path), integrate.path];
          build.finishedAt = new Date().toISOString();
          emit();
          return build;
        }
      }
      const applied = applyAggregateAsUnstaged(root, integrate.path, baselineSha);
      if (!applied.ok) {
        build.status = "failed";
        build.integrateError = applied.error;
        build.leftoverWorktrees = [...slots.map((s) => s.path), integrate.path];
        build.finishedAt = new Date().toISOString();
        emit();
        return build;
      }
      build.workspaceEffect = "applied";
      cleanupOrchResources(root, slots, integrate);
    } catch (err: any) {
      build.status = "failed";
      build.integrateError = err?.message ?? String(err);
      build.leftoverWorktrees = slots.map((s) => s.path);
      if (integrate) build.leftoverWorktrees.push(integrate.path);
      build.finishedAt = new Date().toISOString();
      emit();
      return build;
    }
  } else {
    cleanupOrchResources(root, slots);
  }

  // Review/test (and any research depending on an edit) now observe the
  // aggregate changes in the current workspace.
  await runPhase(postTasks);
  if (cancelled || opts.signal?.aborted) {
    build.status = "cancelled";
  } else if (failed.size > 0) {
    build.status = "failed";
  } else {
    build.status = "succeeded";
  }
  build.finishedAt = new Date().toISOString();
  emit();
  return build;
}

function topo(tasks: PlanTask[]): string[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const result: string[] = [];
  const visited = new Set<string>();
  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const t = byId.get(id);
    for (const d of t?.dependsOn ?? []) visit(d);
    result.push(id);
  }
  for (const t of tasks) visit(t.id);
  return result;
}

function dependsOnTask(
  task: PlanTask,
  targetId: string,
  byId: Map<string, PlanTask>,
): boolean {
  const seen = new Set<string>();
  const queue = [...(task.dependsOn ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === targetId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const dependency = byId.get(id);
    if (dependency) queue.push(...(dependency.dependsOn ?? []));
  }
  return false;
}

function hasEditAncestor(
  task: PlanTask,
  byId: Map<string, PlanTask>,
): boolean {
  for (const candidate of byId.values()) {
    if (candidate.kind === "edit" && dependsOnTask(task, candidate.id, byId)) {
      return true;
    }
  }
  return false;
}

export async function cleanupLeftovers(cwd: string, paths: string[]): Promise<string[]> {
  const root = gitRoot(cwd);
  if (!root) return paths;
  const remaining: string[] = [];
  for (const p of paths) {
    try {
      removeWorktree(root, p);
    } catch {
      remaining.push(p);
    }
  }
  return remaining;
}
