/**
 * Grove commands and foreground single-writer hooks.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  GROVE_PROPOSAL_PENDING_EVENT,
  ORCHESTRATOR_RUN_ENTRY,
} from "../shared/outcomes";
import { JjCliBackend, JjUnavailableError } from "./backend/jj-cli";
import {
  isEffectivelySealed,
  newDomainId,
  type EdgeKind,
  type GroveGraph,
  type SessionNode,
  type TreeBackend,
} from "./backend/types";
import {
  checkpointSession,
  ensureSessionAvailable,
  nearestParentNode,
  nodeSummaryForInject,
  pinNode,
  recordContextInjection,
  recordFork,
  type ForkRef,
} from "./mapping/ops";
import { OperationCoordinator, pendingSummary } from "./mapping/coordinator";
import {
  autoAction,
  looksLikeReplacement,
  onLegacyAgentSettled,
  shouldRunLegacyHarness,
} from "./mapping/harness";
import { reconcileProposals } from "./mapping/capture";
import { syncPush, syncPull, configureSync } from "./mapping/sync";
import { publishRegistryAfterPush, flushRegistryOutbox, dashboardLines } from "./mapping/registry";
import { machineId, codeState } from "./lib/identity";
import {
  captureAnchor,
  countSessionMessages,
  resolveAnchor,
} from "./lib/sessions";
import { loadProjectSettings } from "./lib/settings";
import {
  GraphWorkspace,
  type GraphWorkspaceSnapshot,
} from "./ui/graph-workspace";
import { loadNodeThread } from "./ui/thread-loader";
import type { GroveViewResult } from "./ui/tree-view";

function findNode(graph: GroveGraph, target: string): SessionNode | undefined {
  const lower = target.toLowerCase();
  return (
    graph.nodes.find((node) => node.nodeId.startsWith(target)) ??
    graph.nodes.find((node) => node.backendRef.changeId.startsWith(target)) ??
    graph.nodes.find((node) => node.label === target) ??
    graph.nodes.find((node) => node.label.toLowerCase().includes(lower))
  );
}

function nodeAtCursor(graph: GroveGraph, changeId: string): SessionNode | undefined {
  return graph.nodes.find((node) => node.backendRef.changeId === changeId);
}

function latestForSession(graph: GroveGraph, sessionFile: string | null): SessionNode | undefined {
  if (!sessionFile) return undefined;
  const sessionId = path.basename(sessionFile);
  return graph.nodes
    .filter((node) => node.sessionId === sessionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export async function activeSessionNode(
  graph: GroveGraph,
  backend: TreeBackend,
  sessionFile: string | null,
): Promise<SessionNode | undefined> {
  if (sessionFile) {
    const sessionId = path.basename(sessionFile);
    const aligned = new OperationCoordinator(backend).getAligned();
    if (aligned?.sessionId === sessionId) {
      const node = graph.nodes.find((candidate) => candidate.nodeId === aligned.nodeId);
      if (node) return node;
    }
    return latestForSession(graph, sessionFile);
  }
  return nodeAtCursor(graph, await backend.currentChangeId());
}

export function groveStatusLabel(
  node: SessionNode | undefined,
  graph?: GroveGraph,
): string {
  if (!node) return "◇ untracked";
  const attachments = graph?.attachments.filter(
    (attachment) => attachment.targetNodeId === node.nodeId,
  ) ?? [];
  const glyph = attachments.some((attachment) => attachment.kind === "execution_outcome")
    ? "■"
    : node.capture.source === "manual"
      ? "◆"
      : "○";
  const draft = graph && !isEffectivelySealed(node, graph.edges) ? "·draft" : "";
  return `${glyph} ${node.label}${draft}`;
}

async function refreshGroveStatus(
  ctx: Pick<ExtensionCommandContext, "ui" | "sessionManager">,
  backend: TreeBackend,
): Promise<void> {
  const graph = await backend.getGraph();
  const node = await activeSessionNode(
    graph,
    backend,
    ctx.sessionManager.getSessionFile(),
  );
  ctx.ui.setStatus("grove", groveStatusLabel(node, graph));
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

  async function reconcile(ctx: ExtensionCommandContext): Promise<SessionNode | null> {
    const current = getBackend(ctx.cwd);
    if (!fs.existsSync(path.join(current.repoDir(), ".jj"))) return null;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const entries = ctx.sessionManager.getEntries() as any[];
    const results = await reconcileProposals(current, ctx.cwd, {
      sessionFile,
      entryId: ctx.sessionManager.getLeafId(),
      entries,
    });
    const captured = [...results].reverse().find((result) => result.node)?.node ?? null;
    if (captured) {
      if (sessionFile && path.basename(sessionFile) === captured.sessionId) {
        new OperationCoordinator(current).setAligned(
          captured.nodeId,
          captured.sessionId,
          captured.anchor,
        );
      }
      return captured;
    }
    const hasOutcomeLedger = entries.some(
      (entry) => entry.type === "custom" && entry.customType === ORCHESTRATOR_RUN_ENTRY,
    );
    if (!shouldRunLegacyHarness(ctx.cwd, hasOutcomeLedger)) return null;
    const legacy = await onLegacyAgentSettled(current, ctx.cwd, {
      sessionFile,
      entryId: ctx.sessionManager.getLeafId(),
    });
    if (legacy && sessionFile && path.basename(sessionFile) === legacy.sessionId) {
      new OperationCoordinator(current).setAligned(
        legacy.nodeId,
        legacy.sessionId,
        legacy.anchor,
      );
    }
    return legacy;
  }

  pi.on("session_start", async (event, ctx) => {
    const current = getBackend(ctx.cwd);
    if (!fs.existsSync(path.join(current.repoDir(), ".jj"))) return;
    try {
      await JjCliBackend.checkAvailability();
    } catch {
      return;
    }
    const pending = pendingSummary(current.repoDir());
    if (pending && ctx.hasUI) ctx.ui.notify(`grove: ${pending}`, "warning");

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (event.reason === "fork" && sessionFile) {
      try {
        const coordinator = new OperationCoordinator(current);
        const forkFrom = coordinator.consumePendingFork();
        if (!forkFrom) {
          ctx.ui.notify("grove: fork had no foreground Grove intent; node not recorded.", "warning");
        } else {
          const parentFile = event.previousSessionFile ?? null;
          await recordFork(current, ctx.cwd, {
            sessionFile,
            entryId: ctx.sessionManager.getLeafId(),
            forkFrom,
            snapshotFile: parentFile && fs.existsSync(parentFile) ? parentFile : undefined,
          });
        }
      } catch (error: any) {
        ctx.ui.notify(`grove: fork capture failed: ${error?.message ?? error}`, "warning");
      }
    }
    try {
      await reconcile(ctx as ExtensionCommandContext);
      if (ctx.hasUI) await refreshGroveStatus(ctx as ExtensionCommandContext, current);
    } catch {
      /* recovery is retried at settled */
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const current = getBackend(ctx.cwd);
    if (!fs.existsSync(path.join(current.repoDir(), ".jj"))) return;
    const prompt = typeof event?.prompt === "string" ? event.prompt : "";
    if (!looksLikeReplacement(prompt)) return;
    try {
      const graph = await current.getGraph();
      const node = await activeSessionNode(
        graph,
        current,
        ctx.sessionManager.getSessionFile(),
      );
      if (node && !isEffectivelySealed(node, graph.edges)) {
        new OperationCoordinator(current).setReplaceTarget(node.nodeId);
      }
    } catch {
      /* heuristic only */
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      const node = await reconcile(ctx as ExtensionCommandContext);
      if (node && ctx.hasUI) {
        const graph = await getBackend(ctx.cwd).getGraph();
        ctx.ui.setStatus("grove", groveStatusLabel(node, graph));
      }
    } catch {
      /* capture is best effort and replayed from session entries */
    }
  });

  try {
    const events = (pi as any).events;
    events?.on?.(GROVE_PROPOSAL_PENDING_EVENT, () => {
      // Notification only. The next foreground settled/session hook reconciles
      // durable entries; async EventBus listener completion is never required.
    });
  } catch {
    /* EventBus is optional */
  }

  pi.registerCommand("grove", {
    description: "Grove semantic session graph",
    handler: async (args, ctx) => {
      try {
        await JjCliBackend.checkAvailability();
        await handle(args, ctx, getBackend(ctx.cwd), pi);
      } catch (error: any) {
        ctx.ui.notify(
          error instanceof JjUnavailableError ? error.message : `/grove: ${error?.message ?? error}`,
          "error",
        );
      }
    },
  });
}

