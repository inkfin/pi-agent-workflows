/**
 * grove/mapping/ops.ts — orchestration between pi sessions and the tree repo
 *
 * This layer owns the "alignment": pi session operations (which only exist
 * in-process) sequenced with backend repo operations (ADR-0001).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { TreeBackend, GroveNode, NodeManifest } from "../backend/types";
import { machineId, projectInfo, codeState } from "../lib/identity";
import { resolveSessionRef, materializeSession, summarizeSessionContent } from "../lib/sessions";

// ─── Redaction (v1: naive patterns; TODO harden — see docs/ref/entire.md) ───

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{20,}/g, "sk-…REDACTED"],
  [/\b(AKIA[0-9A-Z]{16})\b/g, "AKIA…REDACTED"],
  [/ghp_[A-Za-z0-9]{20,}/g, "ghp_…REDACTED"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "JWT…REDACTED"],
];

export function redact(content: string): string {
  let out = content;
  for (const [re, replacement] of REDACT_PATTERNS) out = out.replace(re, replacement);
  return out;
}

// ─── Manifest helpers ─────────────────────────────────────────

function baseManifest(cwd: string, kind: NodeManifest["kind"], label: string, sessionRef: string, entryId: string | null): NodeManifest {
  return {
    v: 1,
    kind,
    label,
    sessionRef,
    entryId,
    project: projectInfo(cwd),
    origin: machineId(),
    code: codeState(cwd),
    createdAt: new Date().toISOString(),
  };
}

// ─── Operations ───────────────────────────────────────────────

/**
 * Checkpoint the given session: snapshot (redacted) + manifest node on top of @.
 */
export async function checkpointSession(
  be: TreeBackend,
  cwd: string,
  opts: { label: string; sessionFile: string; entryId: string | null },
): Promise<GroveNode> {
  const sessionRef = path.basename(opts.sessionFile);
  const raw = fs.readFileSync(opts.sessionFile, "utf-8");
  const snapshot = redact(raw);
  return be.commitNode({
    manifest: baseManifest(cwd, "checkpoint", opts.label, sessionRef, opts.entryId),
    files: { [`sessions/${sessionRef}`]: snapshot },
  });
}

/**
 * Record a fork node (called from the session_start hook, reason "fork").
 * No snapshot — the new session is just beginning; its parent chain carries context.
 */
export async function recordFork(
  be: TreeBackend,
  cwd: string,
  opts: { sessionFile: string; entryId: string | null; parentChangeId?: string },
): Promise<GroveNode> {
  const sessionRef = path.basename(opts.sessionFile);
  return be.commitNode({
    parents: opts.parentChangeId ? [opts.parentChangeId] : undefined,
    manifest: baseManifest(cwd, "fork", `fork: ${sessionRef.replace(/\.jsonl$/, "")}`, sessionRef, opts.entryId),
  });
}

/**
 * Record a merge node with two parents (current + source).
 */
export async function recordMerge(
  be: TreeBackend,
  cwd: string,
  opts: { label: string; sessionFile: string; sourceChangeId: string },
): Promise<GroveNode> {
  const current = await be.currentChangeId();
  const sessionRef = path.basename(opts.sessionFile);
  return be.commitNode({
    parents: [current, opts.sourceChangeId],
    manifest: baseManifest(cwd, "merge", opts.label, sessionRef, null),
  });
}

/**
 * Resolve where a node's session can be opened locally.
 * - If the session file exists locally (same machine), return its path.
 * - Otherwise materialize the snapshot from the tree repo.
 */
export async function ensureSessionAvailable(
  be: TreeBackend,
  cwd: string,
  node: GroveNode,
): Promise<{ path: string; materialized: boolean } | null> {
  const m = node.manifest;
  if (!m) return null;
  const local = resolveSessionRef(cwd, m.sessionRef);
  if (local) return { path: local, materialized: false };
  const snapshot = await be.showFile(node.changeId, `sessions/${m.sessionRef}`);
  if (snapshot == null) return null;
  return { path: materializeSession(cwd, m.sessionRef, snapshot), materialized: true };
}

/**
 * Build a context-inject summary from a node's snapshot (merge / cherry-pick payload).
 */
export async function nodeSummaryForInject(
  be: TreeBackend,
  node: GroveNode,
  maxLen = 2000,
): Promise<string> {
  const m = node.manifest;
  if (!m) return "";
  const snapshot = await be.showFile(node.changeId, `sessions/${m.sessionRef}`);
  if (snapshot == null) return `(no snapshot available for ${m.label})`;
  return summarizeSessionContent(snapshot, 12, maxLen);
}

/** Find the node tracking a given session file (by basename); latest wins. */
export function nodeForSession(nodes: GroveNode[], sessionFile: string | null): GroveNode | undefined {
  if (!sessionFile) return undefined;
  const ref = path.basename(sessionFile);
  let best: GroveNode | undefined;
  for (const n of nodes) {
    if (n.manifest?.sessionRef !== ref) continue;
    if (!best || n.timestamp > best.timestamp) best = n;
  }
  return best;
}

/** Find the node currently edited by jj. */
export function nodeAtChange(nodes: GroveNode[], changeId: string): GroveNode | undefined {
  return nodes.find((n) => n.changeId === changeId);
}
