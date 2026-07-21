/**
 * grove/lib/snapshots.ts — content-addressed session snapshots
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sha256 } from "./sessions";

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{20,}/g, "sk-…REDACTED"],
  [/\b(AKIA[0-9A-Z]{16})\b/g, "AKIA…REDACTED"],
  [/ghp_[A-Za-z0-9]{20,}/g, "ghp_…REDACTED"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "JWT…REDACTED"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "xox…REDACTED"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "PRIVATE_KEY…REDACTED"],
];

export function redact(content: string): string {
  let out = content;
  for (const [re, replacement] of REDACT_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export function snapshotPath(snapshotId: string): string {
  return `objects/${snapshotId}.jsonl`;
}

/** Read + redact a session file; return { snapshotId, content, files map entry }. */
export function buildSnapshotFromSession(sessionFile: string): {
  snapshotId: string;
  content: string;
  files: Record<string, string>;
} {
  const raw = fs.readFileSync(sessionFile, "utf-8");
  const content = redact(raw);
  const snapshotId = sha256(content);
  return {
    snapshotId,
    content,
    files: { [snapshotPath(snapshotId)]: content },
  };
}

export function writeSnapshotToRepo(repoDir: string, snapshotId: string, content: string): string {
  const rel = snapshotPath(snapshotId);
  const fp = path.join(repoDir, rel);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  if (!fs.existsSync(fp)) fs.writeFileSync(fp, content);
  return rel;
}
