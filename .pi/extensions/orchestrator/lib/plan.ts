/**
 * orchestrator/lib/plan.ts — ExecutionPlan validation and revision helpers
 */

import type {
  ExecutionPlan,
  PlanTask,
  PlanValidationError,
  TaskKind,
} from "../types";

const TASK_KINDS = new Set<TaskKind>(["research", "edit", "review", "test"]);

export function validatePlan(plan: ExecutionPlan): PlanValidationError[] {
  const errors: PlanValidationError[] = [];
  if (!plan.summary?.trim()) {
    errors.push({ code: "summary", message: "Plan summary is required." });
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    errors.push({ code: "tasks", message: "Plan must include at least one task." });
    return errors;
  }

  const ids = new Set<string>();
  for (const task of plan.tasks) {
    const local = validateTask(task, ids);
    errors.push(...local);
    if (task.id) ids.add(task.id);
  }

  // dependency existence + cycles
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  for (const task of plan.tasks) {
    for (const dep of task.dependsOn ?? []) {
      if (!byId.has(dep)) {
        errors.push({
          code: "missing_dep",
          message: `Task "${task.id}" depends on unknown task "${dep}".`,
        });
      }
    }
  }
  const cycle = findCycle(plan.tasks);
  if (cycle) {
    errors.push({ code: "cycle", message: `Dependency cycle: ${cycle.join(" -> ")}` });
  }

  // Edits are integrated before review/test. Letting an edit depend on a
  // post-integration task would make the execution phases impossible.
  for (const task of plan.tasks) {
    if (task.kind !== "edit") continue;
    for (const candidate of plan.tasks) {
      if (
        (candidate.kind === "review" || candidate.kind === "test") &&
        dependsTransitively(task, candidate.id, byId)
      ) {
        errors.push({
          code: "phase_order",
          message: `Edit task "${task.id}" cannot depend on post-build ${candidate.kind} task "${candidate.id}".`,
        });
      }
    }
  }

  // overlapping edit paths without dependency
  const editTasks = plan.tasks.filter((t) => t.kind === "edit");
  for (let i = 0; i < editTasks.length; i++) {
    for (let j = i + 1; j < editTasks.length; j++) {
      const a = editTasks[i];
      const b = editTasks[j];
      if (!pathsOverlap(a.allowedPaths, b.allowedPaths)) continue;
      if (dependsTransitively(a, b.id, byId) || dependsTransitively(b, a.id, byId)) continue;
      errors.push({
        code: "path_overlap",
        message: `Edit tasks "${a.id}" and "${b.id}" share overlapping paths but have no dependency order.`,
      });
    }
  }

  return errors;
}

function validateTask(task: PlanTask, seen: Set<string>): PlanValidationError[] {
  const errors: PlanValidationError[] = [];
  if (!task.id || typeof task.id !== "string") {
    errors.push({ code: "task_id", message: "Each task needs a string id." });
    return errors;
  }
  if (seen.has(task.id)) {
    errors.push({ code: "dup_id", message: `Duplicate task id "${task.id}".` });
  }
  if (!TASK_KINDS.has(task.kind)) {
    errors.push({ code: "kind", message: `Task "${task.id}" has invalid kind.` });
  }
  if (!task.agent?.trim()) {
    errors.push({ code: "agent", message: `Task "${task.id}" needs an agent.` });
  }
  if (!task.goal?.trim()) {
    errors.push({ code: "goal", message: `Task "${task.id}" needs a goal.` });
  }
  if (!Array.isArray(task.dependsOn)) {
    errors.push({ code: "dependsOn", message: `Task "${task.id}" dependsOn must be an array.` });
  }
  if (!Array.isArray(task.allowedPaths)) {
    errors.push({ code: "paths", message: `Task "${task.id}" allowedPaths must be an array.` });
  } else if (task.kind === "edit" && task.allowedPaths.length === 0) {
    errors.push({
      code: "paths",
      message: `Edit task "${task.id}" must declare allowedPaths.`,
    });
  } else if (
    task.kind === "edit" &&
    task.allowedPaths.some((item) => !isSafeRelativePath(item))
  ) {
    errors.push({
      code: "paths",
      message: `Edit task "${task.id}" contains an absolute, empty, or parent-traversing allowedPath.`,
    });
  } else if (task.kind !== "edit" && task.allowedPaths.length > 0) {
    // allow empty; warn-level not needed — ignore extra paths
  }
  return errors;
}

