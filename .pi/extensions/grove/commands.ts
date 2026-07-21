/**
 * grove/commands.ts — /grove command + hooks
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { JjCliBackend, JjUnavailableError } from "./backend/jj-cli";
import type { TreeBackend, GroveNode, ForkFrom } from "./backend/types";
import {
  checkpointSession,
  recordFork,
  recordMerge,
  ensureSessionAvailable,
  nodeSummaryForInject,
  nodeAtChange,
  pinNode,
  nearestParentNode,
} from "./mapping/ops";
import { OperationCoordinator, pendingSummary } from "./mapping/coordinator";
import { onAgentSettled, looksLikeReplacement, autoAction } from "./mapping/harness";
import { syncPush, syncPull, configureSync } from "./mapping/sync";
import { publishRegistryAfterPush, flushRegistryOutbox, dashboardLines } from "./mapping/registry";
import { machineId, codeState } from "./lib/identity";
import { captureAnchor, countSessionMessages } from "./lib/sessions";
import { loadProjectSettings } from "./lib/settings";
import { GroveTreeView, type GroveViewResult } from "./ui/tree-view";

function findNode(nodes: GroveNode[], target: string): GroveNode | undefined {
  const lower = target.toLowerCase();
  return (
    nodes.find((n) => n.changeId.startsWith(target)) ??
    nodes.find((n) => n.manifest?.label === target) ??
    nodes.find((n) => n.manifest?.label.toLowerCase().includes(lower))
  );
}

export function groveStatusLabel(node: GroveNode | undefined): string {
  const m = node?.manifest;
  if (!m) return "◇ untracked";
  const glyph =
    m.kind === "root" ? "◇" :
    m.kind === "fork" ? "⑂" :
    m.kind === "context_merge" ? "⊙" :
    m.kind === "auto" ? "○" :
    m.kind === "frontier" ? "▣" :
    "◆";
  const life = m.lifecycle === "draft" ? "·draft" : "";
  return `${glyph} ${m.label}${life}`;
}

async function refreshGroveStatus(
  ctx: Pick<ExtensionCommandContext, "ui">,
  be: TreeBackend,
): Promise<void> {
  const [nodes, currentChange] = await Promise.all([be.listNodes(), be.currentChangeId()]);
  ctx.ui.setStatus("grove", groveStatusLabel(nodeAtChange(nodes, currentChange)));
}

export function setupGrove(pi: ExtensionAPI) {
  let backend: TreeBackend | null = null;
  let backendCwd: string | null = null;

  function getBackend(cwd: string): TreeBackend {
    if (!backend || backendCwd !== cwd) {
      backend = new JjCliBackend(cwd);
      backendCwd = cwd;
    }
    return backend;
  }

  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const be = getBackend(ctx.cwd);
    if (!fs.existsSync(path.join(be.repoDir(), ".jj"))) return;
    try {
      await JjCliBackend.checkAvailability();
    } catch {
      return;
    }

    const pending = pendingSummary(be.repoDir());
    if (pending && ctx.hasUI) {
      ctx.ui.notify(`grove: ${pending}`, "warning");
    }

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (event.reason === "fork" && sessionFile) {
      try {
        const coord = new OperationCoordinator(be);
        const forkFrom = coord.consumePendingFork();
        if (!forkFrom) {
          ctx.ui.notify(
            "grove: fork was created outside Grove, so no exact forkFrom intent was available; node not recorded.",
            "warning",
          );
          return;
        }
        // Snapshot parent session at fork point when available
        const parentFile = event.previousSessionFile ?? null;
        await recordFork(be, ctx.cwd, {
          sessionFile,
          entryId: ctx.sessionManager.getLeafId(),
          forkFrom,
          snapshotFile: parentFile && fs.existsSync(parentFile) ? parentFile : undefined,
        });
      } catch (err: any) {
        ctx.ui.notify(`grove: fork capture failed: ${err?.message ?? err}`, "warning");
      }
    }

    if (ctx.hasUI) {
      try {
        await refreshGroveStatus(ctx, be);
      } catch {
        /* not ready */
      }
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const be = getBackend(ctx.cwd);
    if (!fs.existsSync(path.join(be.repoDir(), ".jj"))) return;
    const prompt = typeof event?.prompt === "string" ? event.prompt : "";
    if (!looksLikeReplacement(prompt)) return;
    try {
      const nodes = await be.listNodes();
      const current = await be.currentChangeId();
      const tip = nodeAtChange(nodes, current);
      if (tip?.manifest?.kind === "auto" || tip?.manifest?.kind === "checkpoint") {
        new OperationCoordinator(be).setReplaceTarget(tip.changeId);
      }
    } catch {
      /* ignore */
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode && ctx.mode !== "tui") return;
    const be = getBackend(ctx.cwd);
    if (!fs.existsSync(path.join(be.repoDir(), ".jj"))) return;
    try {
      const node = await onAgentSettled(be, ctx.cwd, {
        sessionFile: ctx.sessionManager.getSessionFile(),
        entryId: ctx.sessionManager.getLeafId(),
      });
      if (node && ctx.hasUI) {
        ctx.ui.setStatus("grove", groveStatusLabel(node));
      }
    } catch {
      /* auto is best-effort */
    }
  });

  pi.registerCommand("grove", {
    description: "Grove: session tree (commit, goto, fork, merge, auto, sync, undo)",
    handler: async (args, ctx) => {
      const notify = ctx.ui.notify.bind(ctx.ui);
      try {
        await JjCliBackend.checkAvailability();
      } catch (err: any) {
        notify(err instanceof JjUnavailableError ? err.message : String(err), "error");
        return;
      }
      try {
        await handle(args, ctx, getBackend(ctx.cwd), pi);
      } catch (err: any) {
        notify(`/grove: ${err?.message ?? String(err)}`, "error");
      }
    },
  });
}

