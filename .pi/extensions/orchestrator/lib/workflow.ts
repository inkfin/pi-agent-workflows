/**
 * orchestrator/lib/workflow.ts — Ask / Plan / Build mode controller
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { newProtocolId } from "../../shared/outcomes";
import {
  ASK_PLAN_TOOLS,
  BUILD_EXTRA_TOOLS,
  WRITE_TOOLS,
  type BuildRunState,
  type ExecutionPlan,
  type PlanRevisionRecord,
  type WorkflowMode,
  type WorkflowSnapshot,
} from "../types";
import { canBuild, validatePlan } from "./plan";

export class WorkflowController {
  mode: WorkflowMode = "auto";
  previousTools: string[] | undefined;
  workItemId: string | undefined;
  nextBuildSequence = 1;
  pendingSummaryAttemptId: string | undefined;
  plan: ExecutionPlan | undefined;
  revisions: PlanRevisionRecord[] = [];
  build: BuildRunState | undefined;
  lockedRevision: number | undefined;
  agentRunning = false;
  abort: AbortController | undefined;

  snapshot(): WorkflowSnapshot {
    return {
      mode: this.mode,
      previousTools: this.previousTools,
      workItemId: this.workItemId,
      nextBuildSequence: this.nextBuildSequence,
      pendingSummaryAttemptId: this.pendingSummaryAttemptId,
      plan: this.plan,
      revisions: this.revisions,
      build: this.build,
      lockedRevision: this.lockedRevision,
    };
  }

  restore(data: WorkflowSnapshot | undefined): void {
    if (!data) return;
    this.mode = data.mode ?? "auto";
    this.previousTools = data.previousTools;
    this.workItemId = data.workItemId;
    this.nextBuildSequence = Math.max(1, data.nextBuildSequence ?? 1);
    this.pendingSummaryAttemptId = data.pendingSummaryAttemptId;
    this.plan = data.plan;
    this.revisions = data.revisions ?? [];
    this.build = data.build;
    this.lockedRevision = data.lockedRevision;
    if (this.plan && !this.workItemId) this.workItemId = newProtocolId("work");
  }

  /** A module-scoped extension instance can serve several unrelated sessions. */
  reset(): void {
    this.mode = "auto";
    this.previousTools = undefined;
    this.workItemId = undefined;
    this.nextBuildSequence = 1;
    this.pendingSummaryAttemptId = undefined;
    this.plan = undefined;
    this.revisions = [];
    this.build = undefined;
    this.lockedRevision = undefined;
    this.agentRunning = false;
    this.abort?.abort();
    this.abort = undefined;
  }

  /** Explicit `/plan <goal>` starts a new logical work lineage. */
  startWorkItem(): string {
    this.workItemId = newProtocolId("work");
    this.nextBuildSequence = 1;
    this.pendingSummaryAttemptId = undefined;
    this.plan = undefined;
    this.revisions = [];
    this.build = undefined;
    this.lockedRevision = undefined;
    return this.workItemId;
  }

  beginBuildAttempt(base: {
    baseNodeId: string | null;
    baseCodeRevision: string | null;
  }): {
    workItemId: string;
    buildAttemptId: string;
    sequence: number;
    baseNodeId: string | null;
    baseCodeRevision: string | null;
  } {
    this.workItemId ??= newProtocolId("work");
    const sequence = this.nextBuildSequence++;
    return {
      workItemId: this.workItemId,
      buildAttemptId: newProtocolId("attempt"),
      sequence,
      ...base,
    };
  }

  persist(pi: ExtensionAPI): void {
    pi.appendEntry("orchestrator-state", this.snapshot());
  }

  buildGate(): { ok: boolean; reason?: string } {
    if (this.agentRunning) return { ok: false, reason: "Agent is still running" };
    if (this.build?.status === "running") return { ok: false, reason: "Build already running" };
    if (this.lockedRevision != null && this.plan && this.lockedRevision === this.plan.revision) {
      // already built this revision — allow rebuild only after returning to plan
    }
    const errors = this.plan ? validatePlan(this.plan) : [];
    return canBuild(this.plan, errors);
  }

  private unique(tools: string[]): string[] {
    return [...new Set(tools)];
  }

  private readOnlyToolSet(active: string[]): string[] {
    const kept = active.filter((t) => !WRITE_TOOLS.has(t) && t !== "dispatch_build");
    return this.unique([...kept, ...ASK_PLAN_TOOLS]);
  }

  enterAskOrPlan(pi: ExtensionAPI, mode: "ask" | "plan"): void {
    if (this.mode === "build" && this.build?.status === "running") {
      throw new Error("Cannot leave Build while a run is in progress. Cancel first.");
    }
    if (this.previousTools === undefined) {
      this.previousTools = pi.getActiveTools();
    }
    this.mode = mode;
    // Unlock previous build lock when returning to plan for edits
    if (mode === "plan") this.lockedRevision = undefined;
    pi.setActiveTools(this.readOnlyToolSet(this.previousTools));
  }

  enterAuto(pi: ExtensionAPI): void {
    if (this.build?.status === "running") {
      throw new Error("Cannot switch mode while Build is running.");
    }
    this.mode = "auto";
    if (this.previousTools) {
      pi.setActiveTools(this.previousTools);
      this.previousTools = undefined;
    }
  }

  /** User-approved Build entry. */
  enterBuild(pi: ExtensionAPI): { ok: boolean; reason?: string } {
    const gate = this.buildGate();
    if (!gate.ok) return gate;
    if (this.previousTools === undefined) {
      this.previousTools = pi.getActiveTools();
    }
    this.mode = "build";
    this.lockedRevision = this.plan!.revision;
    const base = this.previousTools.filter((t) => t !== "set_workflow_mode");
    pi.setActiveTools(
      this.unique([
        ...base.filter((t) => !ASK_PLAN_TOOLS.includes(t) || t === "read" || t === "bash" || t === "grep" || t === "find" || t === "ls"),
        ...BUILD_EXTRA_TOOLS,
        "dispatch_research",
        "submit_plan",
      ]),
    );
    return { ok: true };
  }

  exitBuildToPlan(pi: ExtensionAPI): void {
    this.enterAskOrPlan(pi, "plan");
  }

  setPlan(plan: ExecutionPlan, diff: string): void {
    this.workItemId ??= newProtocolId("work");
    this.plan = plan;
    this.revisions.push({
      revision: plan.revision,
      summary: plan.summary,
      createdAt: plan.createdAt,
      taskCount: plan.tasks.length,
      plan: JSON.parse(JSON.stringify(plan)) as ExecutionPlan,
      diff,
    });
    // Keep last 20
    if (this.revisions.length > 20) this.revisions = this.revisions.slice(-20);
  }

  statusLine(themeFg: (color: string, text: string) => string): string | undefined {
    if (this.mode === "auto" && !this.plan) return undefined;
    const modeLabel =
      this.mode === "ask"
        ? themeFg("warning", "ask")
        : this.mode === "plan"
          ? themeFg("accent", "plan")
          : this.mode === "build"
            ? themeFg("success", "build")
            : themeFg("muted", "auto");
    const rev = this.plan ? ` r${this.plan.revision}` : "";
    const gate = this.buildGate();
    const buildHint = this.mode === "plan" || this.mode === "ask"
      ? gate.ok
        ? themeFg("success", " · build ready")
        : themeFg("dim", ` · ${gate.reason ?? ""}`)
      : "";
    return `${modeLabel}${themeFg("dim", rev)}${buildHint}`;
  }
}

