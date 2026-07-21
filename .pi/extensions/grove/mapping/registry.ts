/**
 * grove/mapping/registry.ts — eventually-consistent metadata registry + outbox
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { machineId, projectInfo } from "../lib/identity";
import { loadProjectSettings } from "../lib/settings";

export interface RegistryProjectRecord {
  projectId: string;
  name: string;
  vcsRemote?: string;
  treeRemote?: string;
  frontierCommitId?: string;
  updatedAt: string;
  machines: string[];
  sessions: Array<{ sessionId: string; label: string; origin: string; updatedAt: string }>;
}

function xdgDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
  return path.join(xdg, "grove", "registry");
}

function outboxPath(cwd: string): string {
  return path.join(cwd, ".pi", "tree", "outbox", "registry.jsonl");
}

export function registryDir(): string {
  return xdgDataDir();
}

function projectRecordPath(projectId: string): string {
  return path.join(xdgDataDir(), "projects", `${projectId}.json`);
}

export function loadProjectRecord(projectId: string): RegistryProjectRecord | null {
  try {
    return JSON.parse(fs.readFileSync(projectRecordPath(projectId), "utf-8"));
  } catch {
    return null;
  }
}

export function writeProjectRecord(rec: RegistryProjectRecord): void {
  const fp = projectRecordPath(rec.projectId);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(rec, null, 2) + "\n");
}

export function enqueueRegistryOutbox(cwd: string, rec: RegistryProjectRecord): void {
  const fp = outboxPath(cwd);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.appendFileSync(fp, JSON.stringify({ at: new Date().toISOString(), rec }) + "\n");
}

export function flushRegistryOutbox(cwd: string): number {
  const fp = outboxPath(cwd);
  if (!fs.existsSync(fp)) return 0;
  const lines = fs.readFileSync(fp, "utf-8").split("\n").filter(Boolean);
  let n = 0;
  for (const line of lines) {
    try {
      const { rec } = JSON.parse(line);
      writeProjectRecord(rec);
      n++;
    } catch {
      /* skip bad line */
    }
  }
  fs.writeFileSync(fp, "");
  return n;
}

/** After tree push: update local registry record or outbox if registry:false. */
export function publishRegistryAfterPush(
  cwd: string,
  opts: { frontierCommitId: string; sessions?: RegistryProjectRecord["sessions"] },
): string {
  const settings = loadProjectSettings(cwd);
  if (settings.registry === false) return "registry opted out";

  const proj = projectInfo(cwd);
  const existing = loadProjectRecord(proj.projectId);
  const machines = new Set(existing?.machines ?? []);
  machines.add(machineId());
  const rec: RegistryProjectRecord = {
    projectId: proj.projectId,
    name: proj.name,
    vcsRemote: proj.vcsRemote,
    treeRemote: settings.treeRemote,
    frontierCommitId: opts.frontierCommitId,
    updatedAt: new Date().toISOString(),
    machines: [...machines],
    sessions: opts.sessions ?? existing?.sessions ?? [],
  };

  try {
    writeProjectRecord(rec);
    return `registry updated ${proj.projectId}`;
  } catch (err: any) {
    enqueueRegistryOutbox(cwd, rec);
    return `registry write failed; queued outbox (${err?.message ?? err})`;
  }
}

export function listRegistryProjects(): RegistryProjectRecord[] {
  const dir = path.join(xdgDataDir(), "projects");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => loadProjectRecord(f.replace(/\.json$/, "")))
      .filter((r): r is RegistryProjectRecord => Boolean(r));
  } catch {
    return [];
  }
}

export function dashboardLines(): string[] {
  const projects = listRegistryProjects();
  if (projects.length === 0) return ["(registry empty)"];
  const lines: string[] = [];
  const now = Date.now();
  for (const p of projects) {
    const ageMs = now - new Date(p.updatedAt).getTime();
    const ageH = Math.max(0, Math.round(ageMs / 3600000));
    lines.push(
      `◆ ${p.name} (${p.projectId.slice(0, 8)}) · frontier ${p.frontierCommitId?.slice(0, 8) ?? "?"} · ${ageH}h · machines ${p.machines.join(",")}`,
    );
  }
  return lines;
}
