/**
 * Foreground-only consumer for durable Orchestrator AttachmentProposals.
 *
 * Pi session entries are the WAL. EventBus merely asks this reconciler to run.
 */

import * as path from "node:path";
import {
  GROVE_ATTACHMENT_PROPOSAL_ENTRY,
  OUTCOME_PROTOCOL_VERSION,
  canonicalJson,
  contentHash as protocolContentHash,
  type AttachmentProposal,
} from "../../shared/outcomes";
import type {
  AttachmentRecord,
  DispositionRecord,
  EdgeRecord,
  SessionNode,
  SessionNodeRecord,
  TreeBackend,
} from "../backend/types";
import { isEffectivelySealed, newDomainId } from "../backend/types";
import { codeState, machineId, projectInfo } from "../lib/identity";
import { captureAnchor, sha256 } from "../lib/sessions";
import { buildSnapshotFromSession, redact, snapshotPath } from "../lib/snapshots";
import { OperationCoordinator } from "./coordinator";
import { lineageEdge } from "./ops";

interface SessionEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

export const MAX_ATTACHMENT_BYTES = 256 * 1024;

export interface CaptureResult {
  proposal: AttachmentProposal;
  status: "created" | "amended" | "attached" | "duplicate" | "rejected";
  node?: SessionNode;
  reason?: string;
}

export function attachmentProposals(entries: SessionEntry[]): Array<{
  proposal: AttachmentProposal;
  cursor: number;
}> {
  const proposals: Array<{ proposal: AttachmentProposal; cursor: number }> = [];
  entries.forEach((entry, cursor) => {
    if (
      entry.type !== "custom" ||
      entry.customType !== GROVE_ATTACHMENT_PROPOSAL_ENTRY ||
      !isAttachmentProposal(entry.data)
    ) {
      return;
    }
    proposals.push({ proposal: entry.data, cursor });
  });
  return proposals;
}

export function isAttachmentProposal(value: unknown): value is AttachmentProposal {
  const proposal = value as Partial<AttachmentProposal> | null;
  return Boolean(
    proposal &&
      proposal.v === OUTCOME_PROTOCOL_VERSION &&
      proposal.type === "attachment_proposal" &&
      typeof proposal.eventId === "string" &&
      typeof proposal.sourceEventId === "string" &&
      typeof proposal.sessionId === "string" &&
      typeof proposal.projectId === "string" &&
      typeof proposal.slotId === "string" &&
      typeof proposal.workItemId === "string" &&
      typeof proposal.buildAttemptId === "string" &&
      typeof proposal.sequence === "number" &&
      ["execution_outcome", "summary", "execution_plan", "decision", "research_report"].includes(
        String(proposal.kind),
      ) &&
      typeof proposal.contentHash === "string",
  );
}

function attachmentFor(
  proposal: AttachmentProposal,
  targetNodeId: string,
): { record: AttachmentRecord; files: Record<string, string> } {
  const canonical = canonicalJson(proposal.payload);
  const redacted = redact(canonical);
  const bytes = Buffer.byteLength(redacted, "utf8");
  const payload = bytes <= MAX_ATTACHMENT_BYTES
    ? redacted
    : canonicalJson({
        truncated: true,
        originalBytes: bytes,
        preview: Buffer.from(redacted, "utf8")
          .subarray(0, MAX_ATTACHMENT_BYTES / 2)
          .toString("utf8"),
      });
  const redactedHash = sha256(payload);
  const payloadPath = `objects/${redactedHash}.json`;
  const attachmentId = `attachment_${sha256(
    `${proposal.kind}:${proposal.eventId}:${redactedHash}`,
  )}`;
  return {
    record: {
      v: 1,
      recordType: "attachment",
      attachmentId,
      targetNodeId,
      kind: proposal.kind,
      producer: {
        extension: proposal.producer.extension,
        sourceId: proposal.eventId,
      },
      contentHash: redactedHash,
      payloadPath,
      createdAt: proposal.occurredAt,
    },
    files: { [payloadPath]: payload },
  };
}

function disposition(
  targetType: DispositionRecord["targetType"],
  targetId: string,
  action: DispositionRecord["action"],
): DispositionRecord {
  return {
    v: 1,
    recordType: "disposition",
    dispositionId: newDomainId("disposition"),
    targetType,
    targetId,
    action,
    createdAt: new Date().toISOString(),
  };
}

