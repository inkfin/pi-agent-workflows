/**
 * orchestrator/lib/worktree.ts — temporary git worktrees for mutating tasks
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface WorktreeSlot {
  taskId: string;
  path: string;
  branch: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function gitRoot(cwd: string): string | null {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

export function isWorkingTreeClean(cwd: string): { clean: boolean; status: string } {
  try {
    const status = git(cwd, ["status", "--porcelain"]);
    return { clean: status.length === 0, status };
  } catch (err: any) {
    return { clean: false, status: err?.message ?? String(err) };
  }
}

export function currentHeadSha(cwd: string): string {
  return git(cwd, ["rev-parse", "HEAD"]);
}

export function createTaskWorktree(
  repoRoot: string,
  baselineSha: string,
  taskId: string,
  runId: string,
): WorktreeSlot {
  const safeId = taskId.replace(/[^\w.-]+/g, "_");
  const dir = path.join(runDirectory(repoRoot, runId), safeId);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const branch = `pi-orch/${runId}/${safeId}`;
  // Create detached worktree at baseline, then make a local branch tip
  git(repoRoot, ["worktree", "add", "-b", branch, dir, baselineSha]);
  return { taskId, path: dir, branch };
}

export function changedFiles(worktreePath: string, baselineSha: string): string[] {
  const tracked = git(worktreePath, ["diff", "--name-only", baselineSha]);
  const untracked = git(worktreePath, ["ls-files", "--others", "--exclude-standard"]);
  return [
    ...new Set(
      [tracked, untracked]
        .filter(Boolean)
        .flatMap((output) => output.split("\n"))
        .filter(Boolean),
    ),
  ].sort();
}

export function assertPathsAllowed(
  changed: string[],
  allowedPaths: string[],
): { ok: boolean; offenders: string[] } {
  const offenders: string[] = [];
  const normalizedAllowed = allowedPaths
    .map(normalizeAllowedPath)
    .filter((item): item is string => item !== null);
  if (normalizedAllowed.length !== allowedPaths.length) {
    return { ok: false, offenders: ["<invalid allowedPaths>"] };
  }
  for (const file of changed) {
    const norm = file.replace(/\\/g, "/");
    const ok = normalizedAllowed.some((base) => {
      return norm === base || norm.startsWith(base.endsWith("/") ? base : `${base}/`);
    });
    if (!ok) offenders.push(file);
  }
  return { ok: offenders.length === 0, offenders };
}

function normalizeAllowedPath(value: string): string | null {
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "..")
  ) {
    return null;
  }
  return normalized;
}

/** Create a temporary commit in the worktree for later cherry-pick. */
export function commitWorktreeChanges(
  worktreePath: string,
  message: string,
): { committed: boolean; sha?: string } {
  const status = git(worktreePath, ["status", "--porcelain"]);
  if (!status) return { committed: false };
  git(worktreePath, ["add", "-A"]);
  // Use env author without touching user git config
  execFileSync(
    "git",
    ["-c", "user.name=pi-orchestrator", "-c", "user.email=pi-orchestrator@local", "commit", "-m", message],
    { cwd: worktreePath, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return { committed: true, sha: git(worktreePath, ["rev-parse", "HEAD"]) };
}

export function createIntegrationBranch(
  repoRoot: string,
  baselineSha: string,
  runId: string,
): { path: string; branch: string } {
  const dir = path.join(runDirectory(repoRoot, runId), "_integrate");
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const branch = `pi-orch/${runId}/integrate`;
  git(repoRoot, ["worktree", "add", "-b", branch, dir, baselineSha]);
  return { path: dir, branch };
}

export function cherryPickCommit(
  integratePath: string,
  commitSha: string,
): { ok: boolean; error?: string } {
  try {
    git(integratePath, [
      "-c",
      "user.name=pi-orchestrator",
      "-c",
      "user.email=pi-orchestrator@local",
      "cherry-pick",
      "--allow-empty",
      commitSha,
    ]);
    return { ok: true };
  } catch (err: any) {
    try {
      git(integratePath, ["cherry-pick", "--abort"]);
    } catch {
      /* ignore */
    }
    return { ok: false, error: err?.stderr?.toString?.() || err?.message || String(err) };
  }
}

/** Apply aggregate integrate branch diff onto main worktree as unstaged changes. */
export function applyAggregateAsUnstaged(
  repoRoot: string,
  integratePath: string,
  baselineSha: string,
): { ok: boolean; error?: string } {
  try {
    const patch = execFileSync("git", ["diff", "--binary", baselineSha], {
      cwd: integratePath,
      encoding: "buffer",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!patch.length) return { ok: true };
    // Ensure main is clean before applying
    const { clean, status } = isWorkingTreeClean(repoRoot);
    if (!clean) return { ok: false, error: `Main worktree not clean:\n${status}` };
    execFileSync("git", ["apply", "--index", "--whitespace=nowarn", "-"], {
      cwd: repoRoot,
      input: patch,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Unstage so result is uncommitted working tree changes
    try {
      git(repoRoot, ["reset", "HEAD"]);
    } catch {
      /* ignore */
    }
    return { ok: true };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.stderr?.toString?.() || err?.message || String(err),
    };
  }
}

export function removeWorktree(repoRoot: string, worktreePath: string, branch?: string): void {
  const detectedBranch = branch ?? branchForWorktree(repoRoot, worktreePath);
  try {
    git(repoRoot, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      git(repoRoot, ["worktree", "prune"]);
    } catch {
      /* ignore */
    }
  }
  if (detectedBranch) {
    try {
      git(repoRoot, ["branch", "-D", detectedBranch]);
    } catch {
      /* ignore */
    }
  }
  if (fs.existsSync(worktreePath)) {
    throw new Error(`Could not remove orchestrator worktree: ${worktreePath}`);
  }
  if (detectedBranch) {
    const remaining = git(repoRoot, ["branch", "--list", detectedBranch]);
    if (remaining) {
      throw new Error(`Could not remove orchestrator branch: ${detectedBranch}`);
    }
  }
}

function branchForWorktree(repoRoot: string, worktreePath: string): string | undefined {
  try {
    const target = fs.realpathSync(worktreePath);
    const blocks = git(repoRoot, ["worktree", "list", "--porcelain"]).split("\n\n");
    for (const block of blocks) {
      const pathMatch = block.match(/^worktree (.+)$/m);
      if (!pathMatch) continue;
      let listed = pathMatch[1];
      try {
        listed = fs.realpathSync(listed);
      } catch {
        /* keep listed path */
      }
      if (listed !== target) continue;
      const branchMatch = block.match(/^branch refs\/heads\/(.+)$/m);
      return branchMatch?.[1];
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function runDirectory(repoRoot: string, runId: string): string {
  const repoKey = createHash("sha256").update(repoRoot).digest("hex").slice(0, 10);
  return path.join(os.tmpdir(), `pi-orch-${repoKey}-${runId}`);
}

export function listLeftoverOrchWorktrees(repoRoot: string): string[] {
  try {
    const out = git(repoRoot, ["worktree", "list", "--porcelain"]);
    const paths: string[] = [];
    for (const block of out.split("\n\n")) {
      const m = block.match(/^worktree (.+)$/m);
      if (m && m[1].includes("pi-orch-")) paths.push(m[1]);
    }
    return paths;
  } catch {
    return [];
  }
}

export function cleanupOrchResources(repoRoot: string, slots: WorktreeSlot[], integrate?: { path: string; branch: string }): void {
  for (const s of slots) removeWorktree(repoRoot, s.path, s.branch);
  if (integrate) removeWorktree(repoRoot, integrate.path, integrate.branch);
  // Remove empty tmp run dirs best-effort
  for (const s of slots) {
    try {
      fs.rmSync(path.dirname(s.path), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