function findCycle(tasks: PlanTask[]): string[] | null {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(id: string): string[] | null {
    if (visiting.has(id)) {
      const idx = stack.indexOf(id);
      return [...stack.slice(idx), id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    stack.push(id);
    const task = byId.get(id);
    for (const dep of task?.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      const c = dfs(dep);
      if (c) return c;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const t of tasks) {
    const c = dfs(t.id);
    if (c) return c;
  }
  return null;
}

function dependsTransitively(
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
    const next = byId.get(id);
    if (next) queue.push(...(next.dependsOn ?? []));
  }
  return false;
}

export function pathsOverlap(a: string[], b: string[]): boolean {
  for (const pa of a) {
    for (const pb of b) {
      if (pathCovers(pa, pb) || pathCovers(pb, pa)) return true;
    }
  }
  return false;
}

function pathCovers(parent: string, child: string): boolean {
  const p = normalizePath(parent);
  const c = normalizePath(child);
  return p === c || c.startsWith(p.endsWith("/") ? p : `${p}/`);
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function isSafeRelativePath(value: string): boolean {
  const normalized = normalizePath(value);
  return (
    normalized.length > 0 &&
    !normalized.startsWith("/") &&
    !normalized.split("/").some((part) => part === "..")
  );
}

/** Ready tasks whose deps are all in completed set. */
export function readyTasks(
  tasks: PlanTask[],
  completed: Set<string>,
  failed: Set<string>,
): PlanTask[] {
  return tasks.filter((t) => {
    if (completed.has(t.id) || failed.has(t.id)) return false;
    const deps = t.dependsOn ?? [];
    if (deps.some((d) => failed.has(d))) return false;
    return deps.every((d) => completed.has(d));
  });
}

export function canBuild(plan: ExecutionPlan | undefined, errors: PlanValidationError[]): {
  ok: boolean;
  reason?: string;
} {
  if (!plan) return { ok: false, reason: "No plan yet" };
  if ((plan.openQuestions ?? []).some((q) => q.trim())) {
    return { ok: false, reason: "Open questions remain" };
  }
  if (errors.length > 0) {
    return { ok: false, reason: errors[0].message };
  }
  return { ok: true };
}

export function normalizeIncomingPlan(
  input: {
    summary: string;
    goal?: string;
    openQuestions?: string[];
    tasks: Array<{
      id: string;
      kind: TaskKind;
      agent: string;
      goal: string;
      dependsOn?: string[];
      allowedPaths?: string[];
    }>;
  },
  previous?: ExecutionPlan,
): ExecutionPlan {
  return {
    revision: (previous?.revision ?? 0) + 1,
    summary: input.summary.trim(),
    goal: (input.goal ?? previous?.goal ?? input.summary).trim(),
    openQuestions: (input.openQuestions ?? []).map((q) => q.trim()).filter(Boolean),
    tasks: input.tasks.map((t) => ({
      id: t.id.trim(),
      kind: t.kind,
      agent: t.agent.trim(),
      goal: t.goal.trim(),
      dependsOn: [...(t.dependsOn ?? [])],
      allowedPaths: [...(t.allowedPaths ?? [])],
    })),
    createdAt: new Date().toISOString(),
  };
}

export function planDiffSummary(prev: ExecutionPlan | undefined, next: ExecutionPlan): string {
  if (!prev) return `Created plan r${next.revision} with ${next.tasks.length} tasks.`;
  const lines: string[] = [`r${prev.revision} → r${next.revision}`];
  if (prev.summary !== next.summary) lines.push("Summary updated.");
  const prevIds = new Set(prev.tasks.map((t) => t.id));
  const nextIds = new Set(next.tasks.map((t) => t.id));
  for (const id of nextIds) if (!prevIds.has(id)) lines.push(`+ task ${id}`);
  for (const id of prevIds) if (!nextIds.has(id)) lines.push(`- task ${id}`);
  const oq = next.openQuestions.length;
  lines.push(oq ? `${oq} open question(s)` : "No open questions");
  return lines.join("\n");
}