async function handle(
  args: string,
  ctx: ExtensionCommandContext,
  backend: TreeBackend,
  pi: ExtensionAPI,
): Promise<void> {
  const parts = args.trim().split(/\s+/);
  const subcommand = parts[0] || "";
  const rest = parts.slice(1).join(" ");

  switch (subcommand) {
    case "commit":
    case "c": {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) return ctx.ui.notify("No active session.", "error");
      const label = rest || (await ctx.ui.input("Checkpoint label:"));
      if (!label) return;
      const node = await checkpointSession(backend, ctx.cwd, {
        label,
        sessionFile,
        entryId: ctx.sessionManager.getLeafId(),
      });
      const graph = await backend.getGraph();
      ctx.ui.setStatus("grove", groveStatusLabel(node, graph));
      ctx.ui.notify(`Checkpoint: ${label} (${node.nodeId.slice(0, 12)})`, "success");
      return;
    }

    case "goto":
    case "go": {
      if (!rest) return ctx.ui.notify("Usage: /grove goto <node-id|label>", "error");
      const target = findNode(await backend.getGraph(), rest);
      if (!target) return ctx.ui.notify(`Node not found: ${rest}`, "error");
      await gotoNode(ctx, backend, target);
      return;
    }

    case "fork":
    case "f":
      await forkFromSelection(ctx, backend, null);
      return;

    case "status":
    case "st": {
      const graph = await backend.getGraph();
      const sessionFile = ctx.sessionManager.getSessionFile();
      const node = await activeSessionNode(graph, backend, sessionFile);
      const lines = [
        `machine: ${machineId()}`,
        `tree repo: ${backend.repoDir()}`,
        `graph revision: ${graph.revision.slice(0, 12)}`,
      ];
      const pending = pendingSummary(backend.repoDir());
      if (pending) lines.push(`pending: ${pending}`);
      if (node) {
        const attachments = graph.attachments.filter(
          (attachment) => attachment.targetNodeId === node.nodeId,
        );
        lines.push(`current node: ${groveStatusLabel(node, graph)} (${node.nodeId.slice(0, 16)})`);
        lines.push(
          `state: ${isEffectivelySealed(node, graph.edges) ? "sealed" : "draft"} · pinned=${node.pinned} · attachments=${attachments.length}`,
        );
        lines.push(`snapshot: ${node.snapshotId?.slice(0, 12) ?? "none"}`);
        if (sessionFile && path.basename(sessionFile) === node.sessionId) {
          lines.push(`session turns: ${countSessionMessages(sessionFile)}`);
        }
      } else {
        lines.push("current session: untracked");
      }
      const code = codeState(ctx.cwd);
      if (code) lines.push(`code: ${code.rev.slice(0, 8)}${code.dirty ? " (dirty)" : ""} fp ${code.fingerprint}`);
      const settings = loadProjectSettings(ctx.cwd);
      lines.push(`tracking: ${settings.trackingMode ?? "auto"}`);
      lines.push(`sync: ${settings.treeRemote ? "configured" : "off (default)"}`);
      lines.push(`nodes: ${graph.nodes.length} · edges: ${graph.edges.length} · attachments: ${graph.attachments.length}`);
      ctx.ui.notify(lines.join("\n"), "info");
      return;
    }

    case "log":
    case "ls": {
      const graph = await backend.getGraph();
      if (!graph.nodes.length) return ctx.ui.notify("No nodes yet. /grove commit <label>", "info");
      const current = await activeSessionNode(
        graph,
        backend,
        ctx.sessionManager.getSessionFile(),
      );
      ctx.ui.notify(
        graph.nodes
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map((node) => {
            const at = node.nodeId === current?.nodeId ? "@" : " ";
            return `${at} ${groveStatusLabel(node, graph)} ${node.nodeId.slice(0, 14)} · ${node.origin}`;
          })
          .join("\n"),
        "info",
      );
      return;
    }

    case "undo":
    case "u": {
      const receipt = await new OperationCoordinator(backend).undoLast();
      await refreshGroveStatus(ctx, backend);
      ctx.ui.notify(
        receipt ? `Undid ${receipt.op} (restored ${receipt.preOpId.slice(0, 8)})` : "Undid last jj operation.",
        "success",
      );
      return;
    }

    case "merge":
    case "m":
    case "pick":
    case "p": {
      if (!rest) return ctx.ui.notify(`Usage: /grove ${subcommand} <node-id|label>`, "error");
      const target = findNode(await backend.getGraph(), rest);
      if (!target) return ctx.ui.notify(`Node not found: ${rest}`, "error");
      await injectNode(pi, ctx, backend, target, subcommand === "m" || subcommand === "merge");
      return;
    }

    case "auto": {
      const [action, targetRef] = rest.split(/\s+/);
      if (!["keep", "replace", "split"].includes(action)) {
        return ctx.ui.notify("Usage: /grove auto <keep|replace|split> [node-id]", "error");
      }
      const graph = await backend.getGraph();
      const target =
        (targetRef ? findNode(graph, targetRef) : undefined) ??
        await activeSessionNode(graph, backend, ctx.sessionManager.getSessionFile());
      if (!target) return ctx.ui.notify("No target node.", "error");
      const message = await autoAction(
        backend,
        action as "keep" | "replace" | "split",
        target.nodeId,
      );
      await refreshGroveStatus(ctx, backend);
      ctx.ui.notify(message, "success");
      return;
    }

    case "pin": {
      const graph = await backend.getGraph();
      const target =
        (rest ? findNode(graph, rest) : undefined) ??
        await activeSessionNode(graph, backend, ctx.sessionManager.getSessionFile());
      if (!target) return ctx.ui.notify("Node not found.", "error");
      await pinNode(backend, target.nodeId);
      await refreshGroveStatus(ctx, backend);
      ctx.ui.notify(`Pinned ${target.label}`, "success");
      return;
    }

    case "edge": {
      const [operation, kindOrId, fromRef, toRef] = rest.split(/\s+/);
      if (operation === "add") {
        if (!["lineage", "context", "supersedes"].includes(kindOrId) || !fromRef || !toRef) {
          return ctx.ui.notify("Usage: /grove edge add <lineage|context|supersedes> <from> <to>", "error");
        }
        const graph = await backend.getGraph();
        const from = findNode(graph, fromRef);
        const to = findNode(graph, toRef);
        if (!from || !to) return ctx.ui.notify("Edge endpoint not found.", "error");
        const edge = await connectNodes(backend, kindOrId as EdgeKind, from.nodeId, to.nodeId);
        ctx.ui.notify(`Added ${edge.kind} edge ${edge.edgeId.slice(0, 14)}`, "success");
      } else if (operation === "delete" && kindOrId) {
        await disconnectEdge(backend, kindOrId);
        ctx.ui.notify(`Deleted edge ${kindOrId}`, "success");
      } else {
        ctx.ui.notify("Usage: /grove edge <add|delete> ...", "error");
      }
      return;
    }

    case "realign": {
      const graph = await backend.getGraph();
      const node = await activeSessionNode(
        graph,
        backend,
        ctx.sessionManager.getSessionFile(),
      );
      if (!node) return ctx.ui.notify("Nothing to realign.", "info");
      await gotoNode(ctx, backend, node);
      return;
    }

    case "sync": {
      const [operation, url] = rest.split(/\s+/);
      if (operation === "push") {
        const message = await syncPush(backend, ctx.cwd);
        publishRegistryAfterPush(ctx.cwd, { frontierCommitId: await backend.currentChangeId() });
        const flushed = flushRegistryOutbox(ctx.cwd);
        ctx.ui.notify(`${message}${flushed ? `\nflushed outbox ${flushed}` : ""}`, "success");
      } else if (operation === "pull") {
        ctx.ui.notify(await syncPull(backend, ctx.cwd), "success");
      } else if (operation === "config" && url) {
        ctx.ui.notify(
          configureSync(ctx.cwd, {
            treeRemote: url,
            confirmPrivate: rest.includes("--private"),
            encrypt: rest.includes("--encrypt"),
          }),
          "success",
        );
      } else {
        ctx.ui.notify("Usage: /grove sync <push|pull|config>", "info");
      }
      return;
    }

    case "dashboard":
      flushRegistryOutbox(ctx.cwd);
      ctx.ui.notify(["Grove registry dashboard:", ...dashboardLines()].join("\n"), "info");
      return;

    case "": {
      if (ctx.mode !== "tui") return ctx.ui.notify("Interactive tree view requires TUI mode.", "error");
      await backend.ensureRepo();
      let workspaceState: GraphWorkspaceSnapshot | undefined;
      while (true) {
        const graph = await backend.getGraph();
        const sessionFile = ctx.sessionManager.getSessionFile();
        const current = await activeSessionNode(graph, backend, sessionFile);
        let workspace: GraphWorkspace | undefined;
        const result = await ctx.ui.custom<GroveViewResult | null>(
          (tui, theme, _kb, done) => {
            workspace = new GraphWorkspace({
              graph,
              currentNodeId: current?.nodeId ?? null,
              currentSessionRef: sessionFile ? path.basename(sessionFile) : null,
              initialSelectedNodeId: workspaceState?.selectedNodeId,
              initialCamera: workspaceState?.camera,
              tui,
              theme,
              loadThread: (node) => loadNodeThread(backend, ctx.cwd, node),
              done,
            });
            return workspace;
          },
        );
        workspaceState = workspace?.getSnapshot();
        if (!result || result.action === "close") return;
        await handleViewResult(result, ctx, backend, pi);
        // These actions replace the active session or intentionally return
        // context to chat. All other actions refresh the graph in-place.
        if (["goto", "realign", "fork", "merge", "pick"].includes(result.action)) return;
      }
    }

    default:
      ctx.ui.notify(
        `Unknown: ${subcommand}\nUsage: /grove [commit|goto|fork|status|log|undo|merge|pick|auto|pin|edge|realign|sync|dashboard]`,
        "error",
      );
  }
}