async function handle(
  args: string,
  ctx: ExtensionCommandContext,
  be: TreeBackend,
  pi: ExtensionAPI,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const sub = parts[0] || "";
  const rest = parts.slice(1).join(" ");

  switch (sub) {
    case "commit":
    case "c": {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("No active session.", "error");
        return;
      }
      const label = rest || (await ctx.ui.input("Checkpoint label:"));
      if (!label) return;
      const node = await checkpointSession(be, ctx.cwd, {
        label,
        sessionFile,
        entryId: ctx.sessionManager.getLeafId(),
      });
      ctx.ui.setStatus("grove", groveStatusLabel(node));
      ctx.ui.notify(`Checkpoint: ${label} (${node.changeId.slice(0, 8)})`, "success");
      break;
    }

    case "goto":
    case "go": {
      if (!rest) {
        ctx.ui.notify("Usage: /grove goto <change-id|label>", "error");
        return;
      }
      const nodes = await be.listNodes();
      const target = findNode(nodes, rest);
      if (!target?.manifest) {
        ctx.ui.notify(`Node not found: ${rest}`, "error");
        return;
      }
      await gotoNode(ctx, be, target);
      break;
    }

    case "fork":
    case "f": {
      await forkFromSelection(ctx, be, null);
      break;
    }

    case "status":
    case "st": {
      const nodes = await be.listNodes();
      const sessionFile = ctx.sessionManager.getSessionFile();
      const currentChange = await be.currentChangeId();
      const node = nodeAtChange(nodes, currentChange);
      const lines: string[] = [];
      lines.push(`machine: ${machineId()}`);
      lines.push(`tree repo: ${be.repoDir()}`);
      lines.push(`@ change: ${currentChange.slice(0, 12)}`);
      const pending = pendingSummary(be.repoDir());
      if (pending) lines.push(`pending: ${pending}`);
      if (node?.manifest) {
        lines.push(`current node: ${groveStatusLabel(node)} (${node.changeId.slice(0, 8)})`);
        lines.push(`lifecycle: ${node.manifest.lifecycle} · kind: ${node.manifest.kind}`);
        lines.push(`snapshot: ${node.manifest.snapshotId?.slice(0, 12) ?? "none"}`);
        if (sessionFile && path.basename(sessionFile) === node.manifest.sessionId) {
          lines.push(`session turns: ${countSessionMessages(sessionFile)}`);
        }
      } else {
        lines.push("current session: untracked");
      }
      const code = codeState(ctx.cwd);
      if (code) lines.push(`code: ${code.rev.slice(0, 8)}${code.dirty ? " (dirty)" : ""} fp ${code.fingerprint}`);
      const settings = loadProjectSettings(ctx.cwd);
      lines.push(`sync: ${settings.treeRemote ? "configured" : "off (default)"}`);
      lines.push(`nodes: ${nodes.length}`);
      ctx.ui.notify(lines.join("\n"), "info");
      break;
    }

    case "log":
    case "ls": {
      const nodes = await be.listNodes();
      if (nodes.length === 0) {
        ctx.ui.notify("No nodes yet. /grove commit <label>", "info");
        return;
      }
      const currentChange = await be.currentChangeId();
      const lines = nodes.map((n) => {
        const m = n.manifest;
        const at = n.changeId === currentChange ? "@" : " ";
        return `${at} ${groveStatusLabel(n)} ${n.changeId.slice(0, 8)}${m?.origin ? ` · ${m.origin}` : ""}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
      break;
    }

    case "undo":
    case "u": {
      const coord = new OperationCoordinator(be);
      const receipt = await coord.undoLast();
      await refreshGroveStatus(ctx, be);
      ctx.ui.notify(
        receipt
          ? `Undid ${receipt.op} (restored op ${receipt.preOpId.slice(0, 8)})`
          : "Undid last jj operation.",
        "success",
      );
      break;
    }

    case "merge":
    case "m":
    case "pick":
    case "p": {
      if (!rest) {
        ctx.ui.notify(`Usage: /grove ${sub} <change-id|label>`, "error");
        return;
      }
      const nodes = await be.listNodes();
      const target = findNode(nodes, rest);
      if (!target?.manifest) {
        ctx.ui.notify(`Node not found: ${rest}`, "error");
        return;
      }
      await injectNode(pi, ctx, be, target, sub === "m" || sub === "merge");
      break;
    }

    case "auto": {
      const [action, target] = rest.split(/\s+/);
      if (!action || !["keep", "replace", "split"].includes(action)) {
        ctx.ui.notify("Usage: /grove auto <keep|replace|split> [change-id]", "error");
        return;
      }
      const nodes = await be.listNodes();
      const changeId = target
        ? findNode(nodes, target)?.changeId
        : await be.currentChangeId();
      if (!changeId) {
        ctx.ui.notify("No target node.", "error");
        return;
      }
      const msg = await autoAction(be, ctx.cwd, action as "keep" | "replace" | "split", changeId);
      await refreshGroveStatus(ctx, be);
      ctx.ui.notify(msg, "success");
      break;
    }

    case "pin": {
      const nodes = await be.listNodes();
      const target = rest ? findNode(nodes, rest) : nodeAtChange(nodes, await be.currentChangeId());
      if (!target) {
        ctx.ui.notify("Node not found.", "error");
        return;
      }
      await pinNode(be, target.changeId);
      await refreshGroveStatus(ctx, be);
      ctx.ui.notify(`Pinned ${target.manifest?.label}`, "success");
      break;
    }

    case "realign": {
      const nodes = await be.listNodes();
      const current = await be.currentChangeId();
      const node = nodeAtChange(nodes, current);
      if (!node?.manifest) {
        ctx.ui.notify("Nothing to realign (@ has no grove manifest).", "info");
        return;
      }
      await gotoNode(ctx, be, node);
      break;
    }

    case "sync": {
      const syncSub = rest.split(/\s+/)[0] || "";
      const syncRest = rest.split(/\s+/).slice(1).join(" ");
      if (syncSub === "push") {
        const msg = await syncPush(be, ctx.cwd);
        const frontier = (await be.listNodes()).find((n) => n.manifest?.kind === "frontier");
        const reg = publishRegistryAfterPush(ctx.cwd, {
          frontierCommitId: frontier?.commitId ?? frontier?.changeId ?? "",
        });
        const flushed = flushRegistryOutbox(ctx.cwd);
        ctx.ui.notify(`${msg}\n${reg}${flushed ? `\nflushed outbox ${flushed}` : ""}`, "success");
      } else if (syncSub === "pull") {
        const msg = await syncPull(be, ctx.cwd);
        ctx.ui.notify(msg, "success");
      } else if (syncSub === "config") {
        const url = syncRest.split(/\s+/)[0];
        if (!url) {
          ctx.ui.notify("Usage: /grove sync config <treeRemoteUrl> [--private|--encrypt]", "error");
          return;
        }
        const msg = configureSync(ctx.cwd, {
          treeRemote: url,
          confirmPrivate: syncRest.includes("--private"),
          encrypt: syncRest.includes("--encrypt"),
        });
        ctx.ui.notify(msg, "success");
      } else {
        ctx.ui.notify("Usage: /grove sync <push|pull|config>", "info");
      }
      break;
    }

    case "dashboard": {
      flushRegistryOutbox(ctx.cwd);
      ctx.ui.notify(["Grove registry dashboard:", ...dashboardLines()].join("\n"), "info");
      break;
    }

    case "": {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Interactive tree view requires TUI mode.", "error");
        return;
      }
      await be.ensureRepo();
      const nodes = await be.listNodes();
      const sessionFile = ctx.sessionManager.getSessionFile();
      const currentChange = await be.currentChangeId();
      const currentRef = sessionFile ? path.basename(sessionFile) : null;

      const result: GroveViewResult | null = await ctx.ui.custom<GroveViewResult | null>(
        (_tui, theme, _kb, done) => {
          const view = new GroveTreeView(nodes, currentChange, currentRef, theme);
          view.setResolve((r) => done(r));
          return view;
        },
      );

      if (!result || result.action === "close") break;

      switch (result.action) {
        case "goto":
          if (result.node) await gotoNode(ctx, be, result.node);
          break;
        case "commit": {
          const label = await ctx.ui.input("Checkpoint label:");
          const sf = ctx.sessionManager.getSessionFile();
          if (label && sf) {
            const node = await checkpointSession(be, ctx.cwd, {
              label,
              sessionFile: sf,
              entryId: ctx.sessionManager.getLeafId(),
            });
            ctx.ui.setStatus("grove", groveStatusLabel(node));
            ctx.ui.notify(`Checkpoint: ${label}`, "success");
          }
          break;
        }
        case "fork":
          await forkFromSelection(ctx, be, result.node ?? null);
          break;
        case "merge":
          if (result.node) await injectNode(pi, ctx, be, result.node, true);
          break;
        case "pick":
          if (result.node) await injectNode(pi, ctx, be, result.node, false);
          break;
        case "undo": {
          const coord = new OperationCoordinator(be);
          await coord.undoLast();
          await refreshGroveStatus(ctx, be);
          ctx.ui.notify("Undid last grove operation.", "success");
          break;
        }
        case "auto-keep":
        case "auto-replace":
        case "auto-split": {
          if (!result.node) break;
          const action =
            result.action === "auto-keep" ? "keep" :
            result.action === "auto-replace" ? "replace" : "split";
          const msg = await autoAction(be, ctx.cwd, action, result.node.changeId);
          await refreshGroveStatus(ctx, be);
          ctx.ui.notify(msg, "success");
          break;
        }
        case "realign": {
          const n = result.node ?? nodeAtChange(await be.listNodes(), await be.currentChangeId());
          if (n) await gotoNode(ctx, be, n);
          break;
        }
        case "sync-push": {
          const msg = await syncPush(be, ctx.cwd);
          const frontier = (await be.listNodes()).find((n) => n.manifest?.kind === "frontier");
          publishRegistryAfterPush(ctx.cwd, {
            frontierCommitId: frontier?.commitId ?? frontier?.changeId ?? "",
          });
          ctx.ui.notify(msg, "success");
          break;
        }
        case "sync-pull":
          ctx.ui.notify(await syncPull(be, ctx.cwd), "success");
          break;
        case "dashboard":
          ctx.ui.notify(["Grove registry dashboard:", ...dashboardLines()].join("\n"), "info");
          break;
        case "pin":
          if (result.node) {
            await pinNode(be, result.node.changeId);
            ctx.ui.notify(`Pinned ${result.node.manifest?.label}`, "success");
          }
          break;
      }
      break;
    }

    default: {
      ctx.ui.notify(
        `Unknown: ${sub}\nUsage: /grove [commit|goto|fork|status|log|undo|merge|pick|auto|pin|realign|sync|dashboard]`,
        "error",
      );
      break;
    }
  }
}

async function forkFromSelection(
  ctx: ExtensionCommandContext,
  be: TreeBackend,
  selected: GroveNode | null,
): Promise<void> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) {
    ctx.ui.notify("No active session.", "error");
    return;
  }
  const nodes = await be.listNodes();
  const coord = new OperationCoordinator(be);

  let forkFrom: ForkFrom;
  let forkEntry: string | null;

  if (selected?.manifest) {
    // Fork from selected node's anchor (may be historical)
    forkEntry = selected.manifest.anchor.entryId ?? ctx.sessionManager.getLeafId();
    const parent =
      nearestParentNode(nodes, selected.manifest.sessionId, selected.manifest.anchor) ?? selected;
    forkFrom = {
      parentChangeId: parent.changeId,
      parentSessionId: selected.manifest.sessionId,
      parentAnchor: selected.manifest.anchor,
    };
    // Must be same session file to fork at entry without goto
    if (path.basename(sessionFile) !== selected.manifest.sessionId) {
      ctx.ui.notify(
        `Goto "${selected.manifest.label}" first (different session), then fork.`,
        "info",
      );
      return;
    }
  } else {
    forkEntry = ctx.sessionManager.getLeafId();
    if (!forkEntry) {
      ctx.ui.notify("No active session entry to fork from.", "error");
      return;
    }
    const anchor = captureAnchor(sessionFile, forkEntry);
    const parent =
      nearestParentNode(nodes, path.basename(sessionFile), anchor) ??
      nodeAtChange(nodes, await be.currentChangeId());
    if (!parent) {
      ctx.ui.notify("No parent node — create a checkpoint first.", "error");
      return;
    }
    forkFrom = {
      parentChangeId: parent.changeId,
      parentSessionId: path.basename(sessionFile),
      parentAnchor: anchor,
    };
  }

  coord.setPendingFork(forkFrom);
  const result = await ctx.fork(forkEntry!, {
    withSession: async (replacementCtx) => {
      replacementCtx.ui.notify("Forked — node recorded in grove.", "success");
    },
  });
  if (result.cancelled) {
    coord.consumePendingFork();
    ctx.ui.notify("Fork cancelled.", "info");
  }
}

async function injectNode(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  be: TreeBackend,
  target: GroveNode,
  asMerge: boolean,
): Promise<void> {
  const summary = await nodeSummaryForInject(be, target);
  const header = asMerge ? "Merged node" : "Cherry-picked node";
  const payload = `## ${header}: ${target.manifest!.label}\n\n${summary}\n\nConsider the above work as context for continuing the current task.`;
  pi.sendUserMessage(payload, { deliverAs: "followUp" });
  if (asMerge) {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      await recordMerge(be, ctx.cwd, {
        label: `merge: ${target.manifest!.label}`,
        sessionFile,
        source: target,
        strategy: "summary",
        payload,
      });
    }
  }
  ctx.ui.notify(`${header}: ${target.manifest!.label}`, "success");
}

export async function gotoNode(
  ctx: ExtensionCommandContext,
  be: TreeBackend,
  target: GroveNode,
): Promise<void> {
  const m = target.manifest!;
  const availability = await ensureSessionAvailable(be, ctx.cwd, target);
  if (!availability) {
    ctx.ui.notify(
      `Session ${m.sessionId} unavailable and no snapshot in the tree.`,
      "error",
    );
    return;
  }
  if (!availability.anchorOk) {
    ctx.ui.notify(
      `Anchor stale (${availability.anchorReason}); opened materialized/local session at best effort.`,
      "warning",
    );
  }

  const currentSessionFile = ctx.sessionManager.getSessionFile();
  const targetChangeId = target.changeId;
  const targetLabel = m.label;
  const entryId = m.anchor.entryId;

  // Prefer pi alignment first, then jj edit (ADR-0004)
  if (currentSessionFile && availability.path === currentSessionFile) {
    if (entryId) {
      try {
        await ctx.navigateTree(entryId, { summarize: true });
      } catch {
        /* entry may be gone; continue */
      }
    }
    await be.edit(targetChangeId);
    ctx.ui.setStatus("grove", groveStatusLabel(target));
    ctx.ui.notify(`@ → ${targetLabel}`, "success");
    new OperationCoordinator(be).setAligned(targetChangeId, m.sessionId, m.anchor);
    return;
  }

  await ctx.switchSession(availability.path, {
    withSession: async (replacementCtx) => {
      if (entryId) {
        try {
          await replacementCtx.navigateTree(entryId, { summarize: true });
        } catch {
          /* ignore */
        }
      }
      await be.edit(targetChangeId);
      replacementCtx.ui.setStatus("grove", groveStatusLabel(target));
      replacementCtx.ui.notify(
        `@ → ${targetLabel}${availability.materialized ? " (materialized from snapshot)" : ""}`,
        "success",
      );
      new OperationCoordinator(be).setAligned(targetChangeId, m.sessionId, m.anchor);
    },
  });
}