function proposalAlreadyCommitted(
  proposal: AttachmentProposal,
  nodes: SessionNode[],
  attachments: AttachmentRecord[],
  dispositions: DispositionRecord[],
): boolean {
  return (
    nodes.some((node) => node.capture.latestEventId === proposal.eventId) ||
    attachments.some((attachment) => attachment.producer.sourceId === proposal.eventId) ||
    dispositions.some(
      (record) => record.targetType === "proposal" && record.targetId === proposal.eventId,
    )
  );
}

function capturedNode(
  cwd: string,
  sessionFile: string,
  entryId: string | null,
  proposal: AttachmentProposal,
  snapshotId: string,
): SessionNodeRecord {
  const project = projectInfo(cwd);
  const now = new Date().toISOString();
  return {
    v: 1,
    recordType: "node",
    nodeId: newDomainId("node"),
    revision: 1,
    label: `build r${proposal.planRevision}`,
    projectId: project.projectId,
    sessionId: path.basename(sessionFile),
    snapshotId,
    anchor: captureAnchor(sessionFile, entryId),
    capture: {
      source: "orchestrator",
      slotId: proposal.slotId,
      latestEventId: proposal.eventId,
      sequence: proposal.sequence,
    },
    state: "draft",
    pinned: false,
    project: { name: project.name, vcsRemote: project.vcsRemote },
    code: codeState(cwd),
    origin: machineId(),
    createdAt: now,
    updatedAt: now,
  };
}

