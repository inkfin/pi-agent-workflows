/**
 * Read/navigation Grove graph view.
 *
 * The domain APIs support future edge editing; this UI intentionally remains
 * a compact navigator for the current milestone.
 */

import {
  Container,
  type Component,
  type Focusable,
  type Theme,
} from "@earendil-works/pi-tui";
import type { GroveGraph, SessionNode } from "../backend/types";
import { isEffectivelySealed } from "../backend/types";

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
  node?: SessionNode;
  disabledReason?: string;
}

interface Row {
  node: SessionNode;
  depth: number;
  isCurrent: boolean;
  isExpanded: boolean;
  continues: boolean[];
  isLastChild: boolean;
}

function timeAgo(iso: string): string {
  if (!iso || iso.startsWith("1970")) return "";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d` : `${Math.floor(days / 30)}mo`;
}

export class GroveTreeView extends Container implements Component, Focusable {
  private rows: Row[] = [];
  private selected = 0;
  private readonly expanded = new Set<string>();
  private readonly graph: GroveGraph;
  private readonly currentNodeId: string | null;
  private readonly currentSessionRef: string | null;
  private readonly theme: Theme;
  private _focused = false;
  private _resolve: ((result: GroveViewResult) => void) | null = null;
  private statusHint = "";

  constructor(
    graph: GroveGraph,
    currentNodeId: string | null,
    currentSessionRef: string | null,
    theme: Theme,
  ) {
    super();
    this.graph = graph;
    this.currentNodeId = currentNodeId;
    this.currentSessionRef = currentSessionRef;
    this.theme = theme;
    this.rebuild();
    let index = this.rows.findIndex((row) => row.isCurrent);
    if (index < 0 && currentSessionRef) {
      index = this.rows.findIndex((row) => row.node.sessionId === currentSessionRef);
    }
    if (index >= 0) this.selected = index;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  setResolve(resolve: (result: GroveViewResult) => void): void {
    this._resolve = resolve;
  }

  private rebuild(): void {
    const activeLineage = this.graph.edges.filter(
      (edge) => edge.kind === "lineage" && edge.state === "active",
    );
    const byParent = new Map<string, SessionNode[]>();
    const childIds = new Set<string>();
    for (const edge of activeLineage) {
      const child = this.graph.nodes.find((node) => node.nodeId === edge.toNodeId);
      if (!child) continue;
      childIds.add(child.nodeId);
      const children = byParent.get(edge.fromNodeId) ?? [];
      children.push(child);
      byParent.set(edge.fromNodeId, children);
    }
    const newest = (a: SessionNode, b: SessionNode) => b.updatedAt.localeCompare(a.updatedAt);
    const roots = this.graph.nodes.filter((node) => !childIds.has(node.nodeId)).sort(newest);
    for (const children of byParent.values()) children.sort(newest);

    const rows: Row[] = [];
    const visited = new Set<string>();
    const walk = (
      node: SessionNode,
      depth: number,
      continues: boolean[],
      isLastChild: boolean,
    ) => {
      if (visited.has(node.nodeId)) return;
      visited.add(node.nodeId);
      rows.push({
        node,
        depth,
        isCurrent: node.nodeId === this.currentNodeId,
        isExpanded: this.expanded.has(node.nodeId),
        continues,
        isLastChild,
      });
      const children = byParent.get(node.nodeId) ?? [];
      children.forEach((child, index) => {
        const last = index === children.length - 1;
        walk(child, depth + 1, [...continues, !last], last);
      });
    };
    roots.forEach((root, index) => walk(root, 0, [], index === roots.length - 1));
    for (const orphan of this.graph.nodes.filter((node) => !visited.has(node.nodeId)).sort(newest)) {
      walk(orphan, 0, [], true);
    }
    this.rows = rows;
    this.selected = Math.min(this.selected, Math.max(0, rows.length - 1));
  }

  private emit(action: GroveAction, node?: SessionNode, disabledReason?: string): void {
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
    const output: string[] = [
      fg("toolTitle", "grove") +
        fg("muted", ` · ${this.graph.nodes.length} nodes · ${this.graph.edges.length} edges`),
      fg("dim", "─".repeat(Math.min(width, 80))),
      "",
    ];
    if (!this.rows.length) output.push(fg("dim", "  (empty — /grove commit <label>)"));

    this.rows.forEach((row, index) => {
      const node = row.node;
      let prefix = "";
      for (let depth = 0; depth < row.depth; depth++) {
        prefix += row.continues[depth] ? "│  " : "   ";
      }
      if (row.depth > 0) prefix += row.isLastChild ? "└─ " : "├─ ";

      const attachments = this.graph.attachments.filter(
        (attachment) => attachment.targetNodeId === node.nodeId,
      );
      const hasOutcome = attachments.some((attachment) => attachment.kind === "execution_outcome");
      const glyph = row.isCurrent ? "@" : hasOutcome ? "■" : node.capture.source === "manual" ? "◆" : "○";
      const meta = [
        timeAgo(node.updatedAt),
        node.state === "draft" && !isEffectivelySealed(node, this.graph.edges) ? "draft" : "sealed",
        node.pinned ? "pinned" : "",
        node.publishedAt ? "published" : "",
        attachments.map((attachment) => attachment.kind.replace("execution_", "")).join(","),
        node.code?.dirty ? "✎" : "",
      ].filter(Boolean);
      let line = `${prefix}${fg(row.isCurrent ? "accent" : "muted", glyph)} ${fg(
        "accent",
        row.isCurrent ? bold(node.label) : node.label,
      )}  ${fg("dim", meta.join(" · "))}`;
      if (index === this.selected) line = bg("selectedBg", line.padEnd(width));
      output.push(line);

      if (row.isExpanded) {
        const detailPrefix = prefix.replace(/[├└]─ $/, "   ") + "   ";
        const contextEdges = this.graph.edges.filter(
          (edge) =>
            edge.state === "active" &&
            edge.kind !== "lineage" &&
            (edge.fromNodeId === node.nodeId || edge.toNodeId === node.nodeId),
        );
        const details = [
          `node ${node.nodeId.slice(0, 20)} · backend ${node.backendRef.changeId.slice(0, 12)}`,
          `session ${node.sessionId || "—"} · revision ${node.revision}`,
          `anchor ${node.anchor.entryId?.slice(0, 8) ?? "head"} · snapshot ${node.snapshotId?.slice(0, 12) ?? "none"}`,
          node.code
            ? `code ${node.code.rev.slice(0, 8)}${node.code.dirty ? " dirty" : ""} fp ${node.code.fingerprint ?? "?"}`
            : "no code state",
          contextEdges.length ? `${contextEdges.length} context/supersedes edge(s)` : "",
        ].filter(Boolean);
        for (const detail of details) output.push(fg("dim", detailPrefix + detail));
      }
    });

    output.push("", fg("dim", "─".repeat(Math.min(width, 80))));
    if (this.statusHint) output.push(fg("warning", this.statusHint));
    output.push(
      fg(
        "muted",
        "j/k s:goto c:commit f:fork m:context p:inject u:undo a/A/S:auto r:realign y/Y:sync d:dash n:pin q",
      ),
    );
    return output;
  }

  handleInput(data: string): void {
    if (!this._resolve) return;
    const selectedNode = () => this.rows[this.selected]?.node;
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
        const node = selectedNode();
        if (node) {
          if (this.expanded.has(node.nodeId)) this.expanded.delete(node.nodeId);
          else this.expanded.add(node.nodeId);
          this.rebuild();
          this.invalidate();
        }
        break;
      }
      case "s":
        this.emit("goto", selectedNode(), selectedNode() ? undefined : "no node selected");
        break;
      case "c":
        this.emit("commit");
        break;
      case "f":
        this.emit("fork", selectedNode(), selectedNode() ? undefined : "select a node");
        break;
      case "m":
        this.emit(
          "merge",
          selectedNode(),
          !selectedNode()
            ? "select a node"
            : selectedNode()?.nodeId === this.currentNodeId
              ? "cannot inject current node into itself"
              : undefined,
        );
        break;
      case "p":
        this.emit(
          "pick",
          selectedNode(),
          !selectedNode()
            ? "select a node"
            : selectedNode()?.nodeId === this.currentNodeId
              ? "cannot inject current node into itself"
              : undefined,
        );
        break;
      case "u":
        this.emit("undo");
        break;
      case "a":
        this.emit("auto-keep", selectedNode(), selectedNode() ? undefined : "select a node");
        break;
      case "A":
        this.emit("auto-replace", selectedNode(), selectedNode() ? undefined : "select a node");
        break;
      case "S":
        this.emit("auto-split", selectedNode(), selectedNode() ? undefined : "select a node");
        break;
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
      case "n":
        this.emit("pin", selectedNode(), selectedNode() ? undefined : "select a node");
        break;
      case "q":
      case "\x1b":
        this.emit("close");
        break;
    }
  }
}