async function handleViewResult(
  result: GroveViewResult,
  ctx: ExtensionCommandContext,
  backend: TreeBackend,
  pi: ExtensionAPI,
): Promise<void> {
  switch (result.action) {
    case "goto":
      if (result.node) await gotoNode(ctx, backend, result.node);
      break;
    case "commit": {
      const label = await ctx.ui.input("Checkpoint label:");
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (label && sessionFile) {
        await checkpointSession(backend, ctx.cwd, {
          label,
          sessionFile,
          entryId: ctx.sessionManager.getLeafId(),
        });
      }
      break;
    }
    case "fork":
      await forkFromSelection(ctx, backend, result.node ?? null);
      break;
    case "merge":
    case "pick":
      if (result.node) await injectNode(pi, ctx, backend, result.node, result.action === "merge");
      break;
    case "undo":
      await new OperationCoordinator(backend).undoLast();
      break;
    case "auto-keep":
    case "auto-replace":
    case "auto-split":
      if (result.node) {
        const action =
          result.action === "auto-keep" ? "keep" :
          result.action === "auto-replace" ? "replace" : "split";
        ctx.ui.notify(await autoAction(backend, action, result.node.nodeId), "success");
      }
      break;
    case "realign":
      if (result.node) await gotoNode(ctx, backend, result.node);
      break;
    case "sync-push": {
      const message = await syncPush(backend, ctx.cwd);
      publishRegistryAfterPush(ctx.cwd, {
        frontierCommitId: await backend.currentChangeId(),
      });
      const flushed = flushRegistryOutbox(ctx.cwd);
      ctx.ui.notify(
        `${message}${flushed ? `\nflushed outbox ${flushed}` : ""}`,
        "success",
      );
      break;
    }
    case "sync-pull":
      ctx.ui.notify(await syncPull(backend, ctx.cwd), "success");
      break;
    case "dashboard":
      ctx.ui.notify(["Grove registry dashboard:", ...dashboardLines()].join("\n"), "info");
      break;
    case "pin":
      if (result.node) await pinNode(backend, result.node.nodeId);
      break;
    case "close":
      break;
  }
  await refreshGroveStatus(ctx, backend);
}

