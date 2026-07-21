/**
 * grove/lib/sessions.ts — pi session helpers + SessionAnchor
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionAnchor } from "../backend/types";

export function getSessionsDir(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
  return path.join(agentDir, "sessions");
}

/** Matches pi's session dir naming: --<path-with-dashes>-- */
export function cwdToSessionSlug(cwd: string): string {
  return "--" + cwd.replace(/^\//, "").replace(/\//g, "-").replace(/ /g, "_") + "--";
}

export function projectSessionsDir(cwd: string): string {
  return path.join(getSessionsDir(), cwdToSessionSlug(cwd));
}

export function resolveSessionRef(cwd: string, sessionId: string): string | null {
  const fp = path.join(projectSessionsDir(cwd), sessionId);
  return fs.existsSync(fp) ? fp : null;
}

export function materializeSession(cwd: string, sessionId: string, content: string): string {
  const dir = projectSessionsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, sessionId);
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

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashLine(line: string): string {
  return sha256(line).slice(0, 16);
}

/** Build a SessionAnchor from a session file and optional entryId. */
export function captureAnchor(sessionFile: string, entryId: string | null): SessionAnchor {
  const raw = fs.readFileSync(sessionFile, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  if (!entryId) {
    const last = lines[lines.length - 1] ?? "";
    return {
      entryId: null,
      entryHash: last ? hashLine(last) : null,
      ordinal: lines.length > 0 ? lines.length - 1 : null,
      prefixHash: sha256(lines.join("\n")).slice(0, 16),
    };
  }

  let ordinal: number | null = null;
  let entryHash: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    try {
      const entry = JSON.parse(line);
      const id = entry?.id ?? entry?.entryId ?? entry?.message?.id;
      if (id === entryId) {
        ordinal = i;
        entryHash = hashLine(line);
        break;
      }
    } catch {
      /* skip */
    }
  }
  const prefix = ordinal != null ? lines.slice(0, ordinal + 1).join("\n") : raw;
  return {
    entryId,
    entryHash,
    ordinal,
    prefixHash: sha256(prefix).slice(0, 16),
  };
}

export type AnchorResolve =
  | { ok: true; method: "entryId" | "ordinal" | "prefixHash"; entryId: string | null }
  | { ok: false; reason: string };

function entryIdFromLine(line: string): string | null {
  try {
    const entry = JSON.parse(line);
    const id = entry?.id ?? entry?.entryId ?? entry?.message?.id;
    return id == null || entry?.type === "session" ? null : String(id);
  } catch {
    return null;
  }
}

/** Resolve an anchor against a live session file (compaction-aware). */
export function resolveAnchor(sessionFile: string, anchor: SessionAnchor): AnchorResolve {
  if (!fs.existsSync(sessionFile)) {
    return { ok: false, reason: "session file missing" };
  }
  return resolveAnchorContent(fs.readFileSync(sessionFile, "utf-8"), anchor);
}

export function resolveAnchorContent(
  content: string,
  anchor: SessionAnchor,
): AnchorResolve {
  const lines = content.split("\n").filter(Boolean);

  if (anchor.entryId) {
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const id = entry?.id ?? entry?.entryId ?? entry?.message?.id;
        if (id === anchor.entryId) {
          if (!anchor.entryHash || hashLine(line) === anchor.entryHash) {
            return { ok: true, method: "entryId", entryId: String(id) };
          }
          break;
        }
      } catch {
        /* skip */
      }
    }
  }

  if (anchor.ordinal != null && anchor.ordinal >= 0 && anchor.ordinal < lines.length && anchor.entryHash) {
    if (hashLine(lines[anchor.ordinal]) === anchor.entryHash) {
      return {
        ok: true,
        method: "ordinal",
        entryId: entryIdFromLine(lines[anchor.ordinal]),
      };
    }
  }

  if (anchor.prefixHash) {
    for (let i = 0; i < lines.length; i++) {
      const prefix = lines.slice(0, i + 1).join("\n");
      if (sha256(prefix).slice(0, 16) === anchor.prefixHash) {
        return {
          ok: true,
          method: "prefixHash",
          entryId: entryIdFromLine(lines[i]),
        };
      }
    }
  }

  return { ok: false, reason: "anchor stale after compaction or rewrite" };
}

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
      /* skip */
    }
    if (snippets.length >= maxSnippets) break;
  }
  const joined = snippets.join("\n\n");
  return joined.length > maxLen ? joined.slice(0, maxLen) + "\n…(truncated)" : joined;
}
