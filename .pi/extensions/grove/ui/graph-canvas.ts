/**
 * ANSI-aware character-cell renderer for the Grove graph.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GraphCamera, ViewportSize } from "./graph-camera";
import type { GraphLayout, LayoutNode, WorldPoint } from "./graph-layout";
import { rectCenter } from "./graph-layout";
import type {
  GraphNodeView,
  GraphViewModel,
} from "./graph-view-model";

interface CellStyle {
  color?: string;
  background?: "selectedBg";
  bold?: boolean;
  dim?: boolean;
}

interface Cell {
  char: string;
  continuation?: boolean;
  style?: CellStyle;
}

export interface ScreenNodeRect {
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GraphCanvasResult {
  lines: string[];
  visibleNodeIds: string[];
  nodeRects: Map<string, ScreenNodeRect>;
}

export interface GraphCanvasOptions {
  selectedNodeId: string | null;
  highlightedNodeIds?: Set<string>;
}

type GroveTheme = Pick<Theme, "fg" | "bg" | "bold">;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function styleKey(style: CellStyle | undefined): string {
  if (!style) return "";
  return [
    style.color ?? "",
    style.background ?? "",
    style.bold ? "b" : "",
    style.dim ? "d" : "",
  ].join("|");
}

function sameStyle(left: CellStyle | undefined, right: CellStyle | undefined): boolean {
  return styleKey(left) === styleKey(right);
}

function applyStyle(text: string, style: CellStyle | undefined, theme: GroveTheme): string {
  if (!style || !text) return text;
  let output = text;
  if (style.color) output = theme.fg(style.color as any, output);
  if (style.bold) output = theme.bold(output);
  if (style.dim) output = `\x1b[2m${output}\x1b[22m`;
  if (style.background) output = theme.bg(style.background, output);
  return output;
}

class CellBuffer {
  private readonly cells: Cell[][];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cells = Array.from({ length: height }, () =>
      Array.from({ length: width }, () => ({ char: " " })),
    );
  }

  set(x: number, y: number, char: string, style?: CellStyle): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.cells[y][x] = { char, style };
  }

  get(x: number, y: number): Cell | undefined {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined;
    return this.cells[y][x];
  }

  text(x: number, y: number, value: string, style?: CellStyle): void {
    let column = x;
    for (const part of GRAPHEME_SEGMENTER.segment(value)) {
      const grapheme = part.segment;
      const charWidth = Math.max(0, visibleWidth(grapheme));
      if (charWidth === 0) continue;
      if (column >= this.width) break;
      // Character cells cannot safely show half of a wide grapheme. Strictly
      // clip clusters that straddle either viewport edge.
      if (column >= 0 && column + charWidth <= this.width) {
        this.set(column, y, grapheme, style);
        for (let offset = 1; offset < charWidth && column + offset < this.width; offset++) {
          this.cells[y][column + offset] = { char: "", continuation: true, style };
        }
      }
      column += charWidth;
    }
  }

  horizontal(
    x1: number,
    x2: number,
    y: number,
    char: string,
    style?: CellStyle,
    merge = true,
  ): void {
    const start = Math.min(x1, x2);
    const end = Math.max(x1, x2);
    for (let x = start; x <= end; x++) {
      const current = this.get(x, y);
      this.set(x, y, merge && current && current.char !== " " ? "┼" : char, style);
    }
  }

  vertical(
    x: number,
    y1: number,
    y2: number,
    char: string,
    style?: CellStyle,
    merge = true,
  ): void {
    const start = Math.min(y1, y2);
    const end = Math.max(y1, y2);
    for (let y = start; y <= end; y++) {
      const current = this.get(x, y);
      this.set(x, y, merge && current && current.char !== " " ? "┼" : char, style);
    }
  }

  fill(rect: ScreenNodeRect, style: CellStyle): void {
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const current = this.get(x, y);
        this.set(x, y, current?.char ?? " ", { ...current?.style, ...style });
      }
    }
  }

  render(theme: GroveTheme): string[] {
    return this.cells.map((row) => {
      let output = "";
      let index = 0;
      while (index < row.length) {
        const cell = row[index];
        if (cell.continuation) {
          index++;
          continue;
        }
        let text = cell.char;
        let cursor = index + 1;
        while (
          cursor < row.length &&
          !row[cursor].continuation &&
          sameStyle(cell.style, row[cursor].style)
        ) {
          text += row[cursor].char;
          cursor++;
        }
        output += applyStyle(text, cell.style, theme);
        index = cursor;
      }
      return output;
    });
  }
}

function screenRect(
  node: LayoutNode,
  camera: GraphCamera,
  viewport: ViewportSize,
): ScreenNodeRect {
  const center = camera.worldToScreen(rectCenter(node), viewport);
  const zoom = camera.state.zoom;
  const overview = zoom < 0.72;
  const detail = zoom >= 1.35;
  const width = overview
    ? Math.max(7, Math.round(node.width * zoom))
    : Math.max(12, Math.round(node.width * zoom));
  const height = overview ? 1 : detail ? 5 : 3;
  return {
    nodeId: node.nodeId,
    x: Math.round(center.x - width / 2),
    y: Math.round(center.y - height / 2),
    width,
    height,
  };
}

function intersects(rect: ScreenNodeRect, viewport: ViewportSize): boolean {
  return (
    rect.x < viewport.width &&
    rect.y < viewport.height &&
    rect.x + rect.width > 0 &&
    rect.y + rect.height > 0
  );
}

function edgeStyle(
  kind: "lineage" | "context" | "supersedes",
  highlighted: boolean,
): { horizontal: string; vertical: string; color: string; dim: boolean } {
  if (kind === "context") {
    return { horizontal: "┄", vertical: "┆", color: "mdLink", dim: !highlighted };
  }
  if (kind === "supersedes") {
    return { horizontal: "═", vertical: "║", color: "warning", dim: !highlighted };
  }
  return {
    horizontal: "─",
    vertical: "│",
    color: highlighted ? "accent" : "borderMuted",
    dim: !highlighted,
  };
}

function drawEdge(
  buffer: CellBuffer,
  from: ScreenNodeRect,
  to: ScreenNodeRect,
  kind: "lineage" | "context" | "supersedes",
  highlighted: boolean,
): void {
  const styleInfo = edgeStyle(kind, highlighted);
  const style: CellStyle = {
    color: styleInfo.color,
    bold: highlighted,
    dim: styleInfo.dim,
  };
  const forward = to.x >= from.x + from.width;
  const startX = forward ? from.x + from.width : from.x - 1;
  const endX = forward ? to.x - 1 : to.x + to.width;
  const startY = from.y + Math.floor(from.height / 2);
  const endY = to.y + Math.floor(to.height / 2);
  const bendX = forward
    ? Math.round((startX + endX) / 2)
    : Math.min(startX, endX) - 2;

  buffer.horizontal(startX, bendX, startY, styleInfo.horizontal, style);
  buffer.vertical(bendX, startY, endY, styleInfo.vertical, style);
  buffer.horizontal(bendX, endX, endY, styleInfo.horizontal, style);
  buffer.set(
    endX,
    endY,
    forward ? "▶" : "◀",
    { ...style, bold: true },
  );
}

function timeAgo(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function drawNode(
  buffer: CellBuffer,
  rect: ScreenNodeRect,
  view: GraphNodeView,
  selected: boolean,
  zoom: number,
  muted: boolean,
): void {
  const nodeStyle: CellStyle = {
    color: view.colorSlot,
    bold: selected || view.isCurrent,
    dim: muted,
  };
  if (selected) buffer.fill(rect, { background: "selectedBg" });

  if (rect.height === 1) {
    const labelWidth = Math.max(1, rect.width - 2);
    const label = truncateToWidth(view.node.label, labelWidth, "…", true);
    buffer.text(rect.x, rect.y, view.glyph, nodeStyle);
    buffer.text(rect.x + 2, rect.y, label, nodeStyle);
    return;
  }

  const current = view.isCurrent;
  const horizontal = current ? "═" : "─";
  const vertical = current ? "║" : "│";
  const corners = current ? ["╔", "╗", "╚", "╝"] : ["╭", "╮", "╰", "╯"];
  buffer.set(rect.x, rect.y, corners[0], nodeStyle);
  buffer.horizontal(rect.x + 1, rect.x + rect.width - 2, rect.y, horizontal, nodeStyle, false);
  buffer.set(rect.x + rect.width - 1, rect.y, corners[1], nodeStyle);
  buffer.set(rect.x, rect.y + rect.height - 1, corners[2], nodeStyle);
  buffer.horizontal(
    rect.x + 1,
    rect.x + rect.width - 2,
    rect.y + rect.height - 1,
    horizontal,
    nodeStyle,
    false,
  );
  buffer.set(rect.x + rect.width - 1, rect.y + rect.height - 1, corners[3], nodeStyle);
  for (let y = rect.y + 1; y < rect.y + rect.height - 1; y++) {
    buffer.set(rect.x, y, vertical, nodeStyle);
    buffer.set(rect.x + rect.width - 1, y, vertical, nodeStyle);
  }

  const innerWidth = Math.max(1, rect.width - 6);
  const title = truncateToWidth(view.node.label, innerWidth, "…", true);
  buffer.text(rect.x + 2, rect.y + 1, `${view.glyph} ${title}`, {
    ...nodeStyle,
    bold: true,
  });
  if (rect.height >= 5 && zoom >= 1.35) {
    const state = `${view.isSealed ? "sealed" : "draft"} · ${timeAgo(view.node.updatedAt)}`;
    buffer.text(
      rect.x + 2,
      rect.y + 2,
      truncateToWidth(state, rect.width - 4, "…", true),
      { color: "dim" },
    );
    const artifacts = view.attachments.length
      ? `${view.attachments.length} artifact${view.attachments.length === 1 ? "" : "s"}`
      : view.node.capture.source;
    buffer.text(
      rect.x + 2,
      rect.y + 3,
      truncateToWidth(artifacts, rect.width - 4, "…", true),
      { color: view.attachments.length ? "success" : "muted" },
    );
  }
}

export function renderGraphCanvas(
  model: GraphViewModel,
  layout: GraphLayout,
  camera: GraphCamera,
  viewport: ViewportSize,
  theme: GroveTheme,
  options: GraphCanvasOptions,
): GraphCanvasResult {
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  const size = { width, height };
  const buffer = new CellBuffer(width, height);
  const nodeRects = new Map<string, ScreenNodeRect>();

  for (const node of layout.orderedNodes) {
    nodeRects.set(node.nodeId, screenRect(node, camera, size));
  }

  for (const edge of layout.edges) {
    const from = nodeRects.get(edge.fromNodeId);
    const to = nodeRects.get(edge.toNodeId);
    if (!from || !to) continue;
    const highlighted =
      edge.fromNodeId === options.selectedNodeId ||
      edge.toNodeId === options.selectedNodeId;
    drawEdge(buffer, from, to, edge.kind, highlighted);
  }

  const visibleNodeIds: string[] = [];
  for (const node of layout.orderedNodes) {
    const rect = nodeRects.get(node.nodeId)!;
    if (!intersects(rect, size)) continue;
    const view = model.byId.get(node.nodeId);
    if (!view) continue;
    visibleNodeIds.push(node.nodeId);
    drawNode(
      buffer,
      rect,
      view,
      node.nodeId === options.selectedNodeId,
      camera.state.zoom,
      Boolean(options.highlightedNodeIds && !options.highlightedNodeIds.has(node.nodeId)),
    );
  }

  return {
    lines: buffer.render(theme),
    visibleNodeIds,
    nodeRects,
  };
}

export function nodeWorldCenter(
  layout: GraphLayout,
  nodeId: string,
): WorldPoint | null {
  const node = layout.nodes.get(nodeId);
  return node ? rectCenter(node) : null;
}
