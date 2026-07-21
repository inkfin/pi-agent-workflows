/**
 * grove/mapping/coordinator.ts — logical ops with preOpId + receipts
 */

import type { TreeBackend, SessionAnchor } from "../backend/types";
import {
  loadJournal,
  saveJournal,
  newIntentId,
  type JournalState,
  type OpKind,
  type OpReceipt,
  type PendingIntent,
} from "../lib/journal";

export class OperationCoordinator {
  constructor(private be: TreeBackend) {}

  private journal(): JournalState {
    return loadJournal(this.be.repoDir());
  }

  private save(state: JournalState): void {
    saveJournal(this.be.repoDir(), state);
  }

  async begin(op: OpKind, payload: Record<string, unknown> = {}): Promise<PendingIntent> {
    await this.be.ensureRepo();
    const preOpId = await this.be.currentOperationId();
    const intent: PendingIntent = {
      id: newIntentId(),
      op,
      step: "started",
      preOpId,
      payload,
      startedAt: new Date().toISOString(),
    };
    const j = this.journal();
    j.pending = intent;
    this.save(j);
    return intent;
  }

  mark(step: PendingIntent["step"], error?: string): void {
    const j = this.journal();
    if (!j.pending) return;
    j.pending.step = step;
    if (error) j.pending.error = error;
    this.save(j);
  }

  async succeed(changeId?: string): Promise<OpReceipt> {
    const j = this.journal();
    const pending = j.pending;
    if (!pending) throw new Error("grove: no pending intent");
    const postOpId = await this.be.currentOperationId();
    const receipt: OpReceipt = {
      id: pending.id,
      op: pending.op,
      preOpId: pending.preOpId ?? "",
      postOpId,
      changeId,
      completedAt: new Date().toISOString(),
    };
    j.receipts.unshift(receipt);
    j.receipts = j.receipts.slice(0, 50);
    j.pending = null;
    this.save(j);
    return receipt;
  }

  async failAndRestore(error: string): Promise<void> {
    const j = this.journal();
    const pending = j.pending;
    if (pending?.preOpId) {
      try {
        await this.be.restoreOperation(pending.preOpId);
      } catch {
        /* best-effort */
      }
    }
    if (pending) {
      pending.step = "failed";
      pending.error = error;
    }
    j.pending = pending;
    this.save(j);
  }

  clearPending(): void {
    const j = this.journal();
    j.pending = null;
    this.save(j);
  }

  lastReceipt(): OpReceipt | undefined {
    return this.journal().receipts.find((r) => !r.undone);
  }

  async undoLast(): Promise<OpReceipt | null> {
    const j = this.journal();
    const receipt = j.receipts.find((r) => !r.undone);
    if (!receipt?.preOpId) {
      await this.be.undo();
      return null;
    }
    await this.be.restoreOperation(receipt.preOpId);
    receipt.undone = true;
    this.save(j);
    return receipt;
  }

  setReplaceTarget(changeId: string | null): void {
    const j = this.journal();
    j.replaceTarget = changeId;
    this.save(j);
  }

  getReplaceTarget(): string | null {
    return this.journal().replaceTarget ?? null;
  }

  setPendingFork(forkFrom: JournalState["pendingFork"]): void {
    const j = this.journal();
    j.pendingFork = forkFrom;
    this.save(j);
  }

  consumePendingFork(): JournalState["pendingFork"] {
    const j = this.journal();
    const f = j.pendingFork ?? null;
    j.pendingFork = null;
    this.save(j);
    return f;
  }

  setAligned(changeId: string, sessionId: string, anchor: SessionAnchor): void {
    const j = this.journal();
    j.lastAligned = { changeId, sessionId, anchor };
    this.save(j);
  }
}

export function pendingSummary(repoDir: string): string | null {
  const j = loadJournal(repoDir);
  if (j.pending && j.pending.step !== "done") {
    return `pending ${j.pending.op} (${j.pending.step})${j.pending.error ? `: ${j.pending.error}` : ""}`;
  }
  return null;
}
