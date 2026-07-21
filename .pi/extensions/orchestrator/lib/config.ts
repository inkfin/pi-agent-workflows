/**
 * orchestrator/lib/config.ts — project/user orchestrator settings
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CONFIG, type OrchestratorConfig } from "../types";

function readJson(file: string): Partial<OrchestratorConfig> {
  try {
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function loadConfig(cwd: string): OrchestratorConfig {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  const globalPath = path.join(home, ".pi", "agent", "orchestrator.json");
  const projectPath = path.join(cwd, ".pi", "orchestrator.json");
  const merged = {
    ...DEFAULT_CONFIG,
    ...readJson(globalPath),
    ...readJson(projectPath),
  };
  return {
    ...merged,
    maxParallel: Math.max(1, Math.min(8, Number(merged.maxParallel) || 4)),
    maxTasks: Math.max(1, Math.min(16, Number(merged.maxTasks) || 8)),
    taskTimeoutMs: Math.max(30_000, Number(merged.taskTimeoutMs) || DEFAULT_CONFIG.taskTimeoutMs),
    agentScope: merged.agentScope ?? "both",
  };
}
