import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Run a git command and return stdout, or null on failure.
 */
export function git(args: string[], cwd?: string): string | null {
  try {
    return execSync(`git ${args.join(" ")}`, {
      cwd: cwd ?? process.cwd(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Get git diff of staged changes, unstaged changes, or a specific commit.
 */
export function gitDiff(
  opts: { staged?: boolean; commit?: string; paths?: string[] },
  cwd?: string,
): string | null {
  const parts: string[] = ["diff"];
  if (opts.staged) parts.push("--staged");
  if (opts.commit) parts.push(`${opts.commit}^..${opts.commit}`);
  parts.push("--");
  if (opts.paths?.length) parts.push(...opts.paths);
  else parts.push(".");
  return git(parts, cwd);
}

/**
 * Get list of changed files from git diff.
 */
export function gitChangedFiles(
  opts: { staged?: boolean; commit?: string },
  cwd?: string,
): string[] {
  const parts: string[] = ["diff", "--name-only"];
  if (opts.staged) parts.push("--staged");
  if (opts.commit) parts.push(`${opts.commit}^..${opts.commit}`);
  const out = git(parts, cwd);
  return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * Get the git repo root, or null if not in a repo.
 */
export function gitRoot(cwd?: string): string | null {
  return git(["rev-parse", "--show-toplevel"], cwd);
}

/**
 * Get project name from package.json or directory name.
 */
export function projectName(cwd: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
    if (pkg.name) return pkg.name;
  } catch { /* ignore */ }
  return path.basename(cwd);
}

/**
 * Get todo file path for a project.
 */
export function todoFilePath(cwd: string): string {
  const name = projectName(cwd).replace(/[^a-zA-Z0-9_-]/g, "_");
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".pi", "agent", "todo", `${name}.json`);
}

export interface TodoItem {
  id: string;
  task: string;
  status: "pending" | "doing" | "done";
  createdAt: string;
  doneAt?: string;
  priority: "low" | "medium" | "high";
}

export function loadTodos(filePath: string): TodoItem[] {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch { /* ignore */ }
  return [];
}

export function saveTodos(filePath: string, todos: TodoItem[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(todos, null, 2));
}

/**
 * Simple UUID generator.
 */
export function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Wrap async operation with a loading indicator notification.
 */
export async function withSpinner<T>(
  ctx: ExtensionCommandContext,
  message: string,
  fn: () => Promise<T>,
): Promise<T> {
  ctx.ui.notify(`${message}...`, "info");
  try {
    return await fn();
  } finally {
    // Clear is implicit when next notify fires, but we can set a short success flash
  }
}

/**
 * Format bytes to human readable.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
