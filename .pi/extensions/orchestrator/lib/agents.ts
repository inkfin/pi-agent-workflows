/**
 * orchestrator/lib/agents.ts — discover builtin / user / project agent profiles
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type AgentScope = "builtin" | "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: "builtin" | "user" | "project";
  filePath: string;
  mutating: boolean;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: content };
  const raw = content.slice(3, end).trim();
  const body = content.slice(end + 4).replace(/^\n/, "");
  const frontmatter: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m) frontmatter[m[1]] = m[2].trim();
  }
  return { frontmatter, body };
}

function loadAgentsFromDir(dir: string, source: AgentConfig["source"]): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (!fs.existsSync(dir)) return agents;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(content);
    if (!frontmatter.name || !frontmatter.description) continue;
    const tools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const mutating =
      frontmatter.mutating === "true" ||
      (tools ? tools.some((t) => t === "edit" || t === "write") : source !== "builtin" && frontmatter.name === "worker");
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      source,
      filePath,
      mutating: frontmatter.name === "worker" ? true : mutating,
    });
  }
  return agents;
}

function builtinAgentsDir(): string {
  // Resolve relative to this module; fall back to package layout from cwd
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.join(here, "..", "agents");
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    /* ignore */
  }
  const fromCwd = path.join(process.cwd(), ".pi", "extensions", "orchestrator", "agents");
  if (fs.existsSync(fromCwd)) return fromCwd;
  return path.join(__dirnameFallback(), "..", "agents");
}

function __dirnameFallback(): string {
  // last resort for non-ESM loaders
  return path.join(process.cwd(), ".pi", "extensions", "orchestrator", "lib");
}

function userAgentsDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".pi", "agent", "agents");
}

function findProjectAgentsDir(cwd: string): string | null {
  let current = cwd;
  while (true) {
    const candidate = path.join(current, ".pi", "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* skip */
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function discoverAgents(
  cwd: string,
  scope: AgentScope = "both",
): { agents: AgentConfig[]; projectAgentsDir: string | null } {
  const map = new Map<string, AgentConfig>();
  for (const a of loadAgentsFromDir(builtinAgentsDir(), "builtin")) {
    map.set(a.name, a);
  }
  if (scope === "user" || scope === "both") {
    for (const a of loadAgentsFromDir(userAgentsDir(), "user")) {
      map.set(a.name, a);
    }
  }
  const projectAgentsDir = findProjectAgentsDir(cwd);
  if ((scope === "project" || scope === "both") && projectAgentsDir) {
    for (const a of loadAgentsFromDir(projectAgentsDir, "project")) {
      map.set(a.name, a);
    }
  }
  // Only bundled profiles have trusted built-in capabilities. Never downgrade
  // a user/project override merely because it reused a familiar name.
  const worker = map.get("worker");
  if (worker?.source === "builtin") worker.mutating = true;
  for (const name of ["scout", "reviewer", "tester"]) {
    const a = map.get(name);
    if (a?.source === "builtin") a.mutating = false;
  }
  return { agents: Array.from(map.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[]): string {
  if (!agents.length) return "none";
  return agents.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; ");
}
