/**
 * Grove domain model.
 *
 * Domain identity and topology are deliberately independent from jj:
 * nodeId/edgeId/attachmentId identify entities, while jj change ids only
 * locate immutable GraphTransaction revisions in the storage repository.
 */

export interface SessionAnchor {
  entryId: string | null;
  entryHash?: string | null;
  ordinal?: number | null;
  prefixHash?: string | null;
}

export interface CodeState {
  vcs: "git" | "jj";
  rev: string;
  dirty: boolean;
  fingerprint?: string;
}

export type CaptureSource = "manual" | "harness" | "orchestrator";
export type AttachmentKind =
  | "execution_outcome"
  | "summary"
  | "execution_plan"
  | "decision"
  | "research_report"
  | "context_injection";
export type EdgeKind = "lineage" | "context" | "supersedes";

export interface SessionNodeRecord {
  v: 1;
  recordType: "node";
  nodeId: string;
  revision: number;
  label: string;
  projectId: string;
  sessionId: string;
  snapshotId: string | null;
  anchor: SessionAnchor;
  capture: {
    source: CaptureSource;
    slotId?: string;
    latestEventId?: string;
    sequence?: number;
  };
  state: "draft" | "sealed";
  pinned: boolean;
  publishedAt?: string;
  project: { name: string; vcsRemote?: string };
  code?: CodeState | null;
  origin: string;
  createdAt: string;
  updatedAt: string;
}

export interface EdgeRecord {
  v: 1;
  recordType: "edge";
  edgeId: string;
  revision: number;
  fromNodeId: string;
  toNodeId: string;
  kind: EdgeKind;
  state: "active" | "deleted";
  payloadHash?: string;
  createdAt: string;
}

export interface AttachmentRecord {
  v: 1;
  recordType: "attachment";
  attachmentId: string;
  targetNodeId: string;
  kind: AttachmentKind;
  producer: { extension: string; sourceId: string };
  contentHash: string;
  payloadPath?: string;
  createdAt: string;
}

export interface DispositionRecord {
  v: 1;
  recordType: "disposition";
  dispositionId: string;
  targetType: "proposal" | "attachment";
  targetId: string;
  action: "rejected" | "tombstoned";
  createdAt: string;
}

export interface FrontierRecord {
  v: 1;
  recordType: "frontier";
  frontierId: string;
  origin: string;
  nodeIds: string[];
  createdAt: string;
}

export type GraphRecord =
  | SessionNodeRecord
  | EdgeRecord
  | AttachmentRecord
  | DispositionRecord
  | FrontierRecord;

export interface GraphTransaction {
  v: 1;
  recordType: "transaction";
  txId: string;
  expectedGraphRevision?: string;
  records: GraphRecord[];
  createdAt: string;
}

export interface BackendRef {
  changeId: string;
  commitId: string;
  timestamp: string;
}

/** Materialized domain entity. backendRef is a locator, never its identity. */
export interface SessionNode extends SessionNodeRecord {
  backendRef: BackendRef;
}

export interface MaterializedEdge extends EdgeRecord {
  backendRef: BackendRef;
}

export interface MaterializedAttachment extends AttachmentRecord {
  backendRef: BackendRef;
}

export interface GroveGraph {
  revision: string;
  nodes: SessionNode[];
  edges: MaterializedEdge[];
  attachments: MaterializedAttachment[];
  dispositions: DispositionRecord[];
  frontiers: FrontierRecord[];
}

export interface GroveRevision extends BackendRef {
  parents: string[];
  transaction: GraphTransaction | null;
}

export interface GraphApplyOptions {
  records: GraphRecord[];
  files?: Record<string, string>;
  /** Only validated, repo-relative object paths may be removed. */
  deleteFiles?: string[];
  expectedGraphRevision?: string;
}

export interface GraphApplyResult {
  transaction: GraphTransaction;
  revision: GroveRevision;
  graphRevision: string;
}

export interface AmendDraftOptions {
  nodeId: string;
  expectedRevision: number;
  patch: Partial<
    Pick<
      SessionNodeRecord,
      "label" | "snapshotId" | "anchor" | "capture" | "code" | "state" | "pinned" | "publishedAt"
    >
  >;
  files?: Record<string, string>;
  deleteFiles?: string[];
  attachments?: AttachmentRecord[];
  expectedGraphRevision?: string;
}

export interface TreeBackend {
  repoDir(): string;
  ensureRepo(): Promise<string>;
  currentChangeId(): Promise<string>;
  currentOperationId(): Promise<string>;
  graphRevision(): Promise<string>;
  applyGraphTransaction(opts: GraphApplyOptions): Promise<GraphApplyResult>;
  getGraph(): Promise<GroveGraph>;
  getNode(nodeId: string): Promise<SessionNode | null>;
  recordNode(opts: {
    node: SessionNodeRecord;
    edges?: EdgeRecord[];
    attachments?: AttachmentRecord[];
    files?: Record<string, string>;
    expectedGraphRevision?: string;
  }): Promise<SessionNode>;
  amendDraft(opts: AmendDraftOptions): Promise<SessionNode>;
  appendEdge(opts: {
    edge: EdgeRecord;
    expectedGraphRevision?: string;
  }): Promise<MaterializedEdge>;
  deleteEdge(opts: {
    edgeId: string;
    expectedGraphRevision?: string;
  }): Promise<MaterializedEdge>;
  appendAttachment(opts: {
    attachment: AttachmentRecord;
    files?: Record<string, string>;
    expectedGraphRevision?: string;
  }): Promise<MaterializedAttachment>;
  listRevisions(): Promise<GroveRevision[]>;
  showFile(rev: string, path: string): Promise<string | null>;
  edit(changeId: string): Promise<void>;
  gotoNode(nodeId: string): Promise<void>;
  undo(): Promise<void>;
  restoreOperation(opId: string): Promise<void>;
  setBookmark(name: string, changeId: string): Promise<void>;
  listBookmarks(): Promise<Array<{ name: string; changeId: string }>>;
  ensureRemote(name: string, url: string): Promise<void>;
  gitPush(opts: { remote: string; bookmark: string }): Promise<void>;
  gitFetch(opts: { remote: string }): Promise<void>;
}

const RECORD_TYPES = new Set(["node", "edge", "attachment", "disposition", "frontier"]);

export function encodeTransaction(transaction: GraphTransaction): string {
  return JSON.stringify(transaction);
}

export function decodeTransaction(description: string): GraphTransaction | null {
  const trimmed = description.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      !parsed ||
      parsed.v !== 1 ||
      parsed.recordType !== "transaction" ||
      typeof parsed.txId !== "string" ||
      !Array.isArray(parsed.records) ||
      typeof parsed.createdAt !== "string" ||
      !parsed.records.every(
        (record: unknown) =>
          !!record &&
          typeof record === "object" &&
          (record as { v?: unknown }).v === 1 &&
          RECORD_TYPES.has(String((record as { recordType?: unknown }).recordType)),
      )
    ) {
      return null;
    }
    return parsed as GraphTransaction;
  } catch {
    return null;
  }
}

export function isEffectivelySealed(node: SessionNodeRecord, edges: EdgeRecord[]): boolean {
  return (
    node.state === "sealed" ||
    node.pinned ||
    Boolean(node.publishedAt) ||
    edges.some(
      (edge) =>
        edge.state === "active" &&
        edge.kind === "lineage" &&
        edge.fromNodeId === node.nodeId,
    )
  );
}

export function newDomainId(prefix: "node" | "edge" | "attachment" | "tx" | "disposition"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
