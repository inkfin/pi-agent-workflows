/**
 * grove/lib/journal.ts — pending intents + operation receipts (local only)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ForkFrom, SessionAnchor } from "../backend/types";

export type OpKind =
  | "checkpoint"
  | "fork"
  | "goto"
  | "merge"
  | "pick"
  | "undo"
  | "auto"
  | "sync_push"
  | "sync_pull"
  | "amend";

export interface PendingIntent {
  id: string;
  op: OpKind;
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
  completedAt: string;
  undone?: boolean;
}

export interface JournalState {
  version: 1;
  pending: PendingIntent | null;
  receipts: OpReceipt[];
  /** High-confidence replace target for harness. */
  replaceTarget?: string | null;
  lastAligned?: {
    changeId: string;
    sessionId: string;
    anchor: SessionAnchor;
  };
  pendingFork?: ForkFrom | null;
}

function journalPath(repoDir: string): string {
  return path.join(repoDir, "journal", "state.json");
}

export function loadJournal(repoDir: string): JournalState {
  try {
    const raw = fs.readFileSync(journalPath(repoDir), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1) return parsed as JournalState;
  } catch {
    /* fresh */
  }
  return { version: 1, pending: null, receipts: [] };
}

export function saveJournal(repoDir: string, state: JournalState): void {
  const fp = journalPath(repoDir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(state, null, 2));
}

export function newIntentId(): string {
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
