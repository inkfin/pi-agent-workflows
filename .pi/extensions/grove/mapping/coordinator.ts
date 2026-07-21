/**
 * Logical operation coordinator with pre-op restore and durable receipts.
 */

import { newDomainId, type DispositionRecord, type SessionAnchor, type TreeBackend } from "../backend/types";
import {
  inboxFor,
  loadJournal,
  newIntentId,
  saveJournal,
  type JournalState,
  type OpKind,
  type OpReceipt,
  type PendingIntent,
} from "../lib/journal";

export class OperationCoordinator {
  constructor(private readonly backend: TreeBackend) {}

  private journal(): JournalState {
    return loadJournal(this.backend.repoDir());
  }

  private save(state: JournalState): void {
    saveJournal(this.backend.repoDir(), state);
  }

  async begin(
    op: OpKind,
    payload: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<PendingIntent> {
    await this.backend.ensureRepo();
    const intent: PendingIntent = {
      id: newIntentId(),
      op,
      sessionId,
      step: "started",
      preOpId: await this.backend.currentOperationId(),
      payload,
      startedAt: new Date().toISOString(),
    };
    const journal = this.journal();
    if (journal.pendingOp && journal.pendingOp.step !== "failed") {
      throw new Error(`grove: operation already pending: ${journal.pendingOp.op}`);
    }
    journal.pendingOp = intent;
    this.save(journal);
    return intent;
  }

  mark(step: PendingIntent["step"], error?: string): void {
    const journal = this.journal();
    if (!journal.pendingOp) return;
    journal.pendingOp.step = step;
    if (error) journal.pendingOp.error = error;
    this.save(journal);
  }

  async succeed(changeId?: string, nodeId?: string): Promise<OpReceipt> {
    const journal = this.journal();
    const pending = journal.pendingOp;
    if (!pending) throw new Error("grove: no pending intent");
    const receipt: OpReceipt = {
      id: pending.id,
      op: pending.op,
      preOpId: pending.preOpId ?? "",
      postOpId: await this.backend.currentOperationId(),
      changeId,
      nodeId,
      eventId: typeof pending.payload.eventId === "string" ? pending.payload.eventId : undefined,
      completedAt: new Date().toISOString(),
    };
    journal.receipts.unshift(receipt);
    journal.receipts = journal.receipts.slice(0, 100);
    journal.pendingOp = null;
    this.save(journal);
    return receipt;
  }

  async failAndRestore(error: string): Promise<void> {
    const journal = this.journal();
    const pending = journal.pendingOp;
    if (pending?.preOpId) {
      try {
        await this.backend.restoreOperation(pending.preOpId);
      } catch {
        /* best effort; pending receipt remains inspectable */
      }
    }
    if (pending) {
      pending.step = "failed";
      pending.error = error;
    }
    journal.pendingOp = pending;
    this.save(journal);
  }

  clearPending(): void {
    const journal = this.journal();
    journal.pendingOp = null;
    this.save(journal);
  }

  lastReceipt(): OpReceipt | undefined {
    return this.journal().receipts.find((receipt) => !receipt.undone);
  }

  async undoLast(): Promise<OpReceipt | null> {
    const journal = this.journal();
    const receipt = journal.receipts.find((candidate) => !candidate.undone);
    if (!receipt?.preOpId) {
      await this.backend.undo();
      return null;
    }
    await this.backend.restoreOperation(receipt.preOpId);
    if (receipt.op === "capture" && receipt.eventId) {
      const tombstone: DispositionRecord = {
        v: 1,
        recordType: "disposition",
        dispositionId: newDomainId("disposition"),
        targetType: "proposal",
        targetId: receipt.eventId,
        action: "rejected",
        createdAt: new Date().toISOString(),
      };
      await this.backend.applyGraphTransaction({ records: [tombstone] });
    }
    receipt.undone = true;
    this.save(journal);
    return receipt;
  }

  setReplaceTarget(nodeId: string | null): void {
    const journal = this.journal();
    journal.replaceTargetNodeId = nodeId;
    this.save(journal);
  }

  getReplaceTarget(): string | null {
    return this.journal().replaceTargetNodeId ?? null;
  }

  setPendingFork(forkFrom: JournalState["pendingFork"]): void {
    const journal = this.journal();
    journal.pendingFork = forkFrom;
    this.save(journal);
  }

  consumePendingFork(): JournalState["pendingFork"] {
    const journal = this.journal();
    const fork = journal.pendingFork ?? null;
    journal.pendingFork = null;
    this.save(journal);
    return fork;
  }

  setAligned(nodeId: string, sessionId: string, anchor: SessionAnchor): void {
    const journal = this.journal();
    journal.lastAligned = { nodeId, sessionId, anchor };
    this.save(journal);
  }

  getAligned(): JournalState["lastAligned"] {
    return this.journal().lastAligned;
  }

  markEventProcessed(sessionId: string, eventId: string, cursor: number): void {
    const journal = this.journal();
    const inbox = inboxFor(journal, sessionId);
    inbox.cursor = Math.max(inbox.cursor, cursor);
    if (!inbox.processedEventIds.includes(eventId)) inbox.processedEventIds.push(eventId);
    inbox.processedEventIds = inbox.processedEventIds.slice(-500);
    journal.inboxBySession[sessionId] = inbox;
    this.save(journal);
  }

  eventProcessed(sessionId: string, eventId: string): boolean {
    return inboxFor(this.journal(), sessionId).processedEventIds.includes(eventId);
  }
}

export function pendingSummary(repoDir: string): string | null {
  const pending = loadJournal(repoDir).pendingOp;
  if (pending && pending.step !== "done") {
    return `pending ${pending.op} (${pending.step})${pending.error ? `: ${pending.error}` : ""}`;
  }
  return null;
}