async function forkFromSelection(
  ctx: ExtensionCommandContext,
  backend: TreeBackend,
  selected: SessionNode | null,
): Promise<void> {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) return ctx.ui.notify("No active session.", "error");
  const graph = await backend.getGraph();
  let forkFrom: ForkRef;
  let forkEntry: string | null;

  if (selected) {
    if (path.basename(sessionFile) !== selected.sessionId) {
      return ctx.ui.notify(`Goto "${selected.label}" first, then fork.`, "info");
    }
    const resolved = resolveAnchor(sessionFile, selected.anchor);
    if (!resolved.ok || !resolved.entryId) {
      return ctx.ui.notify(
        `Cannot fork "${selected.label}": its exact SessionAnchor is unavailable.`,
        "error",
      );
    }
    forkEntry = resolved.entryId;
    const parent = nearestParentNode(graph, selected.sessionId, selected.anchor) ?? selected;
    forkFrom = {
      parentNodeId: parent.nodeId,
      parentSessionId: selected.sessionId,
      parentAnchor: selected.anchor,
    };
  } else {
    forkEntry = ctx.sessionManager.getLeafId();
    if (!forkEntry) return ctx.ui.notify("No active session entry to fork from.", "error");
    const anchor = captureAnchor(sessionFile, forkEntry);
    const parent =
      nearestParentNode(graph, path.basename(sessionFile), anchor) ??
      latestForSession(graph, sessionFile);
    if (!parent) return ctx.ui.notify("No parent node — create a checkpoint first.", "error");
    forkFrom = {
      parentNodeId: parent.nodeId,
      parentSessionId: path.basename(sessionFile),
      parentAnchor: anchor,
    };
  }

  const coordinator = new OperationCoordinator(backend);
  coordinator.setPendingFork(forkFrom);
  const result = await ctx.fork(forkEntry!, {
    withSession: async (replacementCtx) => {
      replacementCtx.ui.notify("Forked — node recorded in Grove.", "success");
    },
  });
  if (result.cancelled) {
    coordinator.consumePendingFork();
    ctx.ui.notify("Fork cancelled.", "info");
  }
}

