/**
 * grove/ui/tree-view.ts — jj-log style interactive tree view
 *
 * Keys:
 *   j/k or ↓/↑  move selection
 *   Enter       expand/collapse node details
 *   s           goto selected node (switch/navigate)
 *   c           commit (checkpoint current session)
 *   f           fork from selected node
 *   m           merge selected node into current (context-inject)
 *   p           cherry-pick selected node into current
 *   u           undo last repo operation
 *   q / Esc     close
 */

import {
  Container,
  type Component,
  type Focusable,
  type Theme,
} from "@earendil-works/pi-tui";
import type { GroveNode } from "../backend/types";

export interface GroveViewResult {
  action: "goto" | "commit" | "fork" | "merge" | "pick" | "undo" | "close";
  node?: GroveNode;
}

interface Row {
  node: GroveNode;
  depth: number;
  isCurrent: boolean;
  isExpanded: boolean;
  /** connector info: for each ancestor level, whether the edge continues */
  continues: boolean[];
  isLastChild: boolean;
}

function timeAgo(iso: string): string {
  if (!iso || iso.startsWith("1970")) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function kindGlyph(node: GroveNode): string {
  switch (node.manifest?.kind) {
    case "root": return "◇";
    case "fork": return "⑂";
    case "merge": return "⊙";
    default: return "◆";
  }
}

export class GroveTreeView extends Container implements Component, Focusable {
  private nodes: GroveNode[];
  private rows: Row[] = [];
  private selected = 0;
  private expanded = new Set<string>();
  private currentChangeId: string;
  private currentSessionRef: string | null;
  private theme: Theme;
  private _focused = false;
  private _resolve: ((r: GroveViewResult) => void) | null = null;

  constructor(
    nodes: GroveNode[],
    currentChangeId: string,
    currentSessionRef: string | null,
    theme: Theme,
  ) {
    super();
    this.nodes = nodes;
    this.currentChangeId = currentChangeId;
    this.currentSessionRef = currentSessionRef;
    this.theme = theme;
    this.rebuild();
    // Pre-select the node tracking the current session, else the @ change.
    const idx = this.rows.findIndex((r) => r.isCurrent);
    if (idx >= 0) this.selected = idx;
  }

  get focused(): boolean { return this._focused; }
  set focused(v: boolean) { this._focused = v; }

  setResolve(fn: (r: GroveViewResult) => void): void {
    this._resolve = fn;
  }

  private isCurrentNode(n: GroveNode): boolean {
    if (n.changeId === this.currentChangeId) return true;
    return Boolean(this.currentSessionRef && n.manifest?.sessionRef === this.currentSessionRef);
  }

  private rebuild(): void {
    const byParent = new Map<string, GroveNode[]>();
    const known = new Set(this.nodes.map((n) => n.changeId));
    const roots: GroveNode[] = [];
    for (const n of this.nodes) {
      const structural = n.parents.filter((p) => known.has(p));
      if (structural.length === 0) {
        roots.push(n);
      } else {
        const key = structural[0];
        const arr = byParent.get(key) ?? [];
        arr.push(n);
        byParent.set(key, arr);
      }
    }
    const byTimeDesc = (a: GroveNode, b: GroveNode) => b.timestamp.localeCompare(a.timestamp);
    roots.sort(byTimeDesc);
    for (const arr of byParent.values()) arr.sort(byTimeDesc);

    // Branch containing current node first among roots.
    const currentIdx = roots.findIndex((r) => this.isCurrentNode(r));
    if (currentIdx > 0) {
      const [cur] = roots.splice(currentIdx, 1);
      roots.unshift(cur);
    }

    const rows: Row[] = [];
    const walk = (node: GroveNode, depth: number, continues: boolean[], isLastChild: boolean) => {
      const isCur = this.isCurrentNode(node);
      rows.push({ node, depth, isCurrent: isCur, isExpanded: this.expanded.has(node.changeId), continues, isLastChild });
      const children = byParent.get(node.changeId) ?? [];
      // Merge children (2nd+ parents) are rendered as edge annotations, not walked twice.
      children.forEach((child, i) => {
        const last = i === children.length - 1;
        walk(child, depth + 1, [...continues, !last], last);
      });
    };
    roots.forEach((r, i) => walk(r, 0, [], i === roots.length - 1));
    this.rows = rows;
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
  }

  render(width: number): string[] {
    const fg = this.theme.fg.bind(this.theme);
    const bg = this.theme.bg.bind(this.theme);
    const bold = this.theme.bold.bind(this.theme);
    const out: string[] = [];

    out.push(fg("toolTitle", "grove") + fg("muted", ` · ${this.nodes.length} nodes`));
    out.push(fg("dim", "─".repeat(Math.min(width, 80))));
    out.push("");

    if (this.rows.length === 0) {
      out.push(fg("dim", "  (empty — create your first checkpoint with /grove commit <label>)"));
    }

    this.rows.forEach((row, i) => {
      const n = row.node;
      const m = n.manifest;

      // Tree connector prefix
      let prefix = "";
      for (let d = 0; d < row.depth; d++) {
        prefix += row.continues[d] ? "│  " : "   ";
      }
      if (row.depth > 0) prefix += row.isLastChild ? "└─ " : "├─ ";

      // Marker: @ for current, kind glyph otherwise
      const isAt = n.changeId === this.currentChangeId;
      const glyph = isAt ? "@" : kindGlyph(n);
      const glyphColored = isAt ? fg("accent", bold(glyph)) : m?.kind === "checkpoint" ? fg("success", glyph) : fg("muted", glyph);

      const label = m?.label ?? "(non-grove commit)";
      const labelStyled = row.isCurrent ? bold(label) : label;
      const meta: string[] = [];
      const ago = timeAgo(n.timestamp);
      if (ago) meta.push(ago);
      if (m && m.origin) meta.push(m.origin);
      if (m?.code?.dirty) meta.push("✎");
      if (n.parents.length > 1) meta.push(`${n.parents.length} parents`);

      let line = `${prefix}${glyphColored} ${fg("accent", labelStyled)}  ${fg("dim", meta.join(" · "))}`;
      if (i === this.selected) line = bg("selectedBg", line.padEnd(width));
      out.push(line);

      if (row.isExpanded && m) {
        const detailPrefix = prefix.replace(/[├└]─ $/, "   ") + "   ";
        const details = [
          `change ${n.changeId.slice(0, 12)} · session ${m.sessionRef}${m.entryId ? ` · entry ${m.entryId.slice(0, 8)}` : ""}`,
          m.code ? `code ${m.code.rev.slice(0, 8)}${m.code.dirty ? " (dirty)" : ""}` : "no code state",
        ];
        for (const d of details) out.push(fg("dim", detailPrefix + d));
      }
    });

    out.push("");
    out.push(fg("dim", "─".repeat(Math.min(width, 80))));
    out.push(fg("muted", "j/k:nav Enter:detail s:goto c:commit f:fork m:merge p:pick u:undo q:close"));
    return out;
  }

  handleInput(data: string): void {
    if (!this._resolve) return;
    const selectedNode = (): GroveNode | undefined => this.rows[this.selected]?.node;

    switch (data) {
      case "j":
      case "\x1b[B":
        this.selected = Math.min(this.selected + 1, this.rows.length - 1);
        this.invalidate();
        break;
      case "k":
      case "\x1b[A":
        this.selected = Math.max(this.selected - 1, 0);
        this.invalidate();
        break;
      case "\r":
      case "\n": {
        const n = selectedNode();
        if (n) {
          if (this.expanded.has(n.changeId)) this.expanded.delete(n.changeId);
          else this.expanded.add(n.changeId);
          this.rebuild();
          this.invalidate();
        }
        break;
      }
      case "s": {
        const n = selectedNode();
        if (n?.manifest) this._resolve({ action: "goto", node: n });
        break;
      }
      case "c":
        this._resolve({ action: "commit" });
        break;
      case "f": {
        const n = selectedNode();
        this._resolve({ action: "fork", node: n });
        break;
      }
      case "m": {
        const n = selectedNode();
        if (n?.manifest && !this.isCurrentNode(n)) this._resolve({ action: "merge", node: n });
        break;
      }
      case "p": {
        const n = selectedNode();
        if (n?.manifest && !this.isCurrentNode(n)) this._resolve({ action: "pick", node: n });
        break;
      }
      case "u":
        this._resolve({ action: "undo" });
        break;
      case "q":
      case "\x1b":
        this._resolve({ action: "close" });
        break;
    }
  }
}
