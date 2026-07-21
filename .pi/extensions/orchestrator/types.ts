/**
 * orchestrator/types.ts — Ask → Plan → Build workflow types
 */

import type { WorkspaceEffect } from "../shared/outcomes";

export type WorkflowMode = "auto" | "ask" | "plan" | "build";

export type TaskKind = "research" | "edit" | "review" | "test";

export type TaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "blocked";

export interface PlanTask {
  id: string;
  kind: TaskKind;
  agent: string;
  goal: string;
  dependsOn: string[];
  /** Paths this task may modify. Required for edit tasks; empty for read-only. */
  allowedPaths: string[];
}

export interface ExecutionPlan {
  revision: number;
  summary: string;
  goal: string;
  openQuestions: string[];
  tasks: PlanTask[];
  createdAt: string;
}

export interface PlanRevisionRecord {
  revision: number;
  summary: string;
  createdAt: string;
  taskCount: number;
  /** Full immutable artifact for revision inspection. */
  plan: ExecutionPlan;
  /** Human-readable change from the preceding revision. */
  diff: string;
}

export interface PlanValidationError {
  code: string;
  message: string;
}

export interface TaskRunState {
  id: string;
  status: TaskStatus;
  agent: string;
  kind: TaskKind;
  startedAt?: string;
  finishedAt?: string;
  model?: string;
  worktreePath?: string;
  branch?: string;
  baseCodeRevision?: string;
  /** Immutable worker result commit; worktree path/branch remain local diagnostics. */
  resultRevision?: string;
  summary?: string;
  error?: string;
  outputPreview?: string;
}

export interface BuildRunState {
  workItemId: string;
  buildAttemptId: string;
  sequence: number;
  planRevision: number;
  status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  baseNodeId: string | null;
  baseCodeRevision: string | null;
  workspaceEffect: WorkspaceEffect;
  baselineSha?: string;
  startedAt?: string;
  finishedAt?: string;
  tasks: TaskRunState[];
  integrateError?: string;
  leftoverWorktrees: string[];
}

export interface WorkflowSnapshot {
  mode: WorkflowMode;
  previousTools?: string[];
  workItemId?: string;
  nextBuildSequence?: number;
  pendingSummaryAttemptId?: string;
  plan?: ExecutionPlan;
  revisions: PlanRevisionRecord[];
  build?: BuildRunState;
  lockedRevision?: number;
}

export interface OrchestratorConfig {
  /** Optional preferred foreground model as provider/id */
  foregroundModel?: string;
  foregroundThinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Default worker model as provider/id or bare id */
  workerModel?: string;
  maxParallel: number;
  maxTasks: number;
  taskTimeoutMs: number;
  agentScope: "builtin" | "user" | "project" | "both";
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  maxParallel: 4,
  maxTasks: 8,
  taskTimeoutMs: 15 * 60 * 1000,
  agentScope: "both",
};

export const WRITE_TOOLS = new Set([
  "edit",
  "write",
  "update_glossary",
]);

export const ASK_PLAN_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "questionnaire",
  "set_workflow_mode",
  "submit_plan",
  "dispatch_research",
];

export const BUILD_EXTRA_TOOLS = [
  "dispatch_build",
  "edit",
  "write",
];