async function injectNode(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  backend: TreeBackend,
  target: SessionNode,
  recordContext: boolean,
): Promise<void> {
  const summary = await nodeSummaryForInject(backend, target);
  const header = recordContext ? "Context from node" : "Injected node";
  const payload = `## ${header}: ${target.label}\n\n${summary}\n\nConsider this work as context for the current task.`;
  pi.sendUserMessage(payload, { deliverAs: "followUp" });
  if (recordContext) {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      await recordContextInjection(backend, ctx.cwd, {
        label: `context: ${target.label}`,
        sessionFile,
        source: target,
        payload,
      });
    }
  }
  ctx.ui.notify(`${header}: ${target.label}`, "success");
}

export async function connectNodes(
  backend: TreeBackend,
  kind: EdgeKind,
  fromNodeId: string,
  toNodeId: string,
) {
  const coordinator = new OperationCoordinator(backend);
  await coordinator.begin("edge", { kind, fromNodeId, toNodeId });
  try {
    const graph = await backend.getGraph();
    const edge = await backend.appendEdge({
      edge: {
        v: 1,
        recordType: "edge",
        edgeId: newDomainId("edge"),
        revision: 1,
        fromNodeId,
        toNodeId,
        kind,
        state: "active",
        createdAt: new Date().toISOString(),
      },
      expectedGraphRevision: graph.revision,
    });
    await coordinator.succeed(edge.backendRef.changeId);
    return edge;
  } catch (error: any) {
    await coordinator.failAndRestore(error?.message ?? String(error));
    throw error;
  }
}