export function modeContractPrompt(ctrl: WorkflowController): string {
  const mode = ctrl.mode;
  const planSummary = ctrl.plan
    ? `Current plan revision: r${ctrl.plan.revision}\nSummary: ${ctrl.plan.summary}\nOpen questions: ${
        ctrl.plan.openQuestions.length ? ctrl.plan.openQuestions.map((q) => `- ${q}`).join("\n") : "(none)"
      }\nTasks:\n${ctrl.plan.tasks
        .map(
          (t) =>
            `- ${t.id} [${t.kind}/${t.agent}] deps=${(t.dependsOn || []).join(",") || "-"} paths=${
              (t.allowedPaths || []).join(",") || "-"
            }\n  ${t.goal}`,
        )
        .join("\n")}`
    : "No plan artifact yet.";

  if (mode === "ask") {
    return `[ORCHESTRATOR MODE: ASK]
Read-only dialogue. You may explain and investigate with read-only tools.
Use set_workflow_mode to switch to plan when implementation planning is needed.
You CANNOT enable write tools. To request implementation, tell the user to click Build or run /build after a valid plan exists.
Do not call set_workflow_mode with build — it will be rejected.

${planSummary}`;
  }

  if (mode === "plan") {
    return `[ORCHESTRATOR MODE: PLAN]
Read-only planning. Explore with read-only tools and dispatch_research for parallel scouts.
Use questionnaire or list openQuestions for clarifications.
When ready, call submit_plan with a structured ExecutionPlan. Revise the existing plan in place across turns; do not restart from scratch unless the user asks.
You CANNOT enable writes. After a valid plan with no open questions, ask the user to click Build or run /build.
Never call set_workflow_mode with build.

${planSummary}`;
  }

  if (mode === "build") {
    return `[ORCHESTRATOR MODE: BUILD]
User approved build for plan revision r${ctrl.plan?.revision}.
Prefer dispatching planned tasks via the build scheduler rather than editing everything yourself.
After workers finish, review results, run checks if needed, and report to the user.
If the plan must change, tell the user to return to Plan (/plan) — do not silently rewrite the locked revision.

${planSummary}`;
  }

  // auto
  return `[ORCHESTRATOR MODE: AUTO]
You are the foreground orchestrator.
- For explanations / Q&A: call set_workflow_mode({ mode: "ask" }) then answer.
- For non-trivial implementation work, ambiguous requirements, or explicit planning requests: call set_workflow_mode({ mode: "plan" }) and produce a structured plan via submit_plan.
- You may NOT enter build yourself. After a valid plan, ask the user to click Build or run /build.
Available research agents can be used via dispatch_research once in ask/plan.

${planSummary}`;
}

export function notifyMode(ctx: ExtensionContext, mode: WorkflowMode, detail?: string): void {
  if (!ctx.hasUI) return;
  const msg =
    mode === "ask"
      ? "Ask mode (read-only)"
      : mode === "plan"
        ? "Plan mode (read-only)"
        : mode === "build"
          ? "Build mode"
          : "Auto mode";
  ctx.ui.notify(detail ? `${msg}: ${detail}` : msg, "info");
}
