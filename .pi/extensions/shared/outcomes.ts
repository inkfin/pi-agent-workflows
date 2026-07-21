/**
 * Durable protocol shared by Orchestrator producers and Grove consumers.
 *
 * Session entries are the source of truth. EventBus notifications only tell a
 * consumer that it may be worth rescanning those entries.
 */

import { createHash, randomUUID } from "node:crypto";

export const OUTCOME_PROTOCOL_VERSION = 1 as const;
export const ORCHESTRATOR_RUN_ENTRY = "orchestrator-run" as const;
export const GROVE_ATTACHMENT_PROPOSAL_ENTRY = "grove-attachment-proposal" as const;
export const GROVE_PROPOSAL_PENDING_EVENT = "grove:proposal-pending" as const;

export type WorkspaceEffect = "none" | "applied";
export type BuildAttemptStatus = "running" | "succeeded" | "failed" | "cancelled";

interface RunEventBase {
  v: typeof OUTCOME_PROTOCOL_VERSION;
  eventId: string;
  occurredAt: string;
  sessionId: string;
  workItemId: string;
}

interface BuildRunEventBase extends RunEventBase {
  buildAttemptId: string;
  planRevision: number;
  sequence: number;
  baseNodeId: string | null;
  baseCodeRevision: string | null;
}

export interface PlanRevisionRunEvent extends RunEventBase {
  type: "plan_revision_published";
  planRevision: number;
  contentHash: string;
  plan: unknown;
}

export interface BuildAttemptStartedEvent extends BuildRunEventBase {
  type: "build_attempt_started";
  status: "running";
}

export interface BuildAttemptFinishedEvent extends BuildRunEventBase {
  type: "build_attempt_finished";
  status: Exclude<BuildAttemptStatus, "running">;
  workspaceEffect: WorkspaceEffect;
  outcome: unknown;
  error?: string;
}

export type RunEvent =
  | PlanRevisionRunEvent
  | BuildAttemptStartedEvent
  | BuildAttemptFinishedEvent;

export interface AttachmentProposal {
  v: typeof OUTCOME_PROTOCOL_VERSION;
  type: "attachment_proposal";
  eventId: string;
  sourceEventId: string;
  occurredAt: string;
  sessionId: string;
  projectId: string;
  slotId: string;
  workItemId: string;
  buildAttemptId: string;
  planRevision: number;
  sequence: number;
  baseNodeId: string | null;
  baseCodeRevision: string | null;
  kind:
    | "execution_outcome"
    | "summary"
    | "execution_plan"
    | "decision"
    | "research_report";
  producer: {
    extension: "orchestrator";
    sourceId: string;
  };
  contentHash: string;
  payload: unknown;
}

export interface ProposalPendingHint {
  v: typeof OUTCOME_PROTOCOL_VERSION;
  sessionId: string;
  eventId: string;
}

export function newProtocolId(prefix: "work" | "attempt" | "event"): string {
  return `${prefix}_${randomUUID()}`;
}

/** Stable for one logical Grove draft slot, without depending on worktree paths. */
export function outcomeSlotId(input: {
  sessionId: string;
  baseNodeId: string | null;
  workItemId: string;
}): string {
  return `slot_${contentHash(input).slice(0, 32)}`;
}

/** Canonical JSON hash used for proposal idempotency and content addressing. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}
