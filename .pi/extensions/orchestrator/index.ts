/**
 * orchestrator/index.ts — Cursor-style Ask → Plan → Build for Pi
 *
 * Foreground model orchestrates; workers run as `pi --mode json` subprocesses.
 * Ask/Plan are read-only; only explicit user Build enables writes + DAG execution.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Key, Text } from "@earendil-works/pi-tui";
import { discoverAgents, formatAgentList } from "./lib/agents";
import { loadConfig } from "./lib/config";
import { normalizeIncomingPlan, planDiffSummary, validatePlan } from "./lib/plan";
import { isFailedResult, mapWithConcurrencyLimit, runSubagent, truncateOutput } from "./lib/runner";
import { isSafeCommand } from "./lib/safe-commands";
import { cleanupLeftovers, executePlan } from "./lib/scheduler";
import { confirmBuild, updatePanel } from "./lib/ui";
import { modeContractPrompt, notifyMode, WorkflowController } from "./lib/workflow";
import { currentHeadSha, listLeftoverOrchWorktrees, gitRoot } from "./lib/worktree";
import {
  contentHash,
  GROVE_ATTACHMENT_PROPOSAL_ENTRY,
  GROVE_PROPOSAL_PENDING_EVENT,
  newProtocolId,
  ORCHESTRATOR_RUN_ENTRY,
  OUTCOME_PROTOCOL_VERSION,
  outcomeSlotId,
  type AttachmentProposal,
  type BuildAttemptFinishedEvent,
  type BuildAttemptStartedEvent,
  type PlanRevisionRunEvent,
  type RunEvent,
} from "../shared/outcomes";
import type { BuildRunState } from "./types";
import { JjCliBackend } from "../grove/backend/jj-cli";
import { projectInfo } from "../grove/lib/identity";

const ctrl = new WorkflowController();
let lastUiCtx: ExtensionContext | undefined;
const approvedProjectAgentFiles = new Set<string>();
const summarizedBuildAttempts = new Set<string>();

function sessionId(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager as any;
  const file = manager.getSessionFile?.();
  return file ? path.basename(file) : String(manager.getSessionId?.() ?? "unsaved-session");
}

async function resolveBaseNodeId(ctx: ExtensionContext, entries: any[]): Promise<string | null> {
  const groveStateTypes = new Set(["grove-state", "grove-current-node", "grove-node"]);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.type !== "custom" || !groveStateTypes.has(entry.customType)) continue;
    const id = entry.data?.currentNodeId ?? entry.data?.nodeId;
    if (typeof id === "string" && id) return id;
  }
  try {
    const backend = new JjCliBackend(ctx.cwd);
    const [graph, currentChangeId] = await Promise.all([
      backend.getGraph(),
      backend.currentChangeId(),
    ]);
    const current = graph.nodes.find(
      (node) => node.backendRef.changeId === currentChangeId,
    );
    if (current) return current.nodeId;
    return (
      graph.nodes
        .filter((node) => node.sessionId === sessionId(ctx))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.nodeId ??
      null
    );
  } catch {
    return null;
  }
}

function appendRunEvent(pi: ExtensionAPI, event: RunEvent): void {
  pi.appendEntry(ORCHESTRATOR_RUN_ENTRY, event);
}

function durableBuildOutcome(build: BuildRunState) {
  return {
    workItemId: build.workItemId,
    buildAttemptId: build.buildAttemptId,
    sequence: build.sequence,
    planRevision: build.planRevision,
    status: build.status,
    baseNodeId: build.baseNodeId,
    baseCodeRevision: build.baseCodeRevision,
    workspaceEffect: build.workspaceEffect,
    startedAt: build.startedAt,
    finishedAt: build.finishedAt,
    integrateError: build.integrateError,
    tasks: build.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      agent: task.agent,
      kind: task.kind,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      model: task.model,
      baseCodeRevision: task.baseCodeRevision,
      resultRevision: task.resultRevision,
      summary: task.summary,
      error: task.error,
    })),
  };
}

function proposalFor(
  event: BuildAttemptFinishedEvent,
  projectId: string,
): AttachmentProposal {
  const payload = event.outcome;
  return {
    v: OUTCOME_PROTOCOL_VERSION,
    type: "attachment_proposal",
    eventId: `event_${contentHash({
      sourceEventId: event.eventId,
      kind: "execution_outcome",
    }).slice(0, 32)}`,
    sourceEventId: event.eventId,
    occurredAt: event.occurredAt,
    sessionId: event.sessionId,
    projectId,
    slotId: outcomeSlotId(event),
    workItemId: event.workItemId,
    buildAttemptId: event.buildAttemptId,
    planRevision: event.planRevision,
    sequence: event.sequence,
    baseNodeId: event.baseNodeId,
    baseCodeRevision: event.baseCodeRevision,
    kind: "execution_outcome",
    producer: { extension: "orchestrator", sourceId: event.buildAttemptId },
    contentHash: contentHash(payload),
    payload,
  };
}

function executionPlanProposal(
  event: BuildAttemptFinishedEvent,
  projectId: string,
  plan: unknown,
): AttachmentProposal {
  const payload = plan;
  return {
    v: OUTCOME_PROTOCOL_VERSION,
    type: "attachment_proposal",
    eventId: `event_${contentHash({
      buildAttemptId: event.buildAttemptId,
      kind: "execution_plan",
      payload,
    }).slice(0, 32)}`,
    sourceEventId: `plan:${event.buildAttemptId}`,
    occurredAt: event.occurredAt,
    sessionId: event.sessionId,
    projectId,
    slotId: outcomeSlotId(event),
    workItemId: event.workItemId,
    buildAttemptId: event.buildAttemptId,
    planRevision: event.planRevision,
    sequence: event.sequence,
    baseNodeId: event.baseNodeId,
    baseCodeRevision: event.baseCodeRevision,
    kind: "execution_plan",
    producer: { extension: "orchestrator", sourceId: event.buildAttemptId },
    contentHash: contentHash(payload),
    payload,
  };
}

function appendProposal(pi: ExtensionAPI, proposal: AttachmentProposal): void {
  // Durable session WAL first. EventBus is deliberately only a lossy hint.
  pi.appendEntry(GROVE_ATTACHMENT_PROPOSAL_ENTRY, proposal);
  try {
    (pi as any).events?.emit?.(GROVE_PROPOSAL_PENDING_EVENT, {
      v: OUTCOME_PROTOCOL_VERSION,
      sessionId: proposal.sessionId,
      eventId: proposal.eventId,
    });
  } catch {
    /* a failed hint cannot invalidate the durable proposal */
  }
}

