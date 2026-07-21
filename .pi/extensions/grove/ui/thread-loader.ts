/**
 * Load and project the exact chat branch represented by a SessionNode.
 */

import * as fs from "node:fs";
import type { SessionAnchor } from "../backend/types";
import type { SessionNode, TreeBackend } from "../backend/types";
import {
  resolveAnchor,
  resolveAnchorContent,
  resolveSessionRef,
} from "../lib/sessions";
import { snapshotPath } from "../lib/snapshots";

export type ThreadItemKind =
  | "user"
  | "assistant"
  | "tool"
  | "custom"
  | "summary"
  | "system";

export interface ThreadItem {
  id: string;
  parentId: string | null;
  kind: ThreadItemKind;
  text: string;
  timestamp?: string;
}

export interface NodeThread {
  nodeId: string;
  source: "local" | "snapshot";
  items: ThreadItem[];
  truncatedAtAnchor: boolean;
}

interface ParsedLine {
  index: number;
  raw: any;
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => {
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (part?.type === "image") return `[image${part.mimeType ? `: ${part.mimeType}` : ""}]`;
      if (part?.type === "toolCall") {
        const args = part.arguments ?? part.args;
        return `→ ${part.name ?? "tool"}${args ? ` ${JSON.stringify(args)}` : ""}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function itemFromEntry(entry: any, fallbackId: string): ThreadItem | null {
  const id = String(entry?.id ?? entry?.entryId ?? fallbackId);
  const parentId = entry?.parentId == null ? null : String(entry.parentId);
  const timestamp = typeof entry?.timestamp === "string" ? entry.timestamp : undefined;

  if (entry?.type === "message" || entry?.message || entry?.role) {
    const message = entry.message ?? entry;
    const role = String(message?.role ?? entry?.role ?? "");
    const text = textContent(message?.content ?? entry?.content);
    if (!text) return null;
    const kind: ThreadItemKind =
      role === "user" ? "user" :
      role === "assistant" ? "assistant" :
      role === "toolResult" || role === "tool" ? "tool" :
      "system";
    return { id, parentId, kind, text, timestamp };
  }
  if (entry?.type === "custom_message" && entry.display !== false) {
    const text = textContent(entry.content);
    if (!text) return null;
    return { id, parentId, kind: "custom", text, timestamp };
  }
  if (entry?.type === "compaction" || entry?.type === "branch_summary") {
    const text = String(entry.summary ?? "").trim();
    if (!text) return null;
    return { id, parentId, kind: "summary", text, timestamp };
  }
  return null;
}

function resolveAnchorLine(
  lines: ParsedLine[],
  anchor: SessionAnchor,
): ParsedLine | undefined {
  if (anchor.entryId) {
    const exact = lines.find((line) => {
      const entry = line.raw;
      return (
        entry?.id === anchor.entryId ||
        entry?.entryId === anchor.entryId ||
        entry?.message?.id === anchor.entryId
      );
    });
    if (exact) return exact;
  }
  if (anchor.ordinal != null) {
    const atOrdinal = lines.find((line) => line.index === anchor.ordinal);
    if (atOrdinal && atOrdinal.raw?.type !== "session") return atOrdinal;
    const before = lines
      .filter((line) => line.index <= anchor.ordinal! && line.raw?.type !== "session")
      .at(-1);
    if (before) return before;
  }
  return lines.filter((line) => line.raw?.type !== "session").at(-1);
}

export function parseAnchoredThread(
  content: string,
  anchor: SessionAnchor,
): { items: ThreadItem[]; truncatedAtAnchor: boolean } {
  const lines: ParsedLine[] = [];
  content.split("\n").forEach((line, index) => {
    if (!line.trim()) return;
    try {
      lines.push({ index, raw: JSON.parse(line) });
    } catch {
      /* malformed historical rows are ignored */
    }
  });
  const anchorLine = resolveAnchorLine(lines, anchor);
  if (!anchorLine) return { items: [], truncatedAtAnchor: false };

  const entries = lines.filter((line) => line.raw?.type !== "session");
  const byId = new Map<string, ParsedLine>();
  for (const line of entries) {
    const id = line.raw?.id ?? line.raw?.entryId;
    if (id != null) byId.set(String(id), line);
  }

  const branch: ParsedLine[] = [];
  const visited = new Set<string>();
  let cursor: ParsedLine | undefined = anchorLine;
  while (cursor) {
    const id = String(cursor.raw?.id ?? cursor.raw?.entryId ?? `line-${cursor.index}`);
    if (visited.has(id)) break;
    visited.add(id);
    branch.push(cursor);
    const parentId = cursor.raw?.parentId;
    cursor = parentId == null ? undefined : byId.get(String(parentId));
  }

  // Old session rows may not have parentId. Preserve their sequential history
  // up to the anchor instead of showing only one message.
  if (branch.length <= 1 && entries.length > 1) {
    branch.splice(
      0,
      branch.length,
      ...entries.filter((line) => line.index <= anchorLine.index),
    );
  } else {
    branch.reverse();
  }

  const items = branch
    .map((line) => itemFromEntry(line.raw, `line-${line.index}`))
    .filter((item): item is ThreadItem => Boolean(item));
  const hasRowsAfterAnchor = entries.some((line) => line.index > anchorLine.index);
  return { items, truncatedAtAnchor: hasRowsAfterAnchor };
}

export async function loadNodeThread(
  backend: TreeBackend,
  cwd: string,
  node: SessionNode,
): Promise<NodeThread> {
  const local = resolveSessionRef(cwd, node.sessionId);
  if (local && fs.existsSync(local)) {
    const anchor = resolveAnchor(local, node.anchor);
    if (anchor.ok) {
      const parsed = parseAnchoredThread(fs.readFileSync(local, "utf8"), node.anchor);
      return {
        nodeId: node.nodeId,
        source: "local",
        ...parsed,
      };
    }
  }
  if (!node.snapshotId) {
    return {
      nodeId: node.nodeId,
      source: "snapshot",
      items: [],
      truncatedAtAnchor: false,
    };
  }
  const objectPath = snapshotPath(node.snapshotId);
  const content =
    (await backend.showFile(node.backendRef.changeId, objectPath)) ??
    (await backend.showFile("@", objectPath));
  const parsed = content && resolveAnchorContent(content, node.anchor).ok
    ? parseAnchoredThread(content, node.anchor)
    : { items: [], truncatedAtAnchor: false };
  return {
    nodeId: node.nodeId,
    source: "snapshot",
    ...parsed,
  };
}