export async function disconnectEdge(backend: TreeBackend, edgeId: string) {
  const coordinator = new OperationCoordinator(backend);
  await coordinator.begin("edge", { edgeId, action: "delete" });
  try {
    const graph = await backend.getGraph();
    const edge = await backend.deleteEdge({ edgeId, expectedGraphRevision: graph.revision });
    await coordinator.succeed(edge.backendRef.changeId);
    return edge;
  } catch (error: any) {
    await coordinator.failAndRestore(error?.message ?? String(error));
    throw error;
  }
}

export async function gotoNode(
  ctx: ExtensionCommandContext,
  backend: TreeBackend,
  target: SessionNode,
): Promise<void> {
  const availability = await ensureSessionAvailable(backend, ctx.cwd, target);
  if (!availability) {
    return ctx.ui.notify(`Session ${target.sessionId} unavailable and no snapshot exists.`, "error");
  }
  if (!availability.anchorOk || !availability.anchorEntryId) {
    return ctx.ui.notify(
      `Cannot navigate to exact SessionAnchor (${availability.anchorReason ?? "entry unavailable"}).`,
      "error",
    );
  }
  const align = async (replacementCtx: ExtensionCommandContext) => {
    try {
      await replacementCtx.navigateTree(availability.anchorEntryId!, { summarize: true });
    } catch {
      if (!availability.materialized) {
        return replacementCtx.ui.notify(
          `Failed to navigate to SessionAnchor ${availability.anchorEntryId}.`,
          "error",
        );
      }
      // A materialized snapshot already ends at the exact anchor; old compacted
      // entry IDs need not be navigable by the current SessionManager.
    }
    await backend.gotoNode(target.nodeId);
    const graph = await backend.getGraph();
    replacementCtx.ui.setStatus("grove", groveStatusLabel(target, graph));
    replacementCtx.ui.notify(`@ → ${target.label}`, "success");
    new OperationCoordinator(backend).setAligned(target.nodeId, target.sessionId, target.anchor);
  };

  if (
    ctx.sessionManager.getSessionFile() === availability.path &&
    !availability.materialized
  ) {
    await align(ctx);
  } else {
    await ctx.switchSession(availability.path, { withSession: align });
  }
}
