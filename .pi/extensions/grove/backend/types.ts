/**
 * grove/backend/types.ts — TreeBackend interface and current NodeManifest
 *
 * See docs/adr/0004. Content-addressed snapshots + SessionAnchor.
 * Node identity = jj change-id. Manifest = single-line commit description.
 */

/** Durable node kinds. Turns are ephemeral; only these enter the tree. */
export type NodeKind =
  | "root"
  | "checkpoint"
  | "fork"
  | "context_merge"
  | "auto"
  | "frontier";

/** draft = harness-mutable; pinned = manual/fixed; published = synced. */
export type NodeLifecycle = "draft" | "pinned" | "published";

export type InjectStrategy = "summary" | "subtree" | "full";

const NODE_KINDS: ReadonlySet<string> = new Set([
  "root",
  "checkpoint",
  "fork",
  "context_merge",
  "auto",
  "frontier",
]);

const NODE_LIFECYCLES: ReadonlySet<string> = new Set([
  "draft",
  "pinned",
  "published",
]);

/** Durable pointer into a pi session (not the Cursor product). */
export interface SessionAnchor {
  entryId: string | null;
  /** Hash of the entry line content when captured. */
  entryHash?: string | null;
  /** 0-based JSONL line ordinal at capture time. */
  ordinal?: number | null;
  /** Hash of all content before the anchor (compaction fallback). */
  prefixHash?: string | null;
}

export interface ForkFrom {
  parentChangeId: string;
  parentSessionId: string;
  parentAnchor: SessionAnchor;
}

export interface MergeSource {
  changeId: string;
  label: string;
  sessionId: string;
  anchor: SessionAnchor;
}

export interface NodeManifest {
  /** Published schema identifier. Mutable in-place until Grove's first release. */
  v: 1;
  kind: NodeKind;
  label: string;
  /** Stable project id (hash of remote or basename). */
  projectId: string;
  /** Session identity: basename without implying path portability alone. */
  sessionId: string;
  /** Content-addressed snapshot; null for root/frontier/fork-without-snap. */
  snapshotId: string | null;
  anchor: SessionAnchor;
  lifecycle: NodeLifecycle;
  project: { name: string; vcsRemote?: string };
  origin: string;
  code?: { vcs: "git" | "jj"; rev: string; dirty: boolean; fingerprint?: string } | null;
  createdAt: string;
  /** Present on fork nodes. */
  forkFrom?: ForkFrom;
  /** Present on context_merge nodes. */
  mergeOf?: MergeSource[];
  injectStrategy?: InjectStrategy;
  payloadHash?: string;
  /** Auto/replacement: prior change-id this node supersedes. */
  supersedes?: string | null;
  /** Optional human note. */
  note?: string;
}

/** A node in the tree DAG = manifest + jj topology. */
export interface GroveNode {
  changeId: string;
  commitId: string;
  parents: string[];
  timestamp: string;
  manifest: NodeManifest | null;
}

export interface CommitNodeOpts {
  parents?: string[];
  manifest: NodeManifest;
  /** Repo-relative path → content. Prefer objects/<sha>.jsonl for snapshots. */
  files?: Record<string, string>;
}

export interface AmendNodeOpts {
  changeId: string;
  manifest: NodeManifest;
  files?: Record<string, string>;
}

export interface TreeBackend {
  repoDir(): string;
  ensureRepo(): Promise<string>;
  currentChangeId(): Promise<string>;
  /** Current jj operation id (for coordinator preOpId). */
  currentOperationId(): Promise<string>;
  commitNode(opts: CommitNodeOpts): Promise<GroveNode>;
  /** Update an existing mutable draft change in place. */
  amendNode(opts: AmendNodeOpts): Promise<GroveNode>;
  listNodes(): Promise<GroveNode[]>;
  showFile(rev: string, path: string): Promise<string | null>;
  edit(changeId: string): Promise<void>;
  undo(): Promise<void>;
  /** Restore repo to a prior operation (local only). */
  restoreOperation(opId: string): Promise<void>;
  /** Set or create a bookmark pointing at a change. */
  setBookmark(name: string, changeId: string): Promise<void>;
  listBookmarks(): Promise<Array<{ name: string; changeId: string }>>;
  /** Ensure a git remote exists (by name). */
  ensureRemote(name: string, url: string): Promise<void>;
  gitPush(opts: { remote: string; bookmark: string }): Promise<void>;
  gitFetch(opts: { remote: string }): Promise<void>;
}

/** Serialize a manifest as a single-line commit description. */
export function encodeManifest(m: NodeManifest): string {
  return JSON.stringify(m);
}

/** Parse a current-format manifest from a commit description. */
export function decodeManifest(description: string): NodeManifest | null {
  const trimmed = description.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      !parsed ||
      parsed.v !== 1 ||
      typeof parsed.kind !== "string" ||
      !NODE_KINDS.has(parsed.kind) ||
      typeof parsed.label !== "string" ||
      typeof parsed.projectId !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.lifecycle !== "string" ||
      !NODE_LIFECYCLES.has(parsed.lifecycle) ||
      !(parsed.snapshotId === null || typeof parsed.snapshotId === "string") ||
      typeof parsed.anchor !== "object" ||
      parsed.anchor === null ||
      typeof parsed.project !== "object" ||
      parsed.project === null ||
      typeof parsed.origin !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return parsed as NodeManifest;
  } catch {
    /* not grove JSON */
  }
  return null;
}