export async function captureProposal(
  backend: TreeBackend,
  cwd: string,
  opts: {
    sessionFile: string;
    entryId: string | null;
    proposal: AttachmentProposal;
    cursor: number;
  },
): Promise<CaptureResult> {
  const { proposal } = opts;
  const sessionId = path.basename(opts.sessionFile);
  const project = projectInfo(cwd);
  if (proposal.projectId !== project.projectId || proposal.sessionId !== sessionId) {
    return { proposal, status: "rejected", reason: "proposal project/session mismatch" };
  }
  if (protocolContentHash(proposal.payload) !== proposal.contentHash) {
    return { proposal, status: "rejected", reason: "proposal content hash mismatch" };
  }

  const coordinator = new OperationCoordinator(backend);
  const graph = await backend.getGraph();
  if (
    coordinator.eventProcessed(sessionId, proposal.eventId) ||
    proposalAlreadyCommitted(
      proposal,
      graph.nodes,
      graph.attachments,
      graph.dispositions,
    )
  ) {
    coordinator.markEventProcessed(sessionId, proposal.eventId, opts.cursor);
    return { proposal, status: "duplicate" };
  }

  const sameSlot = graph.nodes
    .filter((node) => node.capture.slotId === proposal.slotId)
    .sort((a, b) => b.revision - a.revision)[0];
  if (sameSlot && proposal.sequence < (sameSlot.capture.sequence ?? 0)) {
    await backend.applyGraphTransaction({
      records: [disposition("proposal", proposal.eventId, "rejected")],
      expectedGraphRevision: graph.revision,
    });
    coordinator.markEventProcessed(sessionId, proposal.eventId, opts.cursor);
    return { proposal, status: "rejected", reason: "stale proposal sequence" };
  }

  if (sameSlot && proposal.sequence === (sameSlot.capture.sequence ?? 0)) {
    if (
      graph.attachments.some(
        (attachment) =>
          attachment.targetNodeId === sameSlot.nodeId &&
          attachment.kind === proposal.kind,
      )
    ) {
      await backend.applyGraphTransaction({
        records: [disposition("proposal", proposal.eventId, "rejected")],
        expectedGraphRevision: graph.revision,
      });
      coordinator.markEventProcessed(sessionId, proposal.eventId, opts.cursor);
      return { proposal, status: "rejected", reason: "attachment kind already finalized for slot sequence" };
    }
    await coordinator.begin("attachment", {
      eventId: proposal.eventId,
      slotId: proposal.slotId,
      targetNodeId: sameSlot.nodeId,
    }, sessionId);
    try {
      const { record, files } = attachmentFor(proposal, sameSlot.nodeId);
      const attachment = await backend.appendAttachment({
        attachment: record,
        files,
        expectedGraphRevision: graph.revision,
      });
      await coordinator.succeed(attachment.backendRef.changeId, sameSlot.nodeId);
      coordinator.markEventProcessed(sessionId, proposal.eventId, opts.cursor);
      return { proposal, status: "attached", node: sameSlot };
    } catch (error: any) {
      await coordinator.failAndRestore(error?.message ?? String(error));
      throw error;
    }
  }

  const snapshot = buildSnapshotFromSession(opts.sessionFile);
  await coordinator.begin("capture", {
    eventId: proposal.eventId,
    slotId: proposal.slotId,
    baseNodeId: proposal.baseNodeId,
  }, sessionId);
  try {
    if (
      sameSlot &&
      !isEffectivelySealed(sameSlot, graph.edges) &&
      sameSlot.sessionId === sessionId &&
      sameSlot.capture.source === "orchestrator"
    ) {
      const { record: attachment, files } = attachmentFor(proposal, sameSlot.nodeId);
      const priorOutcomes = graph.attachments.filter(
        (item) =>
          item.targetNodeId === sameSlot.nodeId &&
          item.kind === proposal.kind &&
          item.attachmentId !== attachment.attachmentId,
      );
      const { backendRef: _backendRef, ...current } = sameSlot;
      const next: SessionNodeRecord = {
        ...current,
        revision: sameSlot.revision + 1,
        label: `build r${proposal.planRevision}`,
        snapshotId: snapshot.snapshotId,
        anchor: captureAnchor(opts.sessionFile, opts.entryId),
        capture: {
          ...sameSlot.capture,
          latestEventId: proposal.eventId,
          sequence: proposal.sequence,
        },
        code: codeState(cwd),
        updatedAt: new Date().toISOString(),
      };
      const oldPaths = [
        ...(sameSlot.snapshotId && sameSlot.snapshotId !== snapshot.snapshotId
          ? [snapshotPath(sameSlot.snapshotId)]
          : []),
        ...priorOutcomes
          .map((item) => item.payloadPath)
          .filter((item): item is string => Boolean(item && item !== attachment.payloadPath)),
      ];
      await backend.applyGraphTransaction({
        records: [
          next,
          attachment,
          ...priorOutcomes.map((item) =>
            disposition("attachment", item.attachmentId, "tombstoned"),
          ),
        ],
        files: { ...snapshot.files, ...files },
        deleteFiles: [...new Set(oldPaths)],
        expectedGraphRevision: graph.revision,
      });
      const node = (await backend.getNode(sameSlot.nodeId))!;
      await coordinator.succeed(node.backendRef.changeId, node.nodeId);
      coordinator.markEventProcessed(sessionId, proposal.eventId, opts.cursor);
      return { proposal, status: "amended", node };
    }

    const node = capturedNode(
      cwd,
      opts.sessionFile,
      opts.entryId,
      proposal,
      snapshot.snapshotId,
    );
    const { record: attachment, files } = attachmentFor(proposal, node.nodeId);
    const edges: EdgeRecord[] = [];
    if (proposal.baseNodeId) {
      if (!graph.nodes.some((candidate) => candidate.nodeId === proposal.baseNodeId)) {
        throw new Error(`grove: proposal base node missing: ${proposal.baseNodeId}`);
      }
      edges.push(lineageEdge(proposal.baseNodeId, node.nodeId));
    }
    const materialized = await backend.recordNode({
      node,
      edges,
      attachments: [attachment],
      files: { ...snapshot.files, ...files },
      expectedGraphRevision: graph.revision,
    });
    await coordinator.succeed(materialized.backendRef.changeId, materialized.nodeId);
    coordinator.markEventProcessed(sessionId, proposal.eventId, opts.cursor);
    return { proposal, status: "created", node: materialized };
  } catch (error: any) {
    await coordinator.failAndRestore(error?.message ?? String(error));
    throw error;
  }
}

export async function reconcileProposals(
  backend: TreeBackend,
  cwd: string,
  opts: {
    sessionFile: string | null;
    entryId: string | null;
    entries: SessionEntry[];
  },
): Promise<CaptureResult[]> {
  if (!opts.sessionFile) return [];
  const results: CaptureResult[] = [];
  for (const item of attachmentProposals(opts.entries)) {
    results.push(
      await captureProposal(backend, cwd, {
        sessionFile: opts.sessionFile,
        entryId: opts.entryId,
        proposal: item.proposal,
        cursor: item.cursor,
      }),
    );
  }
  return results;
}

/**
 * Explicit foreground seam for a future worktree-outcome picker. Promotion is
 * the same validated transaction path as automatic capture; callers cannot
 * bypass project/base/sequence/idempotency checks.
 */
export async function promoteWorktreeOutcome(
  backend: TreeBackend,
  cwd: string,
  opts: {
    sessionFile: string;
    entryId: string | null;
    proposal: AttachmentProposal;
    cursor: number;
  },
): Promise<CaptureResult> {
  return captureProposal(backend, cwd, opts);
}