function assistantSummary(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
    };
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text!.trim())
        .filter(Boolean)
        .join("\n\n");
      if (text) return text;
    }
  }
  return null;
}

function summaryProposal(
  build: BuildRunState,
  ctx: ExtensionContext,
  text: string,
): AttachmentProposal {
  const payload = { text };
  return {
    v: OUTCOME_PROTOCOL_VERSION,
    type: "attachment_proposal",
    eventId: `event_${contentHash({
      buildAttemptId: build.buildAttemptId,
      kind: "summary",
      payload,
    }).slice(0, 32)}`,
    sourceEventId: `summary:${build.buildAttemptId}`,
    occurredAt: new Date().toISOString(),
    sessionId: sessionId(ctx),
    projectId: projectInfo(ctx.cwd).projectId,
    slotId: outcomeSlotId({
      sessionId: sessionId(ctx),
      baseNodeId: build.baseNodeId,
      workItemId: build.workItemId,
    }),
    workItemId: build.workItemId,
    buildAttemptId: build.buildAttemptId,
    planRevision: build.planRevision,
    sequence: build.sequence,
    baseNodeId: build.baseNodeId,
    baseCodeRevision: build.baseCodeRevision,
    kind: "summary",
    producer: { extension: "orchestrator", sourceId: build.buildAttemptId },
    contentHash: contentHash(payload),
    payload,
  };
}

function refreshUi(ctx?: ExtensionContext): void {
  const c = ctx ?? lastUiCtx;
  if (c) {
    lastUiCtx = c;
    updatePanel(c, ctrl);
  }
}

function applyPreferredModel(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const config = loadConfig(ctx.cwd);
  if (!config.foregroundModel) return;
  const raw = config.foregroundModel;
  const [provider, ...rest] = raw.includes("/") ? raw.split("/") : [undefined, raw];
  const id = rest.join("/") || raw;
  try {
    const model = provider
      ? ctx.modelRegistry.find(provider, id)
      : undefined;
    if (!model) {
      ctx.ui.notify(`orchestrator: preferred model ${raw} not found; keeping current`, "warning");
      return;
    }
    void pi.setModel(model).then((ok) => {
      if (!ok) ctx.ui.notify(`orchestrator: no API key for ${raw}; keeping current`, "warning");
    });
  } catch {
    ctx.ui.notify(`orchestrator: could not set model ${raw}`, "warning");
  }
  if (config.foregroundThinking) {
    try {
      pi.setThinkingLevel(config.foregroundThinking);
    } catch {
      /* ignore */
    }
  }
}

function currentModelPattern(ctx: ExtensionContext): string | undefined {
  const model = ctx.model as { provider?: string; id?: string } | undefined;
  if (!model?.id) return undefined;
  return model.provider ? `${model.provider}/${model.id}` : model.id;
}

async function confirmProjectAgents(
  ctx: ExtensionContext,
  agents: ReturnType<typeof discoverAgents>["agents"],
  requestedNames: string[],
): Promise<boolean> {
  const requested = [...new Set(requestedNames)]
    .map((name) => agents.find((agent) => agent.name === name))
    .filter(
      (agent): agent is NonNullable<typeof agent> =>
        Boolean(
          agent?.source === "project" &&
            !approvedProjectAgentFiles.has(agent.filePath),
        ),
    );
  if (!requested.length) return true;
  if (!ctx.hasUI) {
    ctx.ui.notify(
      `Project agents require interactive approval: ${requested.map((agent) => agent.name).join(", ")}`,
      "error",
    );
    return false;
  }
  const accepted = await ctx.ui.confirm(
    "Run project-local agents?",
    [
      `Agents: ${requested.map((agent) => agent.name).join(", ")}`,
      `Files:\n${requested.map((agent) => `- ${agent.filePath}`).join("\n")}`,
      "",
      "Project profiles are repository-controlled. Approve only trusted code.",
    ].join("\n"),
  );
  if (accepted) {
    for (const agent of requested) approvedProjectAgentFiles.add(agent.filePath);
  }
  return Boolean(accepted);
}

