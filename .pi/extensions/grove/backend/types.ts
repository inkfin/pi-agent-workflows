/**
 * grove/backend/types.ts — TreeBackend interface and node model
 *
 * Design notes (see docs/adr/0001):
 * - A Node's metadata lives in the jj commit description (compact single-line JSON).
 *   One `jj log` call yields full topology + all metadata.
 * - Session snapshots live as files (sessions/<basename>.jsonl) in the tree repo.
 * - Node identity = jj change-id (stable across history rewrites).
 */

/** Durable node kinds. Turns are ephemeral; only these enter the tree. */
export type NodeKind = "root" | "checkpoint" | "fork" | "merge";

/** Node manifest, serialized as the jj commit description (single-line JSON). */
export interface NodeManifest {
  v: 1;
  kind: NodeKind;
  label: string;
  /** pi session file basename, e.g. "20260720_abc123.jsonl". Never a path (portability). */
  sessionRef: string;
  /** Entry within the session; null = session head. */
  entryId: string | null;
  project: { name: string; vcsRemote?: string };
  /** Machine where the node was created. Provenance, not identity. */
  origin: string;
  /** Code state pointer at creation time (read-only for now). */
  code?: { vcs: "git" | "jj"; rev: string; dirty: boolean } | null;
  createdAt: string;
}

/** A node in the tree DAG = manifest + jj topology. */
export interface GroveNode {
  changeId: string;
  commitId: string;
  /** Parent change-ids (1 normal, 2+ for merges, 0 for root). */
  parents: string[];
  timestamp: string;
  /** null for non-grove commits (e.g. the jj root or foreign commits). */
  manifest: NodeManifest | null;
}

export interface CommitNodeOpts {
  /** Parent change-ids; defaults to current @. */
  parents?: string[];
  manifest: NodeManifest;
  /** Repo-relative path → content, written into the node commit. */
  files?: Record<string, string>;
}

export interface TreeBackend {
  /** Absolute path of the tree repo working copy. */
  repoDir(): string;
  /** Init the repo if missing; returns repoDir. */
  ensureRepo(): Promise<string>;
  /** change-id of @. */
  currentChangeId(): Promise<string>;
  /** Create a node: jj new on parents → write files → describe with manifest. */
  commitNode(opts: CommitNodeOpts): Promise<GroveNode>;
  /** All nodes in the DAG (excluding the jj root). */
  listNodes(): Promise<GroveNode[]>;
  /** Read a file at a revision; null when absent. */
  showFile(rev: string, path: string): Promise<string | null>;
  /** Move @ to an existing change. */
  edit(changeId: string): Promise<void>;
  /** jj undo — reverses the last repo operation. */
  undo(): Promise<void>;
}

/** Serialize a manifest as a single-line commit description. */
export function encodeManifest(m: NodeManifest): string {
  return JSON.stringify(m);
}

/** Parse a commit description back into a manifest; null when not grove data. */
export function decodeManifest(description: string): NodeManifest | null {
  const trimmed = description.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && parsed.v === 1 && typeof parsed.kind === "string" && typeof parsed.label === "string") {
      return parsed as NodeManifest;
    }
  } catch {
    /* not grove JSON */
  }
  return null;
}
