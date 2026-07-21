/**
 * Focused, near-fullscreen Grove graph workspace.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import type { GroveGraph, SessionNode } from "../backend/types";
import { GraphCamera, type CameraState } from "./graph-camera";
import { nodeWorldCenter, renderGraphCanvas } from "./graph-canvas";
import {
  findDirectionalNode,
  layoutGraph,
  type GraphLayout,
  type SpatialDirection,
} from "./graph-layout";
import {
  buildGraphViewModel,
  filterGraphNodes,
  type GraphNodeView,
  type GraphViewModel,
  type NodeAction,
} from "./graph-view-model";
import { printableKey } from "./printable-key";
import { ThreadWindow } from "./thread-window";
import type { NodeThread } from "./thread-loader";
import type { GroveAction, GroveViewResult } from "./tree-view";

type GroveTheme = Pick<
  Theme,
  "fg" | "bg" | "bold" | "italic" | "underline" | "strikethrough"
>;

export interface GraphWorkspaceOptions {
  graph: GroveGraph;
  currentNodeId: string | null;
  currentSessionRef: string | null;
  initialSelectedNodeId?: string | null;
  initialCamera?: Partial<CameraState>;
  tui: TUI;
  theme: GroveTheme;
  loadThread: (node: SessionNode) => Promise<NodeThread>;
  done: (result: GroveViewResult | null) => void;
}

export interface GraphWorkspaceSnapshot {
  selectedNodeId: string | null;
  camera: CameraState;
}

function padVisible(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function borderLine(
  theme: GroveTheme,
  left: string,
  label: string,
  right: string,
  width: number,
  color = "borderAccent",
): string {
  const innerWidth = Math.max(0, width - 2);
  const title = truncateToWidth(label, innerWidth, "…");
  return (
    theme.fg(color as any, left + title) +
    theme.fg("borderMuted", "─".repeat(Math.max(0, innerWidth - visibleWidth(title)))) +
    theme.fg(color as any, right)
  );
}

function overlayLine(base: string, column: number, value: string, width: number): string {
  const safeColumn = Math.max(0, Math.min(column, width));
  const valueWidth = Math.min(visibleWidth(value), Math.max(0, width - safeColumn));
  const left = sliceByColumn(base, 0, safeColumn);
  const right = sliceByColumn(
    base,
    safeColumn + valueWidth,
    Math.max(0, width - safeColumn - valueWidth),
  );
  return padVisible(left + truncateToWidth(value, valueWidth, "") + right, width);
}

function actionForKey(data: string): GroveAction | null {
  switch (data) {
    case "g":
      return "goto";
    case "c":
      return "commit";
    case "f":
      return "fork";
    case "m":
      return "merge";
    case "p":
      return "pick";
    case "n":
      return "pin";
    case "u":
      return "undo";
    case "k":
      return "auto-keep";
    case "r":
      return "auto-replace";
    case "R":
      return "realign";
    case "s":
      return "auto-split";
    case "y":
      return "sync-push";
    case "Y":
      return "sync-pull";
    case "d":
      return "dashboard";
    default:
      return null;
  }
}

const NODE_ACTIONS = new Set<NodeAction>([
  "goto",
  "realign",
  "fork",
  "merge",
  "pick",
  "pin",
  "auto-keep",
  "auto-replace",
  "auto-split",
]);

export class GraphWorkspace implements Component, Focusable {
  private _focused = false;
  private readonly model: GraphViewModel;
  private readonly layout: GraphLayout;
  private readonly camera: GraphCamera;
  private selectedNodeId: string | null;
  private filterQuery = "";
  private searchMode = false;
  private actionMode = false;
  private helpVisible = false;
  private statusHint = "";
  private readonly searchInput = new Input();
  private animationTimer: ReturnType<typeof setInterval> | null = null;
  private overlayHandle: OverlayHandle | null = null;
  private threadWindow: ThreadWindow | null = null;
  private readonly threadCache = new Map<string, NodeThread>();
  private threadGeneration = 0;
  private disposed = false;

  constructor(private readonly options: GraphWorkspaceOptions) {
    this.model = buildGraphViewModel(
      options.graph,
      options.currentNodeId,
      options.currentSessionRef,
    );
    this.layout = layoutGraph(this.model);
    this.selectedNodeId =
      (options.initialSelectedNodeId && this.model.byId.has(options.initialSelectedNodeId)
        ? options.initialSelectedNodeId
        : options.currentNodeId && this.model.byId.has(options.currentNodeId)
        ? options.currentNodeId
        : this.layout.orderedNodes[0]?.nodeId) ?? null;
    const center = this.selectedNodeId
      ? nodeWorldCenter(this.layout, this.selectedNodeId)
      : null;
    this.camera = new GraphCamera({
      centerX: options.initialCamera?.centerX ?? center?.x ?? this.layout.bounds.width / 2,
      centerY: options.initialCamera?.centerY ?? center?.y ?? this.layout.bounds.height / 2,
      zoom: options.initialCamera?.zoom,
    });
    this.searchInput.onSubmit = (value) => {
      this.filterQuery = value.trim();
      this.searchMode = false;
      const first = this.filteredNodes()[0];
      if (first) this.selectNode(first.node.nodeId, true);
      this.requestRender();
    };
    this.searchInput.onEscape = () => {
      this.searchMode = false;
      this.requestRender();
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value && this.searchMode;
  }

  get selectedId(): string | null {
    return this.selectedNodeId;
  }

  get cameraState() {
    return this.camera.state;
  }

  getSnapshot(): GraphWorkspaceSnapshot {
    return {
      selectedNodeId: this.selectedNodeId,
      camera: { ...this.camera.state },
    };
  }

  private requestRender(): void {
    if (!this.disposed) this.options.tui.requestRender();
  }

  private filteredNodes(): GraphNodeView[] {
    return filterGraphNodes(this.model, this.filterQuery);
  }

  private ensureAnimation(): void {
    if (this.animationTimer || !this.camera.animating || this.disposed) return;
    this.animationTimer = setInterval(() => {
      const stillAnimating = this.camera.step();
      this.requestRender();
      if (!stillAnimating && this.animationTimer) {
        clearInterval(this.animationTimer);
        this.animationTimer = null;
      }
    }, 16);
  }

  private selectNode(nodeId: string, followCamera: boolean): void {
    if (!this.model.byId.has(nodeId)) return;
    this.selectedNodeId = nodeId;
    this.statusHint = "";
    if (followCamera) {
      const center = nodeWorldCenter(this.layout, nodeId);
      if (center) {
        this.camera.centerOn(center);
        this.ensureAnimation();
      }
    }
    this.requestRender();
  }

  private moveSelection(direction: SpatialDirection): void {
    if (!this.selectedNodeId) return;
    const allowed = this.filteredNodes().map((view) => view.node.nodeId);
    const next = findDirectionalNode(this.layout, this.selectedNodeId, direction, allowed);
    if (next) this.selectNode(next, true);
  }

  private cycleSelection(delta: -1 | 1): void {
    const nodes = this.layout.orderedNodes.filter((node) =>
      this.filteredNodes().some((view) => view.node.nodeId === node.nodeId),
    );
    if (!nodes.length) return;
    const index = Math.max(0, nodes.findIndex((node) => node.nodeId === this.selectedNodeId));
    const next = (index + delta + nodes.length) % nodes.length;
    this.selectNode(nodes[next].nodeId, true);
  }

  private selectedView(): GraphNodeView | undefined {
    return this.selectedNodeId ? this.model.byId.get(this.selectedNodeId) : undefined;
  }

  private zoom(delta: number): void {
    const center = this.selectedNodeId
      ? nodeWorldCenter(this.layout, this.selectedNodeId)
      : null;
    this.camera.zoomBy(delta, center ?? {
      x: this.camera.targetState.centerX,
      y: this.camera.targetState.centerY,
    });
    this.ensureAnimation();
  }

  private emit(action: GroveAction): void {
    const selected = this.selectedView();
    if (NODE_ACTIONS.has(action as NodeAction)) {
      if (!selected) {
        this.statusHint = "No node selected.";
        this.requestRender();
        return;
      }
      const gate = selected.actions[action as NodeAction];
      if (gate && !gate.enabled) {
        this.statusHint = gate.reason ?? "Action is unavailable.";
        this.actionMode = false;
        this.requestRender();
        return;
      }
    }
    this.dispose();
    this.options.done({
      action,
      node: NODE_ACTIONS.has(action as NodeAction) ? selected?.node : undefined,
    });
  }

  private closeThread(): void {
    this.threadGeneration++;
    this.overlayHandle?.hide();
    this.overlayHandle = null;
    this.threadWindow = null;
    this.options.tui.setFocus(this);
    this.requestRender();
  }

  private threadOverlayHeight(maximized: boolean): number {
    const rows = Math.max(12, this.options.tui.terminal.rows);
    return maximized ? Math.max(10, rows - 1) : Math.max(10, Math.floor(rows * 0.75));
  }

  private openThread(maximized = false, scrollOffset = 0): void {
    const selected = this.selectedView();
    if (!selected) return;
    this.overlayHandle?.hide();
    this.overlayHandle = null;
    const generation = ++this.threadGeneration;
    const window = new ThreadWindow(
      selected.node,
      selected.colorSlot,
      this.options.theme,
      maximized,
      this.threadOverlayHeight(maximized),
      {
        close: () => this.closeThread(),
        toggleMaximize: (state) => this.openThread(!state.maximized, state.scrollOffset),
        switchNode: (direction) => {
          this.cycleSelection(direction);
          this.openThread(maximized, 0);
        },
        requestRender: () => this.requestRender(),
      },
      scrollOffset,
    );
    this.threadWindow = window;
    this.overlayHandle = this.options.tui.showOverlay(window, {
      anchor: "center",
      width: maximized ? "100%" : "72%",
      minWidth: 34,
      maxHeight: maximized ? "100%" : "75%",
      margin: maximized ? 0 : 1,
    });
    this.overlayHandle.focus();
    const cached = this.threadCache.get(selected.node.nodeId);
    if (cached) {
      window.setThread(cached);
      this.requestRender();
      return;
    }
    void this.options.loadThread(selected.node).then(
      (thread) => {
        if (
          this.disposed ||
          generation !== this.threadGeneration ||
          this.threadWindow !== window
        ) return;
        this.threadCache.set(thread.nodeId, thread);
        window.setThread(thread);
        this.requestRender();
      },
      (error) => {
        if (
          this.disposed ||
          generation !== this.threadGeneration ||
          this.threadWindow !== window
        ) return;
        window.setError(error instanceof Error ? error.message : String(error));
        this.requestRender();
      },
    );
  }

  private handleActionMode(data: string, printable: string): void {
    if (matchesKey(data, Key.escape) || printable === "a") {
      this.actionMode = false;
      this.requestRender();
      return;
    }
    const action = actionForKey(printable);
    if (action) this.emit(action);
  }

  handleInput(data: string): void {
    if (this.searchMode) {
      this.searchInput.handleInput(data);
      this.requestRender();
      return;
    }
    const printable = printableKey(data);
    if (this.actionMode) {
      this.handleActionMode(data, printable);
      return;
    }
    if (matchesKey(data, Key.escape) || printable === "q") {
      this.dispose();
      this.options.done(null);
      return;
    }
    if (printable === "?") {
      this.helpVisible = !this.helpVisible;
      this.requestRender();
      return;
    }
    if (printable === "/") {
      this.searchMode = true;
      this.searchInput.setValue(this.filterQuery);
      this.searchInput.focused = this.focused;
      this.requestRender();
      return;
    }
    if (printable === "a") {
      this.actionMode = true;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
      this.openThread();
      return;
    }
    if (matchesKey(data, Key.left) || printable === "h") this.moveSelection("left");
    else if (matchesKey(data, Key.right) || printable === "l") this.moveSelection("right");
    else if (matchesKey(data, Key.up) || printable === "k") this.moveSelection("up");
    else if (matchesKey(data, Key.down) || printable === "j") this.moveSelection("down");
    else if (matchesKey(data, Key.tab)) this.cycleSelection(1);
    else if (matchesKey(data, Key.shift(Key.tab))) this.cycleSelection(-1);
    else if (printable === "H") {
      this.camera.panBy(-8, 0);
      this.ensureAnimation();
    } else if (printable === "L") {
      this.camera.panBy(8, 0);
      this.ensureAnimation();
    } else if (printable === "K") {
      this.camera.panBy(0, -4);
      this.ensureAnimation();
    } else if (printable === "J") {
      this.camera.panBy(0, 4);
      this.ensureAnimation();
    } else if (printable === "+" || printable === "=") this.zoom(0.15);
    else if (printable === "-") this.zoom(-0.15);
    else if (printable === "0") {
      const center = this.selectedNodeId
        ? nodeWorldCenter(this.layout, this.selectedNodeId)
        : undefined;
      this.camera.reset(center ?? undefined);
      this.ensureAnimation();
    } else if (printable === "z") {
      this.camera.fit(this.layout.bounds, {
        width: Math.max(20, this.options.tui.terminal.columns),
        height: Math.max(8, this.options.tui.terminal.rows - 6),
      });
      this.ensureAnimation();
    }
  }

  private renderHelp(width: number, height: number): string[] {
    const lines = [
      this.options.theme.fg("accent", this.options.theme.bold("Grove navigation")),
      "",
      "←↑↓→ / h j k l   select nearest node",
      "Shift+H/J/K/L       pan camera",
      "Tab / Shift+Tab     cycle nodes",
      "+ / - / 0 / z       zoom, reset, fit graph",
      "/                   search and dim non-matches",
      "Enter               open anchored chat thread",
      "a                   action palette",
      "?                   close help",
      "q / Esc             return to chat",
    ].map((line) => padVisible(`  ${line}`, width));
    while (lines.length < height) lines.push(" ".repeat(width));
    return lines.slice(0, height);
  }

  private renderMiniMap(width: number, height: number): string[] {
    if (width < 100 || height < 8 || !this.layout.orderedNodes.length) return [];
    const mapWidth = 18;
    const mapHeight = 5;
    const grid = Array.from({ length: mapHeight }, () =>
      Array.from({ length: mapWidth }, () => " "),
    );
    const bounds = this.layout.bounds;
    for (const node of this.layout.orderedNodes) {
      const center = nodeWorldCenter(this.layout, node.nodeId)!;
      const x = Math.max(
        0,
        Math.min(mapWidth - 1, Math.round(((center.x - bounds.x) / Math.max(1, bounds.width)) * (mapWidth - 1))),
      );
      const y = Math.max(
        0,
        Math.min(mapHeight - 1, Math.round(((center.y - bounds.y) / Math.max(1, bounds.height)) * (mapHeight - 1))),
      );
      grid[y][x] = node.nodeId === this.selectedNodeId
        ? "●"
        : node.nodeId === this.model.currentNodeId
          ? "@"
          : "·";
    }
    return [
      this.options.theme.fg("borderMuted", "╭─ minimap ─────────╮"),
      ...grid.map(
        (row) =>
          this.options.theme.fg("borderMuted", "│") +
          this.options.theme.fg("dim", row.join("")) +
          this.options.theme.fg("borderMuted", "│"),
      ),
      this.options.theme.fg("borderMuted", "╰──────────────────╯"),
    ];
  }

  private footerText(): string {
    if (this.actionMode) {
      return "ACTIONS  g:goto R:realign c:commit f:fork m:context p:inject n:pin u:undo k/r/s:auto y/Y:sync d:dashboard Esc";
    }
    if (this.searchMode) {
      const rendered = this.searchInput.render(40)[0] ?? "";
      return `SEARCH  ${rendered}`;
    }
    return "arrows/hjkl select · Enter thread · +/- zoom · / search · a actions · ? help · q close";
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const totalHeight = Math.max(12, this.options.tui.terminal.rows - 1);
    if (this.threadWindow) {
      this.threadWindow.setViewportHeight(
        this.threadOverlayHeight(this.threadWindow.getState().maximized),
      );
    }
    const canvasHeight = Math.max(5, totalHeight - 6);
    this.camera.step();
    const selected = this.selectedView();
    const filterCount = this.filteredNodes().length;
    const title =
      ` Grove · ${this.model.nodes.length} nodes · ${this.model.activeEdges.length} edges` +
      ` · ${Math.round(this.camera.state.zoom * 100)}% `;
    const selectedText = selected
      ? `${selected.glyph} ${selected.node.label} · ${selected.isSealed ? "sealed" : "draft"} · ${selected.attachments.length} artifacts`
      : "(empty graph)";
    const filterText = this.filterQuery
      ? ` · filter "${this.filterQuery}" ${filterCount}/${this.model.nodes.length}`
      : "";
    const output = [
      borderLine(this.options.theme, "╭", title, "╮", safeWidth),
      this.options.theme.fg("borderAccent", "│") +
        padVisible(
          " " +
            this.options.theme.fg(
              (selected?.colorSlot ?? "muted") as any,
              this.options.theme.bold(selectedText),
            ) +
            this.options.theme.fg("dim", filterText),
          safeWidth - 2,
        ) +
        this.options.theme.fg("borderAccent", "│"),
      borderLine(this.options.theme, "├", "", "┤", safeWidth, "borderMuted"),
    ];

    let canvasLines = this.helpVisible
      ? this.renderHelp(safeWidth - 2, canvasHeight)
      : renderGraphCanvas(
          this.model,
          this.layout,
          this.camera,
          { width: safeWidth - 2, height: canvasHeight },
          this.options.theme,
          {
            selectedNodeId: this.selectedNodeId,
            highlightedNodeIds: this.filterQuery
              ? new Set(this.filteredNodes().map((view) => view.node.nodeId))
              : undefined,
          },
        ).lines;
    const minimap = this.helpVisible ? [] : this.renderMiniMap(safeWidth - 2, canvasHeight);
    if (minimap.length) {
      const column = safeWidth - 2 - visibleWidth(minimap[0]);
      canvasLines = canvasLines.map((line, index) =>
        index < minimap.length
          ? overlayLine(line, column, minimap[index], safeWidth - 2)
          : line,
      );
    }
    output.push(
      ...canvasLines.map(
        (line) =>
          this.options.theme.fg("borderMuted", "│") +
          padVisible(line, safeWidth - 2) +
          this.options.theme.fg("borderMuted", "│"),
      ),
    );
    output.push(borderLine(this.options.theme, "├", "", "┤", safeWidth, "borderMuted"));
    const footer = this.statusHint
      ? this.options.theme.fg("warning", this.statusHint)
      : this.options.theme.fg(this.actionMode ? "accent" : "dim", this.footerText());
    output.push(
      this.options.theme.fg("borderAccent", "│") +
        padVisible(` ${footer}`, safeWidth - 2) +
        this.options.theme.fg("borderAccent", "│"),
    );
    output.push(borderLine(this.options.theme, "╰", "", "╯", safeWidth));
    return output;
  }

  invalidate(): void {
    this.searchInput.invalidate();
    this.threadWindow?.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.threadGeneration++;
    if (this.animationTimer) clearInterval(this.animationTimer);
    this.animationTimer = null;
    this.overlayHandle?.hide();
    this.overlayHandle = null;
    this.threadWindow = null;
  }
}
