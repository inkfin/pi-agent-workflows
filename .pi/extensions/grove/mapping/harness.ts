/**
 * Legacy dirty-worktree harness and explicit draft actions.
 *
 * Orchestrator outcome proposals are consumed by capture.ts before this
 * fallback is considered.
 */

import type { GroveGraph, SessionNode, TreeBackend } from "../backend/types";
import { codeState } from "../lib/identity";
import { loadProjectSettings } from "../lib/settings";
import { canAutoAmend, pinNode, recordOrAmendAuto } from "./ops";
import { OperationCoordinator } from "./coordinator";

const REPLACE_RE =
  /(你做的不对|覆盖|重做|重来|不对|改错了|撤销上|redo|rework|overwrite|wrong|try again|that'?s wrong|fix that|start over)/i;

export function looksLikeReplacement(prompt: string): boolean {
  return REPLACE_RE.test(prompt.trim());
}

export function shouldRunLegacyHarness(cwd: string, hasOutcomeLedger: boolean): boolean {
  const settings = loadProjectSettings(cwd);
  const mode = settings.trackingMode ?? "auto";
  if (mode === "off" || mode === "outcome") return false;
  if (mode === "legacy") return true;
  return !hasOutcomeLedger;
}

export function shouldAutoSnapshot(
  cwd: string,
): { ok: true; reason: string } | { ok: false; reason: string } {
  const settings = loadProjectSettings(cwd);
  if (settings.autoSnapshot === false) return { ok: false, reason: "autoSnapshot disabled" };
  const code = codeState(cwd);
  if (!code) return { ok: false, reason: "not a git repo" };
  if (!code.dirty) return { ok: false, reason: "working tree clean" };
  return { ok: true, reason: "dirty working tree" };
}

function nodeAtBackendCursor(graph: GroveGraph, changeId: string): SessionNode | undefined {
  return graph.nodes.find((node) => node.backendRef.changeId === changeId);
}

export async function onLegacyAgentSettled(
  backend: TreeBackend,
  cwd: string,
  opts: { sessionFile: string | null; entryId: string | null },
): Promise<SessionNode | null> {
  if (!opts.sessionFile) return null;
  const gate = shouldAutoSnapshot(cwd);
  if (!gate.ok) return null;
  const graph = await backend.getGraph();
  const coordinator = new OperationCoordinator(backend);
  const replaceTarget = coordinator.getReplaceTarget();
  let amendNodeId: string | null = null;
  let supersedesNodeId: string | null = null;

  if (replaceTarget) {
    const amendable = canAutoAmend(graph, replaceTarget);
    if (amendable.ok) amendNodeId = replaceTarget;
    else supersedesNodeId = replaceTarget;
    coordinator.setReplaceTarget(null);
  } else {
    const tip = nodeAtBackendCursor(graph, await backend.currentChangeId());
    if (tip && canAutoAmend(graph, tip.nodeId).ok) amendNodeId = tip.nodeId;
  }

  return recordOrAmendAuto(backend, cwd, {
    sessionFile: opts.sessionFile,
    entryId: opts.entryId,
    replaceNodeId: amendNodeId,
    supersedesNodeId,
  });
}

export async function autoAction(
  backend: TreeBackend,
  action: "keep" | "replace" | "split",
  nodeId: string,
): Promise<string> {
  const graph = await backend.getGraph();
  const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node) throw new Error(`Node not found: ${nodeId}`);
  const coordinator = new OperationCoordinator(backend);

  switch (action) {
    case "keep": {
      if (!node.pinned) await pinNode(backend, node.nodeId);
      coordinator.setReplaceTarget(null);
      return `kept / pinned ${node.label}`;
    }
    case "replace": {
      const amendable = canAutoAmend(graph, nodeId);
      coordinator.setReplaceTarget(nodeId);
      return amendable.ok
        ? `replace armed for ${nodeId.slice(0, 12)}`
        : `replace armed (will supersede — ${amendable.reason})`;
    }
    case "split":
      coordinator.setReplaceTarget(null);
      return `split: next legacy capture will create a sibling of ${nodeId.slice(0, 12)}`;
  }
}
