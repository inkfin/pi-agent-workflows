/**
 * grove/lib/identity.ts — machine / project / code identity
 *
 * Identity model (CONTEXT.md):
 * - Node    → jj change-id (backend)
 * - Session → pi session file basename (never a path)
 * - Machine → machine-id from XDG config (provenance only)
 * - Project → git remote URL hash... v1: remote URL string or dir basename
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git, projectName } from "../../shared/utils";

interface GroveConfig {
  machineId: string;
  /** Manual path → projectId bindings (for cross-machine path differences). */
  projectBindings?: Record<string, string>;
}

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "grove");
}

function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function loadConfig(): GroveConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.machineId === "string") return parsed as GroveConfig;
  } catch {
    /* first run */
  }
  const fresh: GroveConfig = { machineId: os.hostname().replace(/\.(local|lan)$/, "") };
  saveConfig(fresh);
  return fresh;
}

export function saveConfig(cfg: GroveConfig): void {
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

let cachedMachineId: string | null = null;

/** Stable machine identity (provenance). User-editable in ~/.config/grove/config.json. */
export function machineId(): string {
  if (!cachedMachineId) cachedMachineId = loadConfig().machineId;
  return cachedMachineId;
}

export interface ProjectInfo {
  name: string;
  vcsRemote?: string;
}

export function projectInfo(cwd: string): ProjectInfo {
  const remote = git(["remote", "get-url", "origin"], cwd) ?? undefined;
  return { name: projectName(cwd), vcsRemote: remote };
}

/** Current code state pointer (read-only; Phase 4 makes this interactive). */
export function codeState(cwd: string): { vcs: "git"; rev: string; dirty: boolean } | null {
  const rev = git(["rev-parse", "HEAD"], cwd);
  if (!rev) return null;
  const status = git(["status", "--porcelain"], cwd);
  return { vcs: "git", rev, dirty: Boolean(status && status.length > 0) };
}