export default function (pi: ExtensionAPI) {
  // ── Tools ────────────────────────────────────────────────

  pi.registerTool({
    name: "set_workflow_mode",
    label: "Set Workflow Mode",
    description:
      "Switch orchestrator mode. Allowed: ask, plan, auto. " +
      "build is rejected — the user must click Build or run /build.",
    promptSnippet: "Enter ask or plan mode (never build)",
    promptGuidelines: [
      "Use set_workflow_mode to enter ask for Q&A or plan for implementation planning.",
      "Never request build via set_workflow_mode; ask the user to Build after submit_plan.",
    ],
    parameters: Type.Object({
      mode: StringEnum(["ask", "plan", "auto", "build"] as const, {
        description: "Target mode",
      }),
      reason: Type.Optional(Type.String({ description: "Why switching" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      lastUiCtx = ctx;
      if (params.mode === "build") {
        refreshUi(ctx);
        return {
          content: [
            {
              type: "text",
              text:
                "Rejected: agents cannot enter Build. Ask the user to click Build or run /build after a valid plan with no open questions.",
            },
          ],
          details: { rejected: true },
          isError: true,
        };
      }
      try {
        if (params.mode === "auto") ctrl.enterAuto(pi);
        else ctrl.enterAskOrPlan(pi, params.mode);
        ctrl.persist(pi);
        refreshUi(ctx);
        notifyMode(ctx, params.mode, params.reason);
        return {
          content: [{ type: "text", text: `Mode is now ${params.mode}.` }],
          details: { mode: params.mode },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: err?.message ?? String(err) }],
          details: {},
          isError: true,
        };
      }
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("mode ")) + theme.fg("accent", String(args.mode)),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "submit_plan",
    label: "Submit Plan",
    description:
      "Create or replace the structured ExecutionPlan shown in the plan panel. " +
      "Incrementally revise across turns. Leave openQuestions empty only when ready to Build.",
    promptSnippet: "Publish or revise the ExecutionPlan artifact",
    promptGuidelines: [
      "Use submit_plan whenever the plan changes. Include task ids, kinds, agents, dependsOn, and allowedPaths for edit tasks.",
      "Keep openQuestions non-empty while clarifications remain; Build stays disabled until they are cleared.",
    ],
    parameters: Type.Object({
      summary: Type.String({ description: "One-paragraph plan summary" }),
      goal: Type.Optional(Type.String()),
      openQuestions: Type.Optional(Type.Array(Type.String())),
      tasks: Type.Array(
        Type.Object({
          id: Type.String(),
          kind: StringEnum(["research", "edit", "review", "test"] as const),
          agent: Type.String(),
          goal: Type.String(),
          dependsOn: Type.Optional(Type.Array(Type.String())),
          allowedPaths: Type.Optional(Type.Array(Type.String())),
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      lastUiCtx = ctx;
      if (ctrl.mode === "auto") {
        ctrl.enterAskOrPlan(pi, "plan");
      }
      if (ctrl.mode === "build") {
        return {
          content: [
            {
              type: "text",
              text: "Plan is locked during Build. Return to Plan (/plan) before revising.",
            },
          ],
          details: {},
          isError: true,
        };
      }
      const next = normalizeIncomingPlan(params as any, ctrl.plan);
      const errors = validatePlan(next);
      const diff = planDiffSummary(ctrl.plan, next);
      ctrl.setPlan(next, diff);
      if (ctrl.mode !== "plan") ctrl.enterAskOrPlan(pi, "plan");
      const planEvent: PlanRevisionRunEvent = {
        v: OUTCOME_PROTOCOL_VERSION,
        type: "plan_revision_published",
        eventId: newProtocolId("event"),
        occurredAt: next.createdAt,
        sessionId: sessionId(ctx),
        workItemId: ctrl.workItemId!,
        planRevision: next.revision,
        contentHash: contentHash(next),
        plan: next,
      };
      appendRunEvent(pi, planEvent);
      ctrl.persist(pi);
      refreshUi(ctx);
      const gate = ctrl.buildGate();
      return {
        content: [
          {
            type: "text",
            text: [
              `Accepted plan r${next.revision}.`,
              diff,
              errors.length ? `Validation errors:\n${errors.map((e) => `- ${e.message}`).join("\n")}` : "Validation: ok",
              gate.ok
                ? "Build is ready — ask the user to click Build or run /build."
                : `Build disabled: ${gate.reason}`,
            ].join("\n"),
          },
        ],
        details: { revision: next.revision, errors, buildReady: gate.ok },
      };
    },
    renderCall(args, theme) {
      const n = Array.isArray(args.tasks) ? args.tasks.length : 0;
      return new Text(
        theme.fg("toolTitle", theme.bold("submit_plan ")) +
          theme.fg("accent", `${n} tasks`) +
          theme.fg("dim", args.summary ? ` ${String(args.summary).slice(0, 40)}` : ""),
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "dispatch_research",
    label: "Dispatch Research",
    description:
      "Run one or more read-only research/review subagents in parallel on the current workspace. " +
      "Available in Ask/Plan. Not for file edits.",
    promptSnippet: "Parallel read-only scout/review workers",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          agent: Type.String({ description: "Usually scout or reviewer" }),
          task: Type.String(),
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      lastUiCtx = ctx;
      const config = loadConfig(ctx.cwd);
      if (params.tasks.length > config.maxTasks) {
        return {
          content: [{ type: "text", text: `Too many tasks (max ${config.maxTasks}).` }],
          details: {},
          isError: true,
        };
      }
      const { agents } = discoverAgents(ctx.cwd, config.agentScope);
      if (
        !(await confirmProjectAgents(
          ctx,
          agents,
          params.tasks.map((task) => task.agent),
        ))
      ) {
        return {
          content: [{ type: "text", text: "Project-agent execution was not approved." }],
          details: {},
          isError: true,
        };
      }
      const inheritedModel = config.workerModel ?? currentModelPattern(ctx);
      const results = await mapWithConcurrencyLimit(params.tasks, config.maxParallel, async (t) => {
        const agent = agents.find((a) => a.name === t.agent);
        if (!agent) {
          return {
            agent: t.agent,
            ok: false,
            text: `Unknown agent "${t.agent}". Available: ${formatAgentList(agents)}`,
          };
        }
        if (agent.mutating) {
          return {
            agent: t.agent,
            ok: false,
            text: `Agent "${t.agent}" is mutating; use Build for edit workers.`,
          };
        }
        const tools = agent.tools ?? ["read", "grep", "find", "ls", "bash"];
        const result = await runSubagent({
          cwd: ctx.cwd,
          agent: { ...agent, tools },
          task: t.task,
          modelOverride: inheritedModel,
          signal,
          timeoutMs: config.taskTimeoutMs,
          mutating: false,
          onUpdate: (partial) => {
            onUpdate?.({
              content: [{ type: "text", text: truncateOutput(partial.stdoutText || "(running…)") }],
              details: { agent: t.agent, preview: partial.stdoutText },
            });
          },
        });
        const failed = isFailedResult(result);
        return {
          agent: t.agent,
          ok: !failed,
          text: failed
            ? result.errorMessage || result.stderr || `exit ${result.exitCode}`
            : result.stdoutText || "(no output)",
          model: result.model,
        };
      });

      const body = results
        .map((r, i) => `### ${i + 1}. ${r.agent} ${r.ok ? "ok" : "FAIL"}\n${r.text}`)
        .join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: body }],
        details: { results },
        isError: results.some((r) => !r.ok),
      };
    },
    renderCall(args, theme) {
      const n = Array.isArray(args.tasks) ? args.tasks.length : 0;
      return new Text(
        theme.fg("toolTitle", theme.bold("research ")) + theme.fg("accent", `${n} parallel`),
        0,
        0,
      );
    },
  });

  // ── Commands ─────────────────────────────────────────────

  async function startBuild(ctx: ExtensionContext): Promise<void> {
    lastUiCtx = ctx;
    const gate = ctrl.buildGate();
    if (!gate.ok) {
      ctx.ui.notify(gate.reason ?? "Build disabled", "error");
      return;
    }
    const ok = await confirmBuild(ctx, ctrl);
    if (!ok) return;

    const config = loadConfig(ctx.cwd);
    const { agents } = discoverAgents(ctx.cwd, config.agentScope);
    if (
      !(await confirmProjectAgents(
        ctx,
        agents,
        ctrl.plan!.tasks.map((task) => task.agent),
      ))
    ) {
      return;
    }

    const entered = ctrl.enterBuild(pi);
    if (!entered.ok) {
      ctx.ui.notify(entered.reason ?? "Cannot enter Build", "error");
      return;
    }
    const entries = ctx.sessionManager.getEntries() as any[];
    const root = gitRoot(ctx.cwd);
    const attempt = ctrl.beginBuildAttempt({
      baseNodeId: await resolveBaseNodeId(ctx, entries),
      baseCodeRevision: root ? currentHeadSha(root) : null,
    });
    const startedAt = new Date().toISOString();
    ctrl.build = {
      ...attempt,
      planRevision: ctrl.plan!.revision,
      status: "running",
      workspaceEffect: "none",
      startedAt,
      tasks: ctrl.plan!.tasks.map((task) => ({
        id: task.id,
        status: "pending",
        agent: task.agent,
        kind: task.kind,
      })),
      leftoverWorktrees: [],
    };
    const startedEvent: BuildAttemptStartedEvent = {
      v: OUTCOME_PROTOCOL_VERSION,
      type: "build_attempt_started",
      eventId: newProtocolId("event"),
      occurredAt: startedAt,
      sessionId: sessionId(ctx),
      planRevision: ctrl.plan!.revision,
      status: "running",
      ...attempt,
    };
    appendRunEvent(pi, startedEvent);
    ctrl.persist(pi);
    refreshUi(ctx);

    ctrl.abort = new AbortController();

    ctx.ui.notify(`Building plan r${ctrl.plan!.revision}…`, "info");
    let build: BuildRunState;
    try {
      build = await executePlan({
        cwd: ctx.cwd,
        plan: ctrl.plan!,
        config,
        ...attempt,
        signal: ctrl.abort.signal,
        hooks: {
          onUpdate: (b) => {
            ctrl.build = b;
            refreshUi(ctx);
          },
          resolveAgent: (name) => agents.find((a) => a.name === name),
          researchTools: ["read", "grep", "find", "ls", "bash"],
          editTools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
          modelOverride: config.workerModel ?? currentModelPattern(ctx),
        },
      });
    } catch (error: any) {
      build = {
        ...ctrl.build!,
        status: ctrl.abort.signal.aborted ? "cancelled" : "failed",
        finishedAt: new Date().toISOString(),
        integrateError: error?.message ?? String(error),
      };
    }
    ctrl.build = build;
    ctrl.abort = undefined;
    const finishedEvent: BuildAttemptFinishedEvent = {
      v: OUTCOME_PROTOCOL_VERSION,
      type: "build_attempt_finished",
      eventId: newProtocolId("event"),
      occurredAt: build.finishedAt ?? new Date().toISOString(),
      sessionId: startedEvent.sessionId,
      workItemId: build.workItemId,
      buildAttemptId: build.buildAttemptId,
      planRevision: build.planRevision,
      sequence: build.sequence,
      baseNodeId: build.baseNodeId,
      baseCodeRevision: build.baseCodeRevision,
      status: build.status === "idle" || build.status === "running" ? "failed" : build.status,
      workspaceEffect: build.workspaceEffect,
      outcome: durableBuildOutcome(build),
      error: build.integrateError,
    };
    appendRunEvent(pi, finishedEvent);
    if (finishedEvent.status === "succeeded") {
      const projectId = projectInfo(ctx.cwd).projectId;
      appendProposal(pi, proposalFor(finishedEvent, projectId));
      appendProposal(pi, executionPlanProposal(finishedEvent, projectId, ctrl.plan));
      ctrl.pendingSummaryAttemptId = finishedEvent.buildAttemptId;
    } else {
      ctrl.pendingSummaryAttemptId = undefined;
    }
    ctrl.persist(pi);
    refreshUi(ctx);

    if (build.status === "succeeded") {
      ctx.ui.notify("Build integrated as unstaged changes. Review before committing.", "success");
      pi.sendMessage(
        {
          customType: "orchestrator-build-done",
          content: [
            `Build of plan r${build.planRevision} succeeded.`,
            "Changes are in the working tree as unstaged edits (not committed).",
            "Review the diff, run checks if needed, and report results to the user.",
            build.tasks
              .map((t) => `- ${t.id}: ${t.status}${t.summary ? ` — ${t.summary.slice(0, 120)}` : ""}`)
              .join("\n"),
          ].join("\n"),
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } else if (build.status === "cancelled") {
      ctx.ui.notify("Build cancelled.", "warning");
    } else {
      ctx.ui.notify(build.integrateError || "Build failed.", "error");
      if (build.leftoverWorktrees.length) {
        ctx.ui.notify(
          `Leftover worktrees kept for inspect: ${build.leftoverWorktrees.length}. Use /orchestrator cleanup`,
          "warning",
        );
      }
    }
  }

  pi.registerShortcut(Key.ctrlAlt("b"), {
    description: "Build current orchestrator plan",
    handler: async (ctx) => {
      await startBuild(ctx);
    },
  });

  pi.registerCommand("plan", {
    description: "Enter Plan mode (read-only). Optional goal starts a turn.",
    handler: async (args, ctx) => {
      lastUiCtx = ctx;
      const goal = args.trim();
      if (goal) ctrl.startWorkItem();
      ctrl.enterAskOrPlan(pi, "plan");
      applyPreferredModel(pi, ctx);
      ctrl.persist(pi);
      refreshUi(ctx);
      notifyMode(ctx, "plan");
      if (goal) {
        pi.sendMessage(
          {
            customType: "orchestrator-plan-goal",
            content: `Create an implementation plan for this new work item:\n\n${goal}\n\nExplore as needed, ask clarifying questions, then call submit_plan.`,
            display: true,
          },
          { triggerTurn: true },
        );
      }
    },
  });

  pi.registerCommand("build", {
    description: "Approve and run the current plan revision (worktree-isolated edits)",
    handler: async (_args, ctx) => {
      await startBuild(ctx);
    },
  });

  pi.registerCommand("orchestrator", {
      description:
      "Orchestrator control: auto|ask|plan|status|actions|cancel|retry|inspect|cleanup|edit|ask-followup|agents|revisions",
    handler: async (args, ctx) => {
      lastUiCtx = ctx;
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] || "status").toLowerCase();
      const rest = parts.slice(1).join(" ");

      switch (sub) {
        case "auto":
          ctrl.enterAuto(pi);
          ctrl.persist(pi);
          refreshUi(ctx);
          notifyMode(ctx, "auto");
          return;
        case "ask":
          ctrl.enterAskOrPlan(pi, "ask");
          ctrl.persist(pi);
          refreshUi(ctx);
          notifyMode(ctx, "ask");
          return;
        case "plan":
          ctrl.enterAskOrPlan(pi, "plan");
          ctrl.persist(pi);
          refreshUi(ctx);
          notifyMode(ctx, "plan");
          return;
        case "status": {
          const gate = ctrl.buildGate();
          const lines = [
            `mode: ${ctrl.mode}`,
            ctrl.plan
              ? `plan: r${ctrl.plan.revision} · ${ctrl.plan.tasks.length} tasks · openQ=${ctrl.plan.openQuestions.length}`
              : "plan: (none)",
            `build: ${ctrl.build?.status ?? "idle"}`,
            `gate: ${gate.ok ? "ready" : gate.reason}`,
          ];
          if (ctrl.build?.tasks?.length) {
            for (const t of ctrl.build.tasks) {
              lines.push(`  ${t.id}: ${t.status}${t.error ? ` (${t.error})` : ""}`);
            }
          }
          ctx.ui.notify(lines.join("\n"), "info");
          refreshUi(ctx);
          return;
        }
        case "cancel": {
          if (ctrl.abort) {
            ctrl.abort.abort();
            ctx.ui.notify("Cancel signal sent.", "warning");
          } else {
            ctx.ui.notify("No running build.", "info");
          }
          return;
        }
        case "retry": {
          if (!ctrl.plan) {
            ctx.ui.notify("No plan to retry.", "error");
            return;
          }
          ctrl.lockedRevision = undefined;
          await startBuild(ctx);
          return;
        }
        case "inspect": {
          const leftovers = ctrl.build?.leftoverWorktrees ?? [];
          const root = gitRoot(ctx.cwd);
          const listed = root ? listLeftoverOrchWorktrees(root) : [];
          ctx.ui.notify(
            [
              `Tracked leftovers: ${leftovers.length ? leftovers.join("\n") : "(none)"}`,
              `Git worktrees matching pi-orch: ${listed.length ? listed.join("\n") : "(none)"}`,
            ].join("\n"),
            "info",
          );
          return;
        }
        case "cleanup": {
          const paths = [
            ...(ctrl.build?.leftoverWorktrees ?? []),
            ...(gitRoot(ctx.cwd) ? listLeftoverOrchWorktrees(gitRoot(ctx.cwd)!) : []),
          ];
          const unique = [...new Set(paths)];
          const remaining = await cleanupLeftovers(ctx.cwd, unique);
          if (ctrl.build) ctrl.build.leftoverWorktrees = remaining;
          ctrl.persist(pi);
          ctx.ui.notify(
            remaining.length
              ? `Cleanup partial; remaining:\n${remaining.join("\n")}`
              : "Cleanup complete.",
            remaining.length ? "warning" : "success",
          );
          return;
        }
        case "edit": {
          if (ctrl.mode === "build" && ctrl.build?.status === "running") {
            ctx.ui.notify("Cancel the build before editing the plan.", "error");
            return;
          }
          ctrl.enterAskOrPlan(pi, "plan");
          ctrl.persist(pi);
          refreshUi(ctx);
          const feedback =
            rest ||
            (ctx.hasUI
              ? await ctx.ui.editor("Edit plan feedback:", "")
              : "");
          if (feedback?.trim()) {
            pi.sendMessage(
              {
                customType: "orchestrator-edit-plan",
                content: `Revise the current plan based on this feedback:\n\n${feedback.trim()}\n\nCall submit_plan with an updated ExecutionPlan.`,
                display: true,
              },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          } else {
            ctx.ui.notify("Plan mode — send feedback in chat to revise.", "info");
          }
          return;
        }
        case "ask-followup":
        case "followup": {
          ctrl.enterAskOrPlan(pi, ctrl.plan ? "plan" : "ask");
          ctrl.persist(pi);
          refreshUi(ctx);
          const q =
            rest ||
            (ctx.hasUI ? await ctx.ui.editor("Ask follow-up:", "") : "");
          if (q?.trim()) {
            pi.sendUserMessage(q.trim(), { deliverAs: "followUp" });
          }
          return;
        }
        case "actions":
        case "panel": {
          refreshUi(ctx);
          if (!ctx.hasUI) {
            ctx.ui.notify("No TUI. Use /build, /orchestrator edit, /orchestrator ask-followup", "info");
            return;
          }
          const gate = ctrl.buildGate();
          const choice = await ctx.ui.select("Orchestrator actions", [
            gate.ok ? "Build current plan" : `Build (disabled: ${gate.reason})`,
            "Edit plan",
            "Ask follow-up",
            "Status",
            "Cancel",
          ]);
          if (!choice || choice === "Cancel") return;
          if (choice.startsWith("Build") && gate.ok) {
            await startBuild(ctx);
          } else if (choice === "Edit plan") {
            const feedback = await ctx.ui.editor("Edit plan feedback:", "");
            if (feedback?.trim()) {
              ctrl.enterAskOrPlan(pi, "plan");
              ctrl.persist(pi);
              refreshUi(ctx);
              pi.sendMessage(
                {
                  customType: "orchestrator-edit-plan",
                  content: `Revise the current plan based on this feedback:\n\n${feedback.trim()}\n\nCall submit_plan with an updated ExecutionPlan.`,
                  display: true,
                },
                { triggerTurn: true, deliverAs: "followUp" },
              );
            }
          } else if (choice === "Ask follow-up") {
            const q = await ctx.ui.editor("Ask follow-up:", "");
            if (q?.trim()) {
              ctrl.enterAskOrPlan(pi, ctrl.plan ? "plan" : "ask");
              refreshUi(ctx);
              pi.sendUserMessage(q.trim(), { deliverAs: "followUp" });
            }
          } else if (choice === "Status") {
            const lines = [
              `mode: ${ctrl.mode}`,
              ctrl.plan
                ? `plan: r${ctrl.plan.revision} · ${ctrl.plan.tasks.length} tasks`
                : "plan: (none)",
              `gate: ${gate.ok ? "ready" : gate.reason}`,
            ];
            ctx.ui.notify(lines.join("\n"), "info");
          } else if (choice.startsWith("Build")) {
            ctx.ui.notify(gate.reason ?? "Build disabled", "error");
          }
          return;
        }
        case "agents": {
          const config = loadConfig(ctx.cwd);
          const { agents } = discoverAgents(ctx.cwd, config.agentScope);
          ctx.ui.notify(formatAgentList(agents), "info");
          return;
        }
        case "revisions": {
          if (!ctrl.revisions.length) {
            ctx.ui.notify("No plan revisions.", "info");
            return;
          }
          ctx.ui.notify(
            ctrl.revisions
              .map(
                (revision) =>
                  `r${revision.revision} · ${revision.taskCount} tasks · ${revision.createdAt}\n${revision.diff}`,
              )
              .join("\n\n"),
            "info",
          );
          return;
        }
        default:
          ctx.ui.notify(
            "Usage: /orchestrator auto|ask|plan|status|actions|cancel|retry|inspect|cleanup|edit|ask-followup|agents|revisions",
            "error",
          );
      }
    },
  });

  // ── Hooks ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    lastUiCtx = ctx;
    ctrl.reset();
    approvedProjectAgentFiles.clear();
    summarizedBuildAttempts.clear();
    const entries = ctx.sessionManager.getEntries() as any[];
    for (const entry of entries) {
      if (
        entry?.type === "custom" &&
        entry.customType === GROVE_ATTACHMENT_PROPOSAL_ENTRY &&
        entry.data?.kind === "summary" &&
        typeof entry.data?.buildAttemptId === "string"
      ) {
        summarizedBuildAttempts.add(entry.data.buildAttemptId);
      }
    }
    const stateEntry = [...entries]
      .reverse()
      .find((e: any) => e.type === "custom" && e.customType === "orchestrator-state") as
      | { data?: any }
      | undefined;
    if (stateEntry?.data) {
      ctrl.restore(stateEntry.data);
      // Never resume into a mid-flight build as running
      if (ctrl.build?.status === "running") {
        ctrl.build.status = "cancelled";
        ctrl.build.finishedAt = new Date().toISOString();
      }
      if (ctrl.mode === "ask" || ctrl.mode === "plan") {
        try {
          ctrl.enterAskOrPlan(pi, ctrl.mode);
        } catch {
          /* ignore */
        }
      } else if (ctrl.mode === "build") {
        // Drop back to plan after resume; user must re-approve Build
        try {
          ctrl.enterAskOrPlan(pi, "plan");
        } catch {
          ctrl.mode = "auto";
        }
      }
    }
    if (
      ctrl.pendingSummaryAttemptId &&
      summarizedBuildAttempts.has(ctrl.pendingSummaryAttemptId)
    ) {
      ctrl.pendingSummaryAttemptId = undefined;
    }
    const runEvents = entries
      .filter(
        (entry: any) =>
          entry?.type === "custom" &&
          entry.customType === ORCHESTRATOR_RUN_ENTRY &&
          entry.data?.v === OUTCOME_PROTOCOL_VERSION,
      )
      .map((entry: any) => entry.data as RunEvent);
    const buildEvents = runEvents.filter(
      (event): event is BuildAttemptStartedEvent | BuildAttemptFinishedEvent =>
        event.type === "build_attempt_started" || event.type === "build_attempt_finished",
    );
    if (runEvents.length) {
      const latest = runEvents[runEvents.length - 1];
      ctrl.workItemId ??= latest.workItemId;
      ctrl.nextBuildSequence = Math.max(
        ctrl.nextBuildSequence,
        ...buildEvents.map((event) => event.sequence + 1),
      );
    }

    // A started event without a terminal event represents an interrupted
    // process. Close it append-only on recovery instead of rewriting history.
    const finishedAttempts = new Set(
      buildEvents
        .filter((event) => event.type === "build_attempt_finished")
        .map((event) => event.buildAttemptId),
    );
    for (const event of buildEvents) {
      if (event.type !== "build_attempt_started" || finishedAttempts.has(event.buildAttemptId)) {
        continue;
      }
      const finishedAt = new Date().toISOString();
      const recovered: BuildAttemptFinishedEvent = {
        ...event,
        type: "build_attempt_finished",
        eventId: newProtocolId("event"),
        occurredAt: finishedAt,
        status: "cancelled",
        workspaceEffect: "none",
        outcome: {
          workItemId: event.workItemId,
          buildAttemptId: event.buildAttemptId,
          sequence: event.sequence,
          planRevision: event.planRevision,
          status: "cancelled",
          baseNodeId: event.baseNodeId,
          baseCodeRevision: event.baseCodeRevision,
          workspaceEffect: "none",
          startedAt: event.occurredAt,
          finishedAt,
          tasks: [],
          integrateError: "Interrupted before a terminal event was recorded.",
        },
        error: "Interrupted before a terminal event was recorded.",
      };
      appendRunEvent(pi, recovered);
      runEvents.push(recovered);
      finishedAttempts.add(event.buildAttemptId);
    }

    // Recreate a proposal if a prior process durably recorded success but
    // stopped between the finished event and proposal append.
    const proposedSources = new Set(
      entries
        .filter(
          (entry: any) =>
            entry?.type === "custom" &&
            entry.customType === GROVE_ATTACHMENT_PROPOSAL_ENTRY,
        )
        .map((entry: any) => entry.data?.sourceEventId)
        .filter(Boolean),
    );
    const proposedKinds = new Set(
      entries
        .filter(
          (entry: any) =>
            entry?.type === "custom" &&
            entry.customType === GROVE_ATTACHMENT_PROPOSAL_ENTRY,
        )
        .map((entry: any) => `${entry.data?.kind}:${entry.data?.buildAttemptId}`),
    );
    const planEvents = runEvents.filter(
      (event): event is PlanRevisionRunEvent => event.type === "plan_revision_published",
    );
    for (const event of runEvents) {
      if (
        event.type === "build_attempt_finished" &&
        event.status === "succeeded" &&
        !proposedSources.has(event.eventId)
      ) {
        appendProposal(pi, proposalFor(event, projectInfo(ctx.cwd).projectId));
        proposedSources.add(event.eventId);
      }
      if (
        event.type === "build_attempt_finished" &&
        event.status === "succeeded" &&
        !proposedKinds.has(`execution_plan:${event.buildAttemptId}`)
      ) {
        const planEvent = [...planEvents].reverse().find(
          (candidate) =>
            candidate.workItemId === event.workItemId &&
            candidate.planRevision === event.planRevision,
        );
        if (planEvent) {
          appendProposal(
            pi,
            executionPlanProposal(event, projectInfo(ctx.cwd).projectId, planEvent.plan),
          );
          proposedKinds.add(`execution_plan:${event.buildAttemptId}`);
        }
      }
    }
    // Ensure tools registered are activatable in auto
    const active = pi.getActiveTools();
    pi.setActiveTools([...new Set([...active, "set_workflow_mode", "submit_plan", "dispatch_research"])]);
    refreshUi(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    lastUiCtx = ctx;
    ctrl.agentRunning = true;
    refreshUi(ctx);
    const contract = modeContractPrompt(ctrl);
    return {
      systemPrompt: `${event.systemPrompt || ""}\n\n${contract}`,
    };
  });

  pi.on("agent_end", async (event, ctx) => {
    lastUiCtx = ctx;
    ctrl.agentRunning = false;
    if (
      ctrl.build?.status === "succeeded" &&
      ctrl.pendingSummaryAttemptId === ctrl.build.buildAttemptId &&
      !summarizedBuildAttempts.has(ctrl.build.buildAttemptId)
    ) {
      const summary = assistantSummary(event.messages as unknown[]);
      if (summary) {
        appendProposal(pi, summaryProposal(ctrl.build, ctx, summary));
        summarizedBuildAttempts.add(ctrl.build.buildAttemptId);
        ctrl.pendingSummaryAttemptId = undefined;
      }
    }
    ctrl.persist(pi);
    refreshUi(ctx);
  });

  try {
    pi.on("agent_settled" as any, async (_event: unknown, ctx: ExtensionContext) => {
      lastUiCtx = ctx;
      ctrl.agentRunning = false;
      refreshUi(ctx);
    });
  } catch {
    /* older pi */
  }

  pi.on("tool_call", async (event) => {
    if (ctrl.mode !== "ask" && ctrl.mode !== "plan") return;
    if (event.toolName === "bash") {
      const command = String((event.input as any)?.command ?? "");
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `Orchestrator ${ctrl.mode} mode: bash command blocked (not allowlisted).\n${command}`,
        };
      }
    }
    if (WRITE_TOOLS_BLOCK.has(event.toolName)) {
      return {
        block: true,
        reason: `Orchestrator ${ctrl.mode} mode: write tool "${event.toolName}" is disabled. Submit a plan and ask the user to Build.`,
      };
    }
  });
}

const WRITE_TOOLS_BLOCK = new Set(["edit", "write", "update_glossary"]);
