/**
 * grove/ui/tree-view.ts — full-capability interactive grove view
 *
 * Keys:
 *   j/k     navigate
 *   Enter   expand/collapse details
 *   s       goto
 *   c       commit (checkpoint)
 *   f       fork from selected
 *   m       context merge
 *   p       cherry-pick
 *   u       logical undo
 *   a       auto menu (keep/replace/split) — cycles via result
 *   r       realign / recover
 *   y       sync push
 *   Y       sync pull
 *   d       dashboard
 *   n       rename/pin
 *   q/Esc   close
 */

import {
  Container,
  type Component,
  type Focusable,
  type Theme,
} from "@earendil-works/pi-tui";
import type { GroveNode } from "../backend/types";

export type GroveAction =
  | "goto"
  | "commit"
  | "fork"
  | "merge"
  | "pick"
  | "undo"
  | "auto-keep"
  | "auto-replace"
  | "auto-split"
  | "realign"
  | "sync-push"
  | "sync-pull"
  | "dashboard"
  | "pin"
  | "close";

export interface GroveViewResult {
  action: GroveAction;
  node?: GroveNode;
  disabledReason?: string;
}

interface Row {
  node: GroveNode;
  depth: number;
  isCurrent: boolean;
  isExpanded: boolean;
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
    case "context_merge": return "⊙";
    case "auto": return "○";
    case "frontier": return "▣";
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
  private statusHint = "";

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
    let idx = this.rows.findIndex((r) => r.isCurrent);
    if (idx < 0 && this.currentSessionRef) {
      idx = this.rows.findIndex((r) => r.node.manifest?.sessionId === this.currentSessionRef);
    }
    if (idx >= 0) this.selected = idx;
  }

  get focused(): boolean { return this._focused; }
  set focused(v: boolean) { this._focused = v; }

  setResolve(fn: (r: GroveViewResult) => void): void {
    this._resolve = fn;
  }

  private isCurrentNode(n: GroveNode): boolean {
    return n.changeId === this.currentChangeId;
  }

  private rebuild(): void {
    const byParent = new Map<string, GroveNode[]>();
    const known = new Set(this.nodes.map((n) => n.changeId));
    const roots: GroveNode[] = [];
    for (const n of this.nodes) {
      const structural = n.parents.filter((p) => known.has(p));
      if (structural.length === 0) roots.push(n);
      else {
        const key = structural[0];
        const arr = byParent.get(key) ?? [];
        arr.push(n);
        byParent.set(key, arr);
      }
    }
    const byTimeDesc = (a: GroveNode, b: GroveNode) => b.timestamp.localeCompare(a.timestamp);
    roots.sort(byTimeDesc);
    for (const arr of byParent.values()) arr.sort(byTimeDesc);

    const rows: Row[] = [];
    const walk = (node: GroveNode, depth: number, continues: boolean[], isLastChild: boolean) => {
      rows.push({
        node,
        depth,
        isCurrent: this.isCurrentNode(node),
        isExpanded: this.expanded.has(node.changeId),
        continues,
        isLastChild,
      });
      const children = byParent.get(node.changeId) ?? [];
      children.forEach((child, i) => {
        const last = i === children.length - 1;
        walk(child, depth + 1, [...continues, !last], last);
      });
    };
    roots.forEach((r, i) => walk(r, 0, [], i === roots.length - 1));
    this.rows = rows;
    if (this.selected >= rows.length) this.selected = Math.max(0, rows.length - 1);
  }

  private emit(action: GroveAction, node?: GroveNode, disabledReason?: string): void {
    if (!this._resolve) return;
    if (disabledReason) {
      this.statusHint = disabledReason;
      this.invalidate();
      return;
    }
    this._resolve({ action, node });
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
      out.push(fg("dim", "  (empty — /grove commit <label>)"));
    }

    this.rows.forEach((row, i) => {
      const n = row.node;
      const m = n.manifest;
      let prefix = "";
      for (let d = 0; d < row.depth; d++) {
        prefix += row.continues[d] ? "│  " : "   ";
      }
      if (row.depth > 0) prefix += row.isLastChild ? "└─ " : "├─ ";

      const isAt = n.changeId === this.currentChangeId;
      const glyph = isAt ? "@" : kindGlyph(n);
      const glyphColored = isAt
        ? fg("accent", bold(glyph))
        : m?.kind === "checkpoint"
          ? fg("success", glyph)
          : m?.kind === "auto"
            ? fg("warning", glyph)
            : fg("muted", glyph);

      const label = m?.label ?? "(non-grove)";
      const labelStyled = row.isCurrent ? bold(label) : label;
      const meta: string[] = [];
      const ago = timeAgo(n.timestamp);
      if (ago) meta.push(ago);
      if (m?.lifecycle && m.lifecycle !== "pinned") meta.push(m.lifecycle);
      if (m?.origin) meta.push(m.origin);
      if (m?.code?.dirty) meta.push("✎");
      if (m?.supersedes) meta.push("supersedes");
      if (n.parents.length > 1) meta.push(`${n.parents.length} parents`);

      let line = `${prefix}${glyphColored} ${fg("accent", labelStyled)}  ${fg("dim", meta.join(" · "))}`;
      if (i === this.selected) line = bg("selectedBg", line.padEnd(width));
      out.push(line);

      if (row.isExpanded && m) {
        const detailPrefix = prefix.replace(/[├└]─ $/, "   ") + "   ";
        const details = [
          `change ${n.changeId.slice(0, 12)} · session ${m.sessionId || "—"} · life ${m.lifecycle}`,
          `anchor entry ${m.anchor.entryId?.slice(0, 8) ?? "head"} · snap ${m.snapshotId?.slice(0, 12) ?? "none"}`,
          m.code
            ? `code ${m.code.rev.slice(0, 8)}${m.code.dirty ? " dirty" : ""} fp ${m.code.fingerprint ?? "?"}`
            : "no code state",
          m.forkFrom ? `forkFrom ${m.forkFrom.parentChangeId.slice(0, 8)}` : "",
          m.mergeOf ? `mergeOf ${m.mergeOf.map((s) => s.changeId.slice(0, 8)).join(",")}` : "",
        ].filter(Boolean);
        for (const d of details) out.push(fg("dim", detailPrefix + d));
      }
    });

    out.push("");
    out.push(fg("dim", "─".repeat(Math.min(width, 80))));
    if (this.statusHint) out.push(fg("warning", this.statusHint));
    out.push(
      fg(
        "muted",
        "j/k s:goto c:commit f:fork m:merge p:pick u:undo a/A/S:auto r:realign y/Y:sync d:dash n:pin q",
      ),
    );
    return out;
  }

  handleInput(data: string): void {
    if (!this._resolve) return;
    const selectedNode = (): GroveNode | undefined => this.rows[this.selected]?.node;
    this.statusHint = "";

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
        if (!n?.manifest) this.emit("goto", undefined, "no node selected");
        else this.emit("goto", n);
        break;
      }
      case "c":
        this.emit("commit");
        break;
      case "f": {
        const n = selectedNode();
        if (!n?.manifest) this.emit("fork", undefined, "select a node to fork from");
        else this.emit("fork", n);
        break;
      }
      case "m": {
        const n = selectedNode();
        if (!n?.manifest) this.emit("merge", undefined, "select a node");
        else if (this.isCurrentNode(n)) this.emit("merge", n, "cannot merge @ into itself");
        else this.emit("merge", n);
        break;
      }
      case "p": {
        const n = selectedNode();
        if (!n?.manifest) this.emit("pick", undefined, "select a node");
        else if (this.isCurrentNode(n)) this.emit("pick", n, "cannot pick @ into itself");
        else this.emit("pick", n);
        break;
      }
      case "u":
        this.emit("undo");
        break;
      case "a": {
        const n = selectedNode();
        if (!n?.manifest || n.manifest.kind !== "auto") {
          this.emit("auto-keep", n, "select an auto node");
        } else this.emit("auto-keep", n);
        break;
      }
      case "A": {
        const n = selectedNode();
        if (!n?.manifest || n.manifest.kind !== "auto") {
          this.emit("auto-replace", n, "select an auto node");
        } else this.emit("auto-replace", n);
        break;
      }
      case "S": {
        const n = selectedNode();
        if (!n?.manifest || n.manifest.kind !== "auto") {
          this.emit("auto-split", n, "select an auto node");
        } else this.emit("auto-split", n);
        break;
      }
      case "r":
        this.emit("realign", selectedNode());
        break;
      case "y":
        this.emit("sync-push");
        break;
      case "Y":
        this.emit("sync-pull");
        break;
      case "d":
        this.emit("dashboard");
        break;
      case "n": {
        const n = selectedNode();
        if (!n?.manifest) this.emit("pin", undefined, "select a node");
        else this.emit("pin", n);
        break;
      }
      case "q":
      case "\x1b":
        this.emit("close");
        break;
    }
  }
}
