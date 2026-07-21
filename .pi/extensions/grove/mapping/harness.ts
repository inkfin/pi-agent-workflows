/**
 * grove/mapping/harness.ts — agent_settled auto snapshot + replace detection
 */

import type { TreeBackend, GroveNode } from "../backend/types";
import { codeState } from "../lib/identity";
import { loadProjectSettings } from "../lib/settings";
import { canAutoAmend, nodeAtChange, recordOrAmendAuto } from "./ops";
import { OperationCoordinator } from "./coordinator";

const REPLACE_RE =
  /(你做的不对|覆盖|重做|重来|不对|改错了|撤销上|redo|rework|overwrite|wrong|try again|that'?s wrong|fix that|start over)/i;

export function looksLikeReplacement(prompt: string): boolean {
  return REPLACE_RE.test(prompt.trim());
}

/**
 * Auto snapshot only when the working tree is dirty (material file changes).
 * Plans / Q&A / clean read-only research do not create nodes.
 */
export function shouldAutoSnapshot(
  cwd: string,
  _nodes: GroveNode[],
  _currentChangeId: string,
): { ok: true; reason: string } | { ok: false; reason: string } {
  const settings = loadProjectSettings(cwd);
  if (settings.autoSnapshot === false) return { ok: false, reason: "autoSnapshot disabled" };
  const code = codeState(cwd);
  if (!code) return { ok: false, reason: "not a git repo" };
  if (!code.dirty) return { ok: false, reason: "working tree clean" };
  return { ok: true, reason: "dirty working tree" };
}

export async function onAgentSettled(
  be: TreeBackend,
  cwd: string,
  opts: { sessionFile: string | null; entryId: string | null },
): Promise<GroveNode | null> {
  if (!opts.sessionFile) return null;
  const nodes = await be.listNodes();
  const current = await be.currentChangeId();
  const gate = shouldAutoSnapshot(cwd, nodes, current);
  if (!gate.ok) return null;

  const coord = new OperationCoordinator(be);
  const replaceTarget = coord.getReplaceTarget();
  let amendId: string | null = null;
  let supersedes: string | null = null;

  if (replaceTarget) {
    const can = canAutoAmend(nodes, replaceTarget);
    if (can.ok) amendId = replaceTarget;
    else supersedes = replaceTarget;
    coord.setReplaceTarget(null);
  } else {
    const tip = nodeAtChange(nodes, current);
    if (tip?.manifest?.kind === "auto" && canAutoAmend(nodes, tip.changeId).ok) {
      amendId = tip.changeId;
    }
  }

  return recordOrAmendAuto(be, cwd, {
    sessionFile: opts.sessionFile,
    entryId: opts.entryId,
    replaceChangeId: amendId,
    supersedes,
  });
}

export async function autoAction(
  be: TreeBackend,
  _cwd: string,
  action: "keep" | "replace" | "split",
  changeId: string,
): Promise<string> {
  const nodes = await be.listNodes();
  const node = nodeAtChange(nodes, changeId);
  if (!node?.manifest) throw new Error(`Node not found: ${changeId}`);
  const coord = new OperationCoordinator(be);

  switch (action) {
    case "keep": {
      if (node.manifest.lifecycle === "draft") {
        await be.amendNode({
          changeId,
          manifest: { ...node.manifest, lifecycle: "pinned" },
        });
      }
      coord.setReplaceTarget(null);
      return `kept / pinned ${node.manifest.label}`;
    }
    case "replace": {
      const can = canAutoAmend(nodes, changeId);
      coord.setReplaceTarget(changeId);
      if (!can.ok) return `replace armed (will supersede — ${can.reason})`;
      return `replace armed for ${changeId.slice(0, 8)}`;
    }
    case "split": {
      coord.setReplaceTarget(null);
      return `split: next auto will create a new node (supersedes ${changeId.slice(0, 8)})`;
    }
    default:
      throw new Error(`Unknown auto action: ${action}`);
  }
}
