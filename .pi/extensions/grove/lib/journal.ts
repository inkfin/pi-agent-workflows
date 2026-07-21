/**
 * Local operation journal. This is a recovery cache; GraphTransactions and
 * Pi session entries remain the durable truth.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionAnchor } from "../backend/types";
import type { ForkRef } from "../mapping/ops";

export type OpKind =
  | "checkpoint"
  | "fork"
  | "goto"
  | "merge"
  | "pick"
  | "undo"
  | "auto"
  | "capture"
  | "edge"
  | "attachment"
  | "pin"
  | "sync_push"
  | "sync_pull"
  | "amend";

export interface PendingIntent {
  id: string;
  op: OpKind;
  sessionId?: string;
  step: "started" | "pi" | "jj" | "done" | "failed";
  preOpId?: string;
  payload: Record<string, unknown>;
  startedAt: string;
  error?: string;
}

export interface OpReceipt {
  id: string;
  op: OpKind;
  preOpId: string;
  postOpId?: string;
  changeId?: string;
  nodeId?: string;
  eventId?: string;
  completedAt: string;
  undone?: boolean;
}

export interface SessionInbox {
  cursor: number;
  processedEventIds: string[];
  rejectedEventIds: string[];
}

export interface JournalState {
  version: 1;
  pendingOp: PendingIntent | null;
  receipts: OpReceipt[];
  inboxBySession: Record<string, SessionInbox>;
  replaceTargetNodeId?: string | null;
  lastAligned?: {
    nodeId: string;
    sessionId: string;
    anchor: SessionAnchor;
  };
  pendingFork?: ForkRef | null;
}

function journalPath(repoDir: string): string {
  return path.join(repoDir, "journal", "state.json");
}

export function loadJournal(repoDir: string): JournalState {
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath(repoDir), "utf-8"));
    if (
      parsed?.version === 1 &&
      Object.prototype.hasOwnProperty.call(parsed, "pendingOp") &&
      parsed.inboxBySession &&
      typeof parsed.inboxBySession === "object"
    ) {
      return parsed as JournalState;
    }
  } catch {
    /* fresh or obsolete pre-release state */
  }
  return {
    version: 1,
    pendingOp: null,
    receipts: [],
    inboxBySession: {},
  };
}

export function saveJournal(repoDir: string, state: JournalState): void {
  const file = journalPath(repoDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, file);
}

export function inboxFor(state: JournalState, sessionId: string): SessionInbox {
  return state.inboxBySession[sessionId] ?? {
    cursor: 0,
    processedEventIds: [],
    rejectedEventIds: [],
  };
}

export function newIntentId(): string {
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
