/**
 * grove/lib/settings.ts — project + local settings layering
 *
 * Project-shared: .pi/grove.json (may be committed)
 * Personal local: .pi/grove.local.json (gitignored recommendation)
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface GroveProjectSettings {
  /** Explicit private tree remote URL. Sync stays off until set. */
  treeRemote?: string;
  /** User confirmed remote is private (required for push). */
  privateRemoteConfirmed?: boolean;
  /** Opt into payload encryption (the current implementation stores the flag only). */
  encryptPayload?: boolean;
  /** Opt out of central registry. */
  registry?: boolean;
  /** Enable harness auto snapshots (default true). */
  autoSnapshot?: boolean;
}

export interface GroveLocalSettings {
  /** Prefer showing auto nodes in status bar. */
  showAutoStatus?: boolean;
}

export function projectSettingsPath(cwd: string): string {
  return path.join(cwd, ".pi", "grove.json");
}

export function localSettingsPath(cwd: string): string {
  return path.join(cwd, ".pi", "grove.local.json");
}

function readJson<T>(fp: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function loadProjectSettings(cwd: string): GroveProjectSettings {
  return readJson<GroveProjectSettings>(projectSettingsPath(cwd)) ?? {};
}

export function saveProjectSettings(cwd: string, settings: GroveProjectSettings): void {
  const fp = projectSettingsPath(cwd);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(settings, null, 2) + "\n");
}

export function loadLocalSettings(cwd: string): GroveLocalSettings {
  return readJson<GroveLocalSettings>(localSettingsPath(cwd)) ?? {};
}

export function syncEnabled(cwd: string): { ok: true; remote: string } | { ok: false; reason: string } {
  const s = loadProjectSettings(cwd);
  if (!s.treeRemote) return { ok: false, reason: "treeRemote not configured in .pi/grove.json" };
  if (!s.privateRemoteConfirmed && !s.encryptPayload) {
    return {
      ok: false,
      reason: "set privateRemoteConfirmed:true or encryptPayload:true in .pi/grove.json",
    };
  }
  return { ok: true, remote: s.treeRemote };
}
