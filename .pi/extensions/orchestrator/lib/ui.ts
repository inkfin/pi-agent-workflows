/**
 * orchestrator/lib/ui.ts — plan panel + build actions for TUI
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validatePlan } from "./plan";
import type { WorkflowController } from "./workflow";

export type PanelAction = "build" | "edit" | "ask" | "dismiss";

export function renderPanelLines(ctrl: WorkflowController, theme: {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}): string[] {
  const fg = theme.fg.bind(theme);
  const bold = theme.bold.bind(theme);
  const lines: string[] = [];
  const mode = ctrl.mode.toUpperCase();
  lines.push(fg("toolTitle", bold("orchestrator")) + fg("dim", ` · ${mode}`));

  if (!ctrl.plan) {
    lines.push(fg("muted", "No plan yet. Agent can enter Plan and call submit_plan."));
    lines.push(fg("dim", "[Build disabled]  [Edit plan]  [Ask follow-up]"));
    return lines;
  }

  const gate = ctrl.buildGate();
  const errors = validatePlan(ctrl.plan);
  lines.push(fg("accent", `Plan r${ctrl.plan.revision}`) + fg("dim", ` · ${ctrl.plan.tasks.length} tasks`));
  lines.push(ctrl.plan.summary);
  const latestRevision = ctrl.revisions.at(-1);
  if (latestRevision?.diff) {
    lines.push(fg("dim", `Revision: ${truncate(latestRevision.diff.replace(/\n/g, " · "), 100)}`));
  }
  if (ctrl.plan.openQuestions.length) {
    lines.push(fg("warning", "Open questions:"));
    for (const q of ctrl.plan.openQuestions.slice(0, 5)) {
      lines.push(fg("warning", `  ? ${q}`));
    }
  }
  if (errors.length) {
    lines.push(fg("error", `Validation: ${errors[0].message}`));
  }

  lines.push(fg("dim", "Tasks:"));
  for (const t of ctrl.plan.tasks.slice(0, 12)) {
    const run = ctrl.build?.tasks.find((x) => x.id === t.id);
    const st = run ? statusGlyph(run.status) : "·";
    lines.push(
      `  ${st} ${fg("accent", t.id)} ${fg("dim", `[${t.kind}/${t.agent}]`)} ${truncate(t.goal, 60)}`,
    );
  }
  if (ctrl.plan.tasks.length > 12) {
    lines.push(fg("muted", `  … +${ctrl.plan.tasks.length - 12} more`));
  }

  if (ctrl.build && ctrl.build.status !== "idle") {
    lines.push(
      fg("dim", `Build: ${ctrl.build.status}`) +
        (ctrl.build.integrateError ? fg("error", ` — ${truncate(ctrl.build.integrateError, 80)}`) : ""),
    );
  }

  const buildLabel = gate.ok
    ? fg("success", bold("[Build]"))
    : fg("dim", `[Build: ${gate.reason ?? "disabled"}]`);
  lines.push(`${buildLabel}  ${fg("accent", "[Edit plan]")}  ${fg("muted", "[Ask follow-up]")}`);
  lines.push(fg("dim", "/build · /orchestrator actions · /orchestrator edit"));
  return lines;
}

function statusGlyph(status: string): string {
  switch (status) {
    case "succeeded":
      return "✓";
    case "failed":
      return "✗";
    case "running":
      return "►";
    case "queued":
      return "…";
    case "cancelled":
      return "⊘";
    case "blocked":
      return "■";
    default:
      return "·";
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function updatePanel(ctx: ExtensionContext, ctrl: WorkflowController): void {
  if (!ctx.hasUI) return;
  const theme = ctx.ui.theme;
  ctx.ui.setWidget("orchestrator-plan", renderPanelLines(ctrl, theme));
  const status = ctrl.statusLine(theme.fg.bind(theme));
  ctx.ui.setStatus("orchestrator", status);
}

export async function confirmBuild(
  ctx: ExtensionContext,
  ctrl: WorkflowController,
): Promise<boolean> {
  if (!ctrl.plan) return false;
  const gate = ctrl.buildGate();
  if (!gate.ok) {
    ctx.ui.notify(gate.reason ?? "Build disabled", "error");
    return false;
  }
  const editCount = ctrl.plan.tasks.filter((t) => t.kind === "edit").length;
  const msg = [
    `Build plan r${ctrl.plan.revision}?`,
    `${ctrl.plan.tasks.length} tasks (${editCount} edit).`,
    "Edit tasks run in temporary git worktrees.",
    "Main branch will NOT be committed or pushed.",
  ].join("\n");
  if (!ctx.hasUI) return true;
  return Boolean(await ctx.ui.confirm("Confirm Build", msg));
}
