/**
 * Pi session ↔ Grove semantic graph operations.
 */

import * as path from "node:path";
import type {
  AttachmentRecord,
  EdgeRecord,
  GroveGraph,
  SessionAnchor,
  SessionNode,
  SessionNodeRecord,
  TreeBackend,
} from "../backend/types";
import { isEffectivelySealed, newDomainId } from "../backend/types";
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

export { redact };

export interface ForkRef {
  parentNodeId: string;
  parentSessionId: string;
  parentAnchor: SessionAnchor;
}

function nodeRecord(
  cwd: string,
  opts: {
    label: string;
    sessionId: string;
    anchor: SessionAnchor;
    snapshotId: string | null;
    source: SessionNodeRecord["capture"]["source"];
    state?: SessionNodeRecord["state"];
    pinned?: boolean;
    slotId?: string;
    eventId?: string;
    sequence?: number;
  },
): SessionNodeRecord {
  const project = projectInfo(cwd);
  const now = new Date().toISOString();
  return {
    v: 1,
    recordType: "node",
    nodeId: newDomainId("node"),
    revision: 1,
    label: opts.label,
    projectId: project.projectId,
    sessionId: opts.sessionId,
    snapshotId: opts.snapshotId,
    anchor: opts.anchor,
    capture: {
      source: opts.source,
      slotId: opts.slotId,
      latestEventId: opts.eventId,
      sequence: opts.sequence,
    },
    state: opts.state ?? "draft",
    pinned: opts.pinned ?? false,
    project: { name: project.name, vcsRemote: project.vcsRemote },
    origin: machineId(),
    code: codeState(cwd),
    createdAt: now,
    updatedAt: now,
  };
}

export function lineageEdge(fromNodeId: string, toNodeId: string): EdgeRecord {
  return {
    v: 1,
    recordType: "edge",
    edgeId: newDomainId("edge"),
    revision: 1,
    fromNodeId,
    toNodeId,
    kind: "lineage",
    state: "active",
    createdAt: new Date().toISOString(),
  };
}

function currentNode(graph: GroveGraph, currentChangeId: string): SessionNode | undefined {
  return graph.nodes.find((node) => node.backendRef.changeId === currentChangeId);
}

