/**
 * grove/lib/identity.ts — machine / project / code identity
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git, projectName } from "../../shared/utils";

interface GroveConfig {
  machineId: string;
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

export function machineId(): string {
  if (!cachedMachineId) cachedMachineId = loadConfig().machineId;
  return cachedMachineId;
}

/** Sanitize origin for bookmark names. */
export function originBookmarkName(origin = machineId()): string {
  const safe = origin.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "local";
  return `grove/origins/${safe}`;
}

export interface ProjectInfo {
  name: string;
  vcsRemote?: string;
  projectId: string;
}

export function projectInfo(cwd: string): ProjectInfo {
  const cfg = loadConfig();
  const bound = cfg.projectBindings?.[cwd];
  const remote = git(["remote", "get-url", "origin"], cwd) ?? undefined;
  const name = projectName(cwd);
  const seed = bound ?? remote ?? name;
  const projectId = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  return { name, vcsRemote: remote, projectId };
}

export interface CodeState {
  vcs: "git";
  rev: string;
  dirty: boolean;
  fingerprint: string;
}

/** Current code state pointer + fingerprint for harness change detection. */
export function codeState(cwd: string): CodeState | null {
  const rev = git(["rev-parse", "HEAD"], cwd);
  if (!rev) return null;
  const status = git(["status", "--porcelain"], cwd) ?? "";
  const dirty = status.length > 0;
  const fingerprint = createHash("sha256")
    .update(rev + "\n" + status)
    .digest("hex")
    .slice(0, 16);
  return { vcs: "git", rev, dirty, fingerprint };
}
