/**
 * project-tree/ui/tree-view.ts — Interactive tree view for project branches
 *
 * tig-style navigation:
 *   j/k or ↓/↑  — move selection
 *   Enter        — expand/collapse branch details
 *   s            — switch to selected branch
 *   m            — merge selected branch into current
 *   c            — create new branch
 *   a            — archive selected branch
 *   r            — rename selected branch
 *   q / Esc      — close tree view
 *
 * Renders as a custom TUI component via ctx.ui.custom().
 */

import {
  Container,
  Text,
  Spacer,
  CURSOR_MARKER,
  type Component,
  type Focusable,
  type Theme,
} from "@earendil-works/pi-tui";
import type {
  Branch,
  ProjectTree,
  TreeNode,
} from "../state";
import {
  buildTree,
  countSessionMessages,
  sessionLastModified,
  getChildBranches,
} from "../state";

// ─── Helpers ─────────────────────────────────────────────────

function timeAgo(iso: string): string {
  if (!iso || iso.startsWith("1970")) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function branchIcon(b: Branch, isCurrent: boolean): string {
  if (isCurrent) return "●";
  if (b.source === "remote") return "○";
  if (b.status === "merged") return "◉";
  return "●";
}

function statusEmoji(b: Branch): string {
  if (b.tags?.includes("wip")) return "🚧";
  if (b.tags?.includes("review-needed")) return "👁";
  return "";
}

// ─── Line Types ──────────────────────────────────────────────

interface TreeLine {
  type: "branch";
  branch: Branch;
  depth: number;
  isCurrent: boolean;
  isLastChild: boolean;
  prefix: string;
  messageCount: number;
  lastActive: string;
}

interface TreeLineDetail {
  type: "detail";
  branch: Branch;
  text: string;
}

type DisplayLine = TreeLine | TreeLineDetail;

// ─── Build Display Lines ─────────────────────────────────────

function buildDisplayLines(node: TreeNode, isCurrent: (b: Branch) => boolean, expanded: Set<string>, isLast: boolean): DisplayLine[] {
  const lines: DisplayLine[] = [];
  const b = node.branch;

  // Calculate the tree prefix: │  ├── └── etc
  let prefix = "";
  // depth handled by parent

  lines.push({
    type: "branch",
    branch: b,
    depth: node.depth,
    isCurrent: isCurrent(b),
    isLastChild: isLast,
    prefix,
    messageCount: countSessionMessages(b.sessionFile),
    lastActive: b.lastActiveAt || sessionLastModified(b.sessionFile),
  } as TreeLine);

  // If expanded, show children and details
  if (expanded.has(b.id)) {
    // Show description if present
    if (b.description) {
      lines.push({
        type: "detail",
        branch: b,
        text: `  ${b.description}`,
      });
    }
    // Show metadata
    const meta: string[] = [];
    if (b.tags && b.tags.length > 0) meta.push(`tags: ${b.tags.join(", ")}`);
    if (b.remoteOrigin) meta.push(`from: ${b.remoteOrigin}`);
    if (b.parentEntryId) meta.push(`fork: ${b.parentEntryId.slice(0, 8)}...`);
    if (meta.length > 0) {
      lines.push({
        type: "detail",
        branch: b,
        text: `  ${meta.join(" · ")}`,
      });
    }

    // Show children
    for (let i = 0; i < node.children.length; i++) {
      lines.push(...buildDisplayLines(node.children[i], isCurrent, expanded, i === node.children.length - 1));
    }
  }

  return lines;
}

// ─── Tree View Component ─────────────────────────────────────

export interface TreeViewResult {
  action: "switch" | "merge" | "create" | "archive" | "rename" | "close";
  branch?: Branch;
  name?: string; // for create/rename
}

export class TreeView extends Container implements Component, Focusable {
  private displayLines: DisplayLine[] = [];
  private selectedIndex = 0;
  private branchIndexes: number[] = []; // maps display index to branch line index
  private expanded: Set<string> = new Set();
  private tree: ProjectTree;
  private currentSessionFile: string | null;
  private theme: Theme;
  private _focused = false;
  private _resolve: ((result: TreeViewResult) => void) | null = null;

  constructor(
    tree: ProjectTree,
    currentSessionFile: string | null,
    theme: Theme,
  ) {
    super();
    this.tree = tree;
    this.currentSessionFile = currentSessionFile;
    this.theme = theme;
    this.rebuild();
  }

  // Focusable
  get focused(): boolean { return this._focused; }
  set focused(v: boolean) { this._focused = v; }

  setResolve(fn: (result: TreeViewResult) => void): void {
    this._resolve = fn;
  }

  private isCurrent(b: Branch): boolean {
    return b.sessionFile === this.currentSessionFile;
  }

  private rebuild(): void {
    const nodes = buildTree(this.tree);
    const lines: DisplayLine[] = [];
    for (let i = 0; i < nodes.length; i++) {
      lines.push(...buildDisplayLines(nodes[i], (b) => this.isCurrent(b), this.expanded, i === nodes.length - 1));
    }
    this.displayLines = lines;
    this.branchIndexes = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].type === "branch") this.branchIndexes.push(i);
    }

    // Keep selection in bounds
    if (this.selectedIndex >= this.branchIndexes.length) {
      this.selectedIndex = Math.max(0, this.branchIndexes.length - 1);
    }
  }

  // ── Render ───────────────────────────────────────────────

  render(width: number): string[] {
    const out: string[] = [];
    const fg = this.theme.fg.bind(this.theme);
    const bold = this.theme.bold.bind(this.theme);

    // Header
    const activeCount = this.tree.branches.filter((b) => b.status === "active").length;
    out.push(
      fg("toolTitle", `Project Tree · ${this.tree.projectName}`) +
        fg("muted", ` · ${activeCount} active branches`),
    );
    out.push(fg("dim", "─".repeat(Math.min(width, 80))));
    out.push("");

    // Build tree prefix strings
    // We need to compute the tree drawing chars (│ ├── └── etc.)
    const renderedLines: string[] = [];

    // We'll build a stack of "last child at depth" booleans
    const computePrefix = (node: TreeNode, ancestorLast: boolean[]): string => {
      let p = "";
      for (let d = 0; d < node.depth; d++) {
        if (d < ancestorLast.length) {
          p += ancestorLast[d] ? "    " : "│   ";
        } else {
          p += "    ";
        }
      }
      const lastAtThisDepth = ancestorLast[node.depth - 1] ?? true;
      p += lastAtThisDepth ? "└── " : "├── ";
      return p;
    };

    const renderNode = (node: TreeNode, ancestorLast: boolean[], lines: string[]) => {
      const b = node.branch;
      const isCur = this.isCurrent(b);
      const prefix = computePrefix(node, ancestorLast);
      const icon = branchIcon(b, isCur);
      const emoji = statusEmoji(b);
      const msgCount = countSessionMessages(b.sessionFile);
      const ago = timeAgo(b.lastActiveAt || sessionLastModified(b.sessionFile));
      const nameDisplay = isCur ? bold(b.name) : b.name;
      const remote = b.source === "remote" ? fg("muted", ` (${b.remoteOrigin || "remote"})`) : "";

      lines.push(
        `${prefix}${icon} ${fg("accent", nameDisplay)}${remote}  ${fg("dim", `${msgCount} msg · ${ago}`)} ${emoji}`,
      );

      if (this.expanded.has(b.id)) {
        const childLast = ancestorLast.concat([false]);
        // Description
        if (b.description) {
          const descPrefix = computePrefix({ ...node, depth: node.depth + 1 }, childLast);
          lines.push(`${descPrefix.replace("├── ", "    ")}${fg("dim", truncate(b.description, width - prefix.length - 5))}`);
        }
        // Meta
        const meta: string[] = [];
        if (b.tags?.length) meta.push(fg("warning", b.tags.join(", ")));
        if (b.remoteOrigin) meta.push(fg("dim", `synced from ${b.remoteOrigin}`));
        if (meta.length > 0) {
          const metaPrefix = computePrefix({ ...node, depth: node.depth + 1 }, childLast);
          lines.push(`${metaPrefix.replace("├── ", "    ")}${meta.join(" · ")}`);
        }
        // Children
        for (let i = 0; i < node.children.length; i++) {
          const childAncestors = ancestorLast.concat([i === node.children.length - 1]);
          renderNode(node.children[i], childAncestors, lines);
        }
      }
    };

    const nodes = buildTree(this.tree);
    for (let i = 0; i < nodes.length; i++) {
      const ancestorLast = [i === nodes.length - 1];
      renderNode(nodes[i], ancestorLast, renderedLines);
    }

    // Now add selection cursor markers
    let branchIdx = 0;
    for (let i = 0; i < renderedLines.length; i++) {
      const line = renderedLines[i];
      // Check if this rendered line corresponds to a branch (has tree prefix chars)
      const isBranchLine = line.includes("── ") && (line.includes("● ") || line.includes("○ ") || line.includes("◉ "));
      
      if (isBranchLine) {
        if (branchIdx === this.selectedIndex) {
          // Highlight selected line
          const lineWithoutIcon = line.replace(/^(\s*[│├└─\s]*[├└]── )([●○◉])/, (_, prefix, icon) => {
            return prefix + icon;
          });
          out.push(fg("inverse", lineWithoutIcon.padEnd(width)));
        } else {
          out.push(line);
        }
        branchIdx++;
      } else {
        out.push(line);
      }
    }

    if (renderedLines.length === 0) {
      out.push(fg("dim", "  (no branches yet — create one with /branch create <name>)"));
    }

    out.push("");
    out.push(fg("dim", "─".repeat(Math.min(width, 80))));
    out.push(
      fg("muted", "j/k:nav  Enter:expand  s:switch  m:merge  c:create  a:archive  r:rename  q:close"),
    );

    return out;
  }

  // ── Input Handling ────────────────────────────────────────

  handleInput(data: string): void {
    if (!this._resolve) return;

    switch (data) {
      case "j":
      case "\x1b[B": { // down arrow
        this.selectedIndex = Math.min(this.selectedIndex + 1, this.branchIndexes.length - 1);
        this.invalidate();
        break;
      }
      case "k":
      case "\x1b[A": { // up arrow
        this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
        this.invalidate();
        break;
      }
      case "\r":
      case "\n": { // Enter: expand/collapse
        const selectedBranch = this.getSelectedBranch();
        if (selectedBranch) {
          if (this.expanded.has(selectedBranch.id)) {
            this.expanded.delete(selectedBranch.id);
          } else {
            this.expanded.add(selectedBranch.id);
          }
          this.rebuild();
          this.invalidate();
        }
        break;
      }
      case "s": { // switch
        const b = this.getSelectedBranch();
        if (b && !this.isCurrent(b)) {
          this._resolve({ action: "switch", branch: b });
        }
        break;
      }
      case "m": { // merge
        const b = this.getSelectedBranch();
        if (b && !this.isCurrent(b)) {
          this._resolve({ action: "merge", branch: b });
        }
        break;
      }
      case "c": { // create
        this._resolve({ action: "create" });
        break;
      }
      case "a": { // archive
        const b = this.getSelectedBranch();
        if (b && !this.isCurrent(b)) {
          this._resolve({ action: "archive", branch: b });
        }
        break;
      }
      case "r": { // rename
        const b = this.getSelectedBranch();
        if (b) {
          this._resolve({ action: "rename", branch: b });
        }
        break;
      }
      case "q":
      case "\x1b": { // Escape
        this._resolve({ action: "close" });
        break;
      }
    }
  }

  private getSelectedBranch(): Branch | undefined {
    if (this.selectedIndex < 0 || this.selectedIndex >= this.branchIndexes.length) {
      return undefined;
    }
    const displayIdx = this.branchIndexes[this.selectedIndex];
    if (displayIdx < 0 || displayIdx >= this.displayLines.length) return undefined;
    const line = this.displayLines[displayIdx];
    return line.type === "branch" ? line.branch : undefined;
  }
}
