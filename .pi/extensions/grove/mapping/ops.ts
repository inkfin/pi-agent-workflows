/**
 * grove/mapping/ops.ts — pi ↔ jj orchestration
 */

import * as path from "node:path";
import type {
  TreeBackend,
  GroveNode,
  NodeManifest,
  SessionAnchor,
  InjectStrategy,
  ForkFrom,
} from "../backend/types";
import { machineId, projectInfo, codeState } from "../lib/identity";
import {
  resolveSessionRef,
  materializeSession,
  summarizeSessionContent,
  captureAnchor,
  resolveAnchor,
  sha256,
} from "../lib/sessions";
import { buildSnapshotFromSession, snapshotPath, redact } from "../lib/snapshots";
import { OperationCoordinator } from "./coordinator";
import { loadJournal, saveJournal } from "../lib/journal";

export { redact };

function baseManifest(
  cwd: string,
  kind: NodeManifest["kind"],
  label: string,
  sessionId: string,
  anchor: SessionAnchor,
  extra: Partial<NodeManifest> = {},
): NodeManifest {
  const proj = projectInfo(cwd);
  return {
    v: 1,
    kind,
    label,
    projectId: proj.projectId,
    sessionId,
    snapshotId: extra.snapshotId ?? null,
    anchor,
    lifecycle: extra.lifecycle ?? (kind === "auto" ? "draft" : "pinned"),
    project: { name: proj.name, vcsRemote: proj.vcsRemote },
    origin: machineId(),
    code: codeState(cwd),
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

export async function checkpointSession(
  be: TreeBackend,
  cwd: string,
  opts: { label: string; sessionFile: string; entryId: string | null },
): Promise<GroveNode> {
  const coord = new OperationCoordinator(be);
  await coord.begin("checkpoint", { label: opts.label });
  try {
    const sessionId = path.basename(opts.sessionFile);
    const anchor = captureAnchor(opts.sessionFile, opts.entryId);
    const snap = buildSnapshotFromSession(opts.sessionFile);
    const node = await be.commitNode({
      manifest: baseManifest(cwd, "checkpoint", opts.label, sessionId, anchor, {
        snapshotId: snap.snapshotId,
        lifecycle: "pinned",
      }),
      files: snap.files,
    });
    await coord.succeed(node.changeId);
    const j = loadJournal(be.repoDir());
    j.lastAligned = { changeId: node.changeId, sessionId, anchor };
    saveJournal(be.repoDir(), j);
    return node;
  } catch (err: any) {
    await coord.failAndRestore(err?.message ?? String(err));
    throw err;
  }
}

export async function recordFork(
  be: TreeBackend,
  cwd: string,
  opts: {
    sessionFile: string;
    entryId: string | null;
    forkFrom: ForkFrom;
    snapshotFile?: string;
  },
): Promise<GroveNode> {
  const coord = new OperationCoordinator(be);
  await coord.begin("fork", { parent: opts.forkFrom.parentChangeId });
  try {
    const sessionId = path.basename(opts.sessionFile);
    const anchor = captureAnchor(opts.sessionFile, opts.entryId);
    let files: Record<string, string> | undefined;
    let snapshotId: string | null = null;
    if (opts.snapshotFile) {
      const snap = buildSnapshotFromSession(opts.snapshotFile);
      files = snap.files;
      snapshotId = snap.snapshotId;
    }
    const node = await be.commitNode({
      parents: [opts.forkFrom.parentChangeId],
      manifest: baseManifest(cwd, "fork", `fork: ${sessionId.replace(/\.jsonl$/, "")}`, sessionId, anchor, {
        snapshotId,
        forkFrom: opts.forkFrom,
        lifecycle: "pinned",
      }),
      files,
    });
    await coord.succeed(node.changeId);
    return node;
  } catch (err: any) {
    await coord.failAndRestore(err?.message ?? String(err));
    throw err;
  }
}

export async function recordMerge(
  be: TreeBackend,
  cwd: string,
  opts: {
    label: string;
    sessionFile: string;
    source: GroveNode;
    strategy?: InjectStrategy;
    payload: string;
  },
): Promise<GroveNode> {
  const coord = new OperationCoordinator(be);
  await coord.begin("merge", { source: opts.source.changeId });
  try {
    const current = await be.currentChangeId();
    const sessionId = path.basename(opts.sessionFile);
    const sm = opts.source.manifest!;
    const node = await be.commitNode({
      parents: [current, opts.source.changeId],
      manifest: baseManifest(cwd, "context_merge", opts.label, sessionId, { entryId: null }, {
        lifecycle: "pinned",
        injectStrategy: opts.strategy ?? "summary",
        payloadHash: sha256(opts.payload).slice(0, 16),
        mergeOf: [
          {
            changeId: opts.source.changeId,
            label: sm.label,
            sessionId: sm.sessionId,
            anchor: sm.anchor,
          },
        ],
      }),
    });
    await coord.succeed(node.changeId);
    return node;
  } catch (err: any) {
    await coord.failAndRestore(err?.message ?? String(err));
    throw err;
  }
}

/** Create or amend an auto draft node after agent_settled. */
export async function recordOrAmendAuto(
  be: TreeBackend,
  cwd: string,
  opts: {
    sessionFile: string;
    entryId: string | null;
    replaceChangeId?: string | null;
    supersedes?: string | null;
  },
): Promise<GroveNode> {
  const sessionId = path.basename(opts.sessionFile);
  const anchor = captureAnchor(opts.sessionFile, opts.entryId);
  const snap = buildSnapshotFromSession(opts.sessionFile);
  const code = codeState(cwd);
  const nodes = await be.listNodes();

  if (opts.replaceChangeId) {
    const target = nodes.find((n) => n.changeId === opts.replaceChangeId);
    const m = target?.manifest;
    const hasChildren = nodes.some((n) => n.parents.includes(opts.replaceChangeId!));
    if (
      m &&
      m.kind === "auto" &&
      m.lifecycle === "draft" &&
      !hasChildren
    ) {
      const coord = new OperationCoordinator(be);
      await coord.begin("amend", { changeId: opts.replaceChangeId });
      try {
        const node = await be.amendNode({
          changeId: opts.replaceChangeId,
          manifest: {
            ...m,
            label: `auto ${new Date().toISOString().slice(0, 16)}`,
            snapshotId: snap.snapshotId,
            anchor,
            code,
            createdAt: new Date().toISOString(),
            supersedes: opts.supersedes ?? m.supersedes,
          },
          files: snap.files,
        });
        await coord.succeed(node.changeId);
        return node;
      } catch (err: any) {
        await coord.failAndRestore(err?.message ?? String(err));
        throw err;
      }
    }
  }

  const coord = new OperationCoordinator(be);
  await coord.begin("auto", {});
  try {
    const node = await be.commitNode({
      manifest: baseManifest(cwd, "auto", `auto ${new Date().toISOString().slice(0, 16)}`, sessionId, anchor, {
        snapshotId: snap.snapshotId,
        lifecycle: "draft",
        supersedes: opts.supersedes ?? null,
      }),
      files: snap.files,
    });
    await coord.succeed(node.changeId);
    return node;
  } catch (err: any) {
    await coord.failAndRestore(err?.message ?? String(err));
    throw err;
  }
}

export async function pinNode(be: TreeBackend, changeId: string): Promise<GroveNode> {
  const nodes = await be.listNodes();
  const target = nodes.find((n) => n.changeId === changeId);
  if (!target?.manifest) throw new Error(`Node not found: ${changeId}`);
  const m = { ...target.manifest, lifecycle: "pinned" as const };
  return be.amendNode({ changeId, manifest: m });
}

export async function ensureSessionAvailable(
  be: TreeBackend,
  cwd: string,
  node: GroveNode,
): Promise<{ path: string; materialized: boolean; anchorOk: boolean; anchorReason?: string } | null> {
  const m = node.manifest;
  if (!m) return null;
  const local = resolveSessionRef(cwd, m.sessionId);
  if (local) {
    const resolved = resolveAnchor(local, m.anchor);
    if (resolved.ok) return { path: local, materialized: false, anchorOk: true };
    // Fall through to snapshot materialize when anchor stale
  }
  if (!m.snapshotId) {
    if (local) {
      const resolved = resolveAnchor(local, m.anchor);
      return {
        path: local,
        materialized: false,
        anchorOk: resolved.ok,
        anchorReason: resolved.ok ? undefined : resolved.reason,
      };
    }
    return null;
  }
  const snapshot = await be.showFile(node.changeId, snapshotPath(m.snapshotId));
  // Also try tip of objects (may live in ancestor)
  const content =
    snapshot ??
    (await be.showFile("@", snapshotPath(m.snapshotId))) ??
    null;
  if (content == null) return null;
  const materializedPath = materializeSession(cwd, m.sessionId, content);
  return { path: materializedPath, materialized: true, anchorOk: true };
}

export async function nodeSummaryForInject(
  be: TreeBackend,
  node: GroveNode,
  maxLen = 2000,
): Promise<string> {
  const m = node.manifest;
  if (!m) return "";
  if (!m.snapshotId) return `(no snapshot for ${m.label})`;
  const snapshot =
    (await be.showFile(node.changeId, snapshotPath(m.snapshotId))) ??
    (await be.showFile("@", snapshotPath(m.snapshotId)));
  if (snapshot == null) return `(no snapshot available for ${m.label})`;
  return summarizeSessionContent(snapshot, 12, maxLen);
}

export function nodeForSession(nodes: GroveNode[], sessionFile: string | null): GroveNode | undefined {
  if (!sessionFile) return undefined;
  const ref = path.basename(sessionFile);
  let best: GroveNode | undefined;
  for (const n of nodes) {
    if (n.manifest?.sessionId !== ref) continue;
    if (!best || n.timestamp > best.timestamp) best = n;
  }
  return best;
}

export function nodeAtChange(nodes: GroveNode[], changeId: string): GroveNode | undefined {
  return nodes.find((n) => n.changeId === changeId);
}

/** Nearest ancestor node on the same session before an anchor ordinal. */
export function nearestParentNode(
  nodes: GroveNode[],
  sessionId: string,
  anchor: SessionAnchor,
): GroveNode | undefined {
  const same = nodes
    .filter((n) => n.manifest?.sessionId === sessionId && n.manifest.kind !== "root")
    .sort((a, b) => (a.manifest!.anchor.ordinal ?? -1) - (b.manifest!.anchor.ordinal ?? -1));
  const ord = anchor.ordinal ?? Number.POSITIVE_INFINITY;
  let best: GroveNode | undefined;
  for (const n of same) {
    const nOrd = n.manifest!.anchor.ordinal ?? -1;
    if (nOrd <= ord) best = n;
  }
  return best;
}

export function canAutoAmend(nodes: GroveNode[], changeId: string): { ok: true } | { ok: false; reason: string } {
  const n = nodes.find((x) => x.changeId === changeId);
  if (!n?.manifest) return { ok: false, reason: "node missing" };
  if (n.manifest.kind !== "auto") return { ok: false, reason: "not an auto node" };
  if (n.manifest.lifecycle !== "draft") return { ok: false, reason: `lifecycle is ${n.manifest.lifecycle}` };
  if (nodes.some((c) => c.parents.includes(changeId))) return { ok: false, reason: "has children" };
  return { ok: true };
}