function latestSessionNode(graph: GroveGraph, sessionId: string): SessionNode | undefined {
  return graph.nodes
    .filter((node) => node.sessionId === sessionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

async function baseNodeFor(
  be: TreeBackend,
  graph: GroveGraph,
  sessionId: string,
): Promise<SessionNode | undefined> {
  return currentNode(graph, await be.currentChangeId()) ?? latestSessionNode(graph, sessionId);
}

export async function checkpointSession(
  be: TreeBackend,
  cwd: string,
  opts: { label: string; sessionFile: string; entryId: string | null },
): Promise<SessionNode> {
  const coordinator = new OperationCoordinator(be);
  await coordinator.begin("checkpoint", { label: opts.label });
  try {
    const sessionId = path.basename(opts.sessionFile);
    const anchor = captureAnchor(opts.sessionFile, opts.entryId);
    const snapshot = buildSnapshotFromSession(opts.sessionFile);
    const graph = await be.getGraph();
    const base = await baseNodeFor(be, graph, sessionId);
    const node = nodeRecord(cwd, {
      label: opts.label,
      sessionId,
      anchor,
      snapshotId: snapshot.snapshotId,
      source: "manual",
      state: "sealed",
      pinned: true,
    });
    const materialized = await be.recordNode({
      node,
      edges: base ? [lineageEdge(base.nodeId, node.nodeId)] : [],
      files: snapshot.files,
      expectedGraphRevision: graph.revision,
    });
    await coordinator.succeed(materialized.backendRef.changeId, materialized.nodeId);
    coordinator.setAligned(materialized.nodeId, sessionId, anchor);
    return materialized;
  } catch (error: any) {
    await coordinator.failAndRestore(error?.message ?? String(error));
    throw error;
  }
}

export async function recordFork(
  be: TreeBackend,
  cwd: string,
  opts: {
    sessionFile: string;
    entryId: string | null;
    forkFrom: ForkRef;
    snapshotFile?: string;
  },
): Promise<SessionNode> {
  const coordinator = new OperationCoordinator(be);
  await coordinator.begin("fork", { parentNodeId: opts.forkFrom.parentNodeId });
  try {
    const sessionId = path.basename(opts.sessionFile);
    const anchor = captureAnchor(opts.sessionFile, opts.entryId);
    const snapshot = opts.snapshotFile ? buildSnapshotFromSession(opts.snapshotFile) : undefined;
    const graph = await be.getGraph();
    if (!graph.nodes.some((node) => node.nodeId === opts.forkFrom.parentNodeId)) {
      throw new Error(`grove: fork parent missing: ${opts.forkFrom.parentNodeId}`);
    }
    const node = nodeRecord(cwd, {
      label: `fork: ${sessionId.replace(/\.jsonl$/, "")}`,
      sessionId,
      anchor,
      snapshotId: snapshot?.snapshotId ?? null,
      source: "manual",
    });
    const materialized = await be.recordNode({
      node,
      edges: [lineageEdge(opts.forkFrom.parentNodeId, node.nodeId)],
      files: snapshot?.files,
      expectedGraphRevision: graph.revision,
    });
    await coordinator.succeed(materialized.backendRef.changeId, materialized.nodeId);
    coordinator.setAligned(materialized.nodeId, sessionId, anchor);
    return materialized;
  } catch (error: any) {
    await coordinator.failAndRestore(error?.message ?? String(error));
    throw error;
  }
}

export async function recordContextInjection(
  be: TreeBackend,
  cwd: string,
  opts: {
    label: string;
    sessionFile: string;
    source: SessionNode;
    payload: string;
  },
): Promise<SessionNode> {
  const coordinator = new OperationCoordinator(be);
  await coordinator.begin("merge", { sourceNodeId: opts.source.nodeId });
  try {
    const sessionId = path.basename(opts.sessionFile);
    const anchor = captureAnchor(opts.sessionFile, null);
    const snapshot = buildSnapshotFromSession(opts.sessionFile);
    const graph = await be.getGraph();
    const base = await baseNodeFor(be, graph, sessionId);
    const node = nodeRecord(cwd, {
      label: opts.label,
      sessionId,
      anchor,
      snapshotId: snapshot.snapshotId,
      source: "manual",
    });
    const contentHash = sha256(opts.payload);
    const payloadPath = `objects/${contentHash}.json`;
    const attachment: AttachmentRecord = {
      v: 1,
      recordType: "attachment",
      attachmentId: `attachment_context_${contentHash}`,
      targetNodeId: node.nodeId,
      kind: "context_injection",
      producer: { extension: "grove", sourceId: opts.source.nodeId },
      contentHash,
      payloadPath,
      createdAt: new Date().toISOString(),
    };
    const edges: EdgeRecord[] = [];
    if (base) edges.push(lineageEdge(base.nodeId, node.nodeId));
    edges.push({
      v: 1,
      recordType: "edge",
      edgeId: newDomainId("edge"),
      revision: 1,
      fromNodeId: opts.source.nodeId,
      toNodeId: node.nodeId,
      kind: "context",
      state: "active",
      payloadHash: contentHash,
      createdAt: new Date().toISOString(),
    });
    const materialized = await be.recordNode({
      node,
      edges,
      attachments: [attachment],
      files: { ...snapshot.files, [payloadPath]: JSON.stringify({ content: redact(opts.payload) }) },
      expectedGraphRevision: graph.revision,
    });
    await coordinator.succeed(materialized.backendRef.changeId, materialized.nodeId);
    coordinator.setAligned(materialized.nodeId, sessionId, anchor);
    return materialized;
  } catch (error: any) {
    await coordinator.failAndRestore(error?.message ?? String(error));
    throw error;
  }
}

/** Legacy dirty-worktree capture. Outcome capture uses mapping/capture.ts. */
async function recordOrAmendAutoInner(
  be: TreeBackend,
  cwd: string,
  opts: {
    sessionFile: string;
    entryId: string | null;
    replaceNodeId?: string | null;
    supersedesNodeId?: string | null;
  },
): Promise<SessionNode> {
  const sessionId = path.basename(opts.sessionFile);
  const anchor = captureAnchor(opts.sessionFile, opts.entryId);
  const snapshot = buildSnapshotFromSession(opts.sessionFile);
  const graph = await be.getGraph();

  if (opts.replaceNodeId) {
    const target = graph.nodes.find((node) => node.nodeId === opts.replaceNodeId);
    if (target && canAutoAmend(graph, target.nodeId).ok) {
      const oldPath = target.snapshotId ? snapshotPath(target.snapshotId) : undefined;
      return be.amendDraft({
        nodeId: target.nodeId,
        expectedRevision: target.revision,
        expectedGraphRevision: graph.revision,
        patch: {
          label: `auto ${new Date().toISOString().slice(0, 16)}`,
          snapshotId: snapshot.snapshotId,
          anchor,
          code: codeState(cwd),
          capture: {
            ...target.capture,
            sequence: (target.capture.sequence ?? 0) + 1,
          },
        },
        files: snapshot.files,
        deleteFiles: oldPath && oldPath !== snapshotPath(snapshot.snapshotId) ? [oldPath] : [],
      });
    }
  }

  const base = await baseNodeFor(be, graph, sessionId);
  const node = nodeRecord(cwd, {
    label: `auto ${new Date().toISOString().slice(0, 16)}`,
    sessionId,
    anchor,
    snapshotId: snapshot.snapshotId,
    source: "harness",
    slotId: `legacy:${sessionId}:${base?.nodeId ?? "root"}`,
    sequence: 1,
  });
  const edges: EdgeRecord[] = [];
  if (base) edges.push(lineageEdge(base.nodeId, node.nodeId));
  if (opts.supersedesNodeId) {
    edges.push({
      v: 1,
      recordType: "edge",
      edgeId: newDomainId("edge"),
      revision: 1,
      fromNodeId: opts.supersedesNodeId,
      toNodeId: node.nodeId,
      kind: "supersedes",
      state: "active",
      createdAt: new Date().toISOString(),
    });
  }
  return be.recordNode({
    node,
    edges,
    files: snapshot.files,
    expectedGraphRevision: graph.revision,
  });
}

export async function recordOrAmendAuto(
  be: TreeBackend,
  cwd: string,
  opts: {
    sessionFile: string;
    entryId: string | null;
    replaceNodeId?: string | null;
    supersedesNodeId?: string | null;
  },
): Promise<SessionNode> {
  const coordinator = new OperationCoordinator(be);
  await coordinator.begin("auto", {
    replaceNodeId: opts.replaceNodeId,
    supersedesNodeId: opts.supersedesNodeId,
  }, path.basename(opts.sessionFile));
  try {
    const node = await recordOrAmendAutoInner(be, cwd, opts);
    await coordinator.succeed(node.backendRef.changeId, node.nodeId);
    return node;
  } catch (error: any) {
    await coordinator.failAndRestore(error?.message ?? String(error));
    throw error;
  }
}

export async function pinNode(be: TreeBackend, nodeId: string): Promise<SessionNode> {
  const coordinator = new OperationCoordinator(be);
  await coordinator.begin("pin", { nodeId });
  try {
  const graph = await be.getGraph();
  const target = graph.nodes.find((node) => node.nodeId === nodeId);
  if (!target) throw new Error(`Node not found: ${nodeId}`);
  if (target.pinned) {
    await coordinator.succeed(target.backendRef.changeId, target.nodeId);
    return target;
  }
  const { backendRef: _backendRef, ...record } = target;
  await be.applyGraphTransaction({
    records: [{
      ...record,
      revision: target.revision + 1,
      pinned: true,
      updatedAt: new Date().toISOString(),
    }],
    expectedGraphRevision: graph.revision,
  });
    const node = (await be.getNode(nodeId))!;
    await coordinator.succeed(node.backendRef.changeId, node.nodeId);
    return node;
  } catch (error: any) {
    await coordinator.failAndRestore(error?.message ?? String(error));
    throw error;
  }
}

export async function ensureSessionAvailable(
  be: TreeBackend,
  cwd: string,
  node: SessionNode,
): Promise<{
  path: string;
  materialized: boolean;
  anchorOk: boolean;
  anchorEntryId: string | null;
  anchorReason?: string;
} | null> {
  const local = resolveSessionRef(cwd, node.sessionId);
  if (local) {
    const resolved = resolveAnchor(local, node.anchor);
    if (resolved.ok) {
      return {
        path: local,
        materialized: false,
        anchorOk: true,
        anchorEntryId: resolved.entryId,
      };
    }
  }
  if (!node.snapshotId) {
    if (!local) return null;
    const resolved = resolveAnchor(local, node.anchor);
    return {
      path: local,
      materialized: false,
      anchorOk: resolved.ok,
      anchorEntryId: resolved.ok ? resolved.entryId : null,
      anchorReason: resolved.ok ? undefined : resolved.reason,
    };
  }
  const objectPath = snapshotPath(node.snapshotId);
  const snapshot =
    (await be.showFile(node.backendRef.changeId, objectPath)) ??
    (await be.showFile("@", objectPath));
  if (snapshot == null) return null;
  const materializedPath = materializeSession(cwd, node.sessionId, snapshot);
  const resolved = resolveAnchor(materializedPath, node.anchor);
  return {
    path: materializedPath,
    materialized: true,
    anchorOk: resolved.ok,
    anchorEntryId: resolved.ok ? resolved.entryId : null,
    anchorReason: resolved.ok ? undefined : resolved.reason,
  };
}

export async function nodeSummaryForInject(
  be: TreeBackend,
  node: SessionNode,
  maxLen = 2000,
): Promise<string> {
  if (!node.snapshotId) return `(no snapshot for ${node.label})`;
  const objectPath = snapshotPath(node.snapshotId);
  const snapshot =
    (await be.showFile(node.backendRef.changeId, objectPath)) ??
    (await be.showFile("@", objectPath));
  return snapshot == null
    ? `(no snapshot available for ${node.label})`
    : summarizeSessionContent(snapshot, 12, maxLen);
}

export function nodeForSession(nodes: SessionNode[], sessionFile: string | null): SessionNode | undefined {
  if (!sessionFile) return undefined;
  const sessionId = path.basename(sessionFile);
  return nodes
    .filter((node) => node.sessionId === sessionId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

export function nodeAtId(nodes: SessionNode[], nodeId: string): SessionNode | undefined {
  return nodes.find((node) => node.nodeId === nodeId);
}

export function nearestParentNode(
  graph: GroveGraph,
  sessionId: string,
  anchor: SessionAnchor,
): SessionNode | undefined {
  const ordinal = anchor.ordinal ?? Number.POSITIVE_INFINITY;
  return graph.nodes
    .filter((node) => node.sessionId === sessionId && (node.anchor.ordinal ?? -1) <= ordinal)
    .sort((a, b) => (b.anchor.ordinal ?? -1) - (a.anchor.ordinal ?? -1))[0];
}

export function canAutoAmend(
  graph: GroveGraph,
  nodeId: string,
): { ok: true } | { ok: false; reason: string } {
  const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node) return { ok: false, reason: "node missing" };
  if (node.capture.source !== "harness" && node.capture.source !== "orchestrator") {
    return { ok: false, reason: "not an automatic node" };
  }
  if (isEffectivelySealed(node, graph.edges)) return { ok: false, reason: "node is sealed" };
  return { ok: true };
}
