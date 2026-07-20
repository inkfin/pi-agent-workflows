/**
 * grove/lib/sessions.ts — pi session file helpers
 *
 * Session identity = file basename (portable across machines).
 * Paths are resolved locally per machine via the sessions dir + project slug.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function getSessionsDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "sessions");
}

/** Matches pi's session dir naming: --<path-with-dashes> */
export function cwdToSessionSlug(cwd: string): string {
  return "--" + cwd.replace(/^\//, "").replace(/\//g, "-").replace(/ /g, "_");
}

export function projectSessionsDir(cwd: string): string {
  return path.join(getSessionsDir(), cwdToSessionSlug(cwd));
}

/** Local absolute path for a sessionRef (basename); null when not present locally. */
export function resolveSessionRef(cwd: string, sessionRef: string): string | null {
  const fp = path.join(projectSessionsDir(cwd), sessionRef);
  return fs.existsSync(fp) ? fp : null;
}

/** Materialize a snapshot into the local sessions dir; returns the path. */
export function materializeSession(cwd: string, sessionRef: string, content: string): string {
  const dir = projectSessionsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, sessionRef);
  fs.writeFileSync(fp, content);
  return fp;
}

export function countSessionMessages(sessionFile: string): number {
  try {
    return fs.readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/**
 * Extract a short textual summary from a session snapshot (for context-inject).
 * Naive: last few user/assistant text snippets, truncated.
 */
export function summarizeSessionContent(content: string, maxSnippets = 12, maxLen = 2000): string {
  const snippets: string[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const role = entry?.role ?? entry?.message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const parts = entry?.content ?? entry?.message?.content;
      if (!Array.isArray(parts)) continue;
      const text = parts
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n")
        .trim();
      if (text) snippets.push(`[${role}] ${text.slice(0, 300)}`);
    } catch {
      /* skip non-JSON lines */
    }
    if (snippets.length >= maxSnippets) break;
  }
  const joined = snippets.join("\n\n");
  return joined.length > maxLen ? joined.slice(0, maxLen) + "\n…(truncated)" : joined;
}
