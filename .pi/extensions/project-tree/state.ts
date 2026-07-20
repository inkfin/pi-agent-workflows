/**
 * project-tree/state.ts — Data model and persistence for the project tree
 *
 * One branch = one pi session file. The tree tracks relationships:
 *   parentBranchId → which branch was this forked from
 *   parentEntryId  → which entry in the parent was the fork point
 *
 * Persisted as .pi/tree/state.json (project-local, can be committed).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { uuid, projectName } from "../shared/utils";

// ─── Types ──────────────────────────────────────────────────

export interface Branch {
  id: string;                   // uuid
  name: string;                 // "main", "fix-login", "refactor-db"
  parentBranchId: string | null; // null = root branch
  parentEntryId: string | null;  // entry id from parent where fork happened
  sessionFile: string;           // absolute path to .jsonl session file
  createdAt: string;             // ISO timestamp
  lastActiveAt: string;          // ISO timestamp
  status: "active" | "merged" | "archived";
  source: "local" | "remote";    // remote = synced from another machine
  remoteOrigin?: string;         // "office-mac" if remote
  description?: string;          // user or agent-written summary
  tags?: string[];               // ["review-needed", "wip"]
  messageCount?: number;         // populated on read from session file
}

export interface MergeRecord {
  id: string;
  sourceBranchId: string;
  targetBranchId: string;
  mergedAt: string;
  strategy: "context-inject" | "switch";
  summary: string;
}

export interface ProjectTree {
  version: 1;
  projectName: string;
  branches: Branch[];
  mergeHistory: MergeRecord[];
}

// ─── File I/O ────────────────────────────────────────────────

function treePath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, "tree", "state.json");
}

export function loadTree(cwd: string): ProjectTree {
  const fp = treePath(cwd);
  try {
    const raw = fs.readFileSync(fp, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version === 1 && Array.isArray(parsed.branches)) {
      return parsed as ProjectTree;
    }
  } catch { /* no tree yet */ }

  return {
    version: 1,
    projectName: projectName(cwd),
    branches: [],
    mergeHistory: [],
  };
}

export function saveTree(cwd: string, tree: ProjectTree): void {
  const fp = treePath(cwd);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(tree, null, 2));
}

// ─── Session File Helpers ────────────────────────────────────

/**
 * Get the sessions directory for a given cwd.
 * Matches pi's naming: ~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
 * But we let pi manage session file creation — we just track the file paths.
 */
export function getSessionsDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".pi", "agent", "sessions");
}

/**
 * Convert a cwd to the session directory slug pi uses.
 */
export function cwdToSessionSlug(cwd: string): string {
  return "--" + cwd.replace(/^\//, "").replace(/\//g, "-").replace(/ /g, "_");
}

/**
 * List session files for this project.
 */
export function listProjectSessions(cwd: string): string[] {
  const dir = path.join(getSessionsDir(), cwdToSessionSlug(cwd));
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Count messages in a session file (JSONL lines).
 */
export function countSessionMessages(sessionFile: string): number {
  try {
    return fs.readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Get the last active time from a session file stat.
 */
export function sessionLastModified(sessionFile: string): string {
  try {
    return fs.statSync(sessionFile).mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

// ─── Branch Operations ───────────────────────────────────────

export function findBranch(tree: ProjectTree, idOrName: string): Branch | undefined {
  return (
    tree.branches.find((b) => b.id === idOrName) ??
    tree.branches.find((b) => b.name === idOrName)
  );
}

export function getCurrentBranch(tree: ProjectTree, currentSessionFile: string | null): Branch | undefined {
  if (!currentSessionFile) return undefined;
  return tree.branches.find((b) => b.sessionFile === currentSessionFile);
}

export function createBranch(
  tree: ProjectTree,
  opts: {
    name: string;
    sessionFile: string;
    parentBranchId?: string | null;
    parentEntryId?: string | null;
    description?: string;
  },
): Branch {
  const branch: Branch = {
    id: uuid(),
    name: opts.name,
    parentBranchId: opts.parentBranchId ?? null,
    parentEntryId: opts.parentEntryId ?? null,
    sessionFile: opts.sessionFile,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    status: "active",
    source: "local",
    description: opts.description,
  };

  tree.branches.push(branch);
  return branch;
}

export function archiveBranch(tree: ProjectTree, branchId: string): boolean {
  const b = findBranch(tree, branchId);
  if (!b) return false;
  b.status = "archived";
  return true;
}

export function touchBranch(tree: ProjectTree, branchId: string): void {
  const b = findBranch(tree, branchId);
  if (b) b.lastActiveAt = new Date().toISOString();
}

/**
 * Get children of a branch (branches that were forked from it).
 */
export function getChildBranches(tree: ProjectTree, branchId: string): Branch[] {
  return tree.branches.filter((b) => b.parentBranchId === branchId);
}

/**
 * Get the root branches (no parent).
 */
export function getRootBranches(tree: ProjectTree): Branch[] {
  return tree.branches.filter((b) => !b.parentBranchId);
}

/**
 * Build a tree structure for display.
 */
export interface TreeNode {
  branch: Branch;
  children: TreeNode[];
  depth: number;
}

export function buildTree(tree: ProjectTree): TreeNode[] {
  const roots = getRootBranches(tree);
  const map = new Map<string, TreeNode>();

  const build = (branch: Branch, depth: number): TreeNode => {
    const existing = map.get(branch.id);
    if (existing) return existing;
    const node: TreeNode = { branch, children: [], depth };
    map.set(branch.id, node);
    node.children = getChildBranches(tree, branch.id)
      .filter((b) => b.status !== "archived")
      .map((b) => build(b, depth + 1));
    return node;
  };

  return roots
    .filter((b) => b.status !== "archived")
    .map((b) => build(b, 0));
}
