/**
 * Deterministic layered layout for a semantic Grove graph.
 *
 * Lineage determines rank. Context and supersedes edges are rendered later but
 * never distort the primary timeline. The algorithm is intentionally small and
 * defensive: malformed cycles and orphan references still receive positions.
 */

import type { EdgeKind } from "../backend/types";
import type { GraphViewModel } from "./graph-view-model";

export interface WorldPoint {
  x: number;
  y: number;
}

export interface WorldRect extends WorldPoint {
  width: number;
  height: number;
}

export interface LayoutNode extends WorldRect {
  nodeId: string;
  rank: number;
  order: number;
}

export interface LayoutEdge {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: EdgeKind;
}

export interface GraphLayout {
  nodes: Map<string, LayoutNode>;
  orderedNodes: LayoutNode[];
  edges: LayoutEdge[];
  bounds: WorldRect;
}

export interface GraphLayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  rankGap?: number;
  rowGap?: number;
}

const DEFAULTS: Required<GraphLayoutOptions> = {
  nodeWidth: 22,
  nodeHeight: 5,
  rankGap: 10,
  rowGap: 3,
};

function stableNodeOrder(
  leftId: string,
  rightId: string,
  model: GraphViewModel,
): number {
  const left = model.byId.get(leftId)?.node;
  const right = model.byId.get(rightId)?.node;
  if (!left || !right) return leftId.localeCompare(rightId);
  const time = left.createdAt.localeCompare(right.createdAt);
  return time || left.nodeId.localeCompare(right.nodeId);
}

function computeRanks(model: GraphViewModel): Map<string, number> {
  const rank = new Map<string, number>();
  const state = new Map<string, "visiting" | "done">();

  const visit = (nodeId: string): number => {
    const cached = rank.get(nodeId);
    if (state.get(nodeId) === "done" && cached !== undefined) return cached;
    if (state.get(nodeId) === "visiting") {
      // Break malformed lineage cycles deterministically at the encountered node.
      rank.set(nodeId, 0);
      return 0;
    }
    state.set(nodeId, "visiting");
    const parents = (model.byId.get(nodeId)?.lineageParents ?? [])
      .filter((parentId) => model.byId.has(parentId))
      .sort((left, right) => stableNodeOrder(left, right, model));
    let value = 0;
    for (const parentId of parents) {
      value = Math.max(value, visit(parentId) + 1);
    }
    rank.set(nodeId, value);
    state.set(nodeId, "done");
    return value;
  };

  for (const view of [...model.nodes].sort((left, right) =>
    stableNodeOrder(left.node.nodeId, right.node.nodeId, model),
  )) {
    visit(view.node.nodeId);
  }
  return rank;
}

/**
 * Alternate parent/child barycentric sweeps reduce obvious crossings while
 * preserving deterministic tie-breaking.
 */
function orderRanks(
  model: GraphViewModel,
  ranks: Map<string, number>,
): Map<number, string[]> {
  const buckets = new Map<number, string[]>();
  for (const view of model.nodes) {
    const value = ranks.get(view.node.nodeId) ?? 0;
    const bucket = buckets.get(value) ?? [];
    bucket.push(view.node.nodeId);
    buckets.set(value, bucket);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((left, right) => stableNodeOrder(left, right, model));
  }

  const maxRank = Math.max(0, ...buckets.keys());
  const indexMap = () => {
    const result = new Map<string, number>();
    for (const bucket of buckets.values()) {
      bucket.forEach((nodeId, index) => result.set(nodeId, index));
    }
    return result;
  };
  const reorder = (rankValue: number, neighbor: "parents" | "children") => {
    const bucket = buckets.get(rankValue);
    if (!bucket) return;
    const indices = indexMap();
    bucket.sort((left, right) => {
      const relation = (nodeId: string) => {
        const view = model.byId.get(nodeId);
        const ids = neighbor === "parents"
          ? view?.lineageParents ?? []
          : view?.lineageChildren ?? [];
        const positions = ids
          .map((id) => indices.get(id))
          .filter((value): value is number => value !== undefined);
        return positions.length
          ? positions.reduce((sum, value) => sum + value, 0) / positions.length
          : Number.POSITIVE_INFINITY;
      };
      const delta = relation(left) - relation(right);
      return Number.isFinite(delta) && delta !== 0
        ? delta
        : stableNodeOrder(left, right, model);
    });
  };

  for (let sweep = 0; sweep < 2; sweep++) {
    for (let value = 1; value <= maxRank; value++) reorder(value, "parents");
    for (let value = maxRank - 1; value >= 0; value--) reorder(value, "children");
  }
  return buckets;
}

export function layoutGraph(
  model: GraphViewModel,
  options: GraphLayoutOptions = {},
): GraphLayout {
  const config = { ...DEFAULTS, ...options };
  const ranks = computeRanks(model);
  const buckets = orderRanks(model, ranks);
  const nodes = new Map<string, LayoutNode>();
  const maxRows = Math.max(1, ...[...buckets.values()].map((bucket) => bucket.length));
  const rowPitch = config.nodeHeight + config.rowGap;

  for (const [rank, bucket] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const rankHeight = bucket.length * rowPitch - config.rowGap;
    const graphHeight = maxRows * rowPitch - config.rowGap;
    const offset = Math.max(0, (graphHeight - rankHeight) / 2);
    bucket.forEach((nodeId, order) => {
      nodes.set(nodeId, {
        nodeId,
        rank,
        order,
        x: rank * (config.nodeWidth + config.rankGap),
        y: offset + order * rowPitch,
        width: config.nodeWidth,
        height: config.nodeHeight,
      });
    });
  }

  const orderedNodes = [...nodes.values()].sort(
    (left, right) =>
      left.rank - right.rank ||
      left.order - right.order ||
      left.nodeId.localeCompare(right.nodeId),
  );
  const maxX = Math.max(0, ...orderedNodes.map((node) => node.x + node.width));
  const maxY = Math.max(0, ...orderedNodes.map((node) => node.y + node.height));
  const edges = model.activeEdges
    .filter((edge) => nodes.has(edge.fromNodeId) && nodes.has(edge.toNodeId))
    .map((edge) => ({
      edgeId: edge.edgeId,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      kind: edge.kind,
    }))
    .sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.fromNodeId.localeCompare(right.fromNodeId) ||
        left.toNodeId.localeCompare(right.toNodeId) ||
        left.edgeId.localeCompare(right.edgeId),
    );

  return {
    nodes,
    orderedNodes,
    edges,
    bounds: { x: 0, y: 0, width: maxX, height: maxY },
  };
}

export function rectCenter(rect: WorldRect): WorldPoint {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

export type SpatialDirection = "left" | "right" | "up" | "down";

export function findDirectionalNode(
  layout: GraphLayout,
  fromNodeId: string,
  direction: SpatialDirection,
  candidateIds?: Iterable<string>,
): string | null {
  const from = layout.nodes.get(fromNodeId);
  if (!from) return null;
  const origin = rectCenter(from);
  const allowed = candidateIds ? new Set(candidateIds) : null;
  let best: { nodeId: string; score: number } | null = null;

  for (const candidate of layout.orderedNodes) {
    if (candidate.nodeId === fromNodeId || (allowed && !allowed.has(candidate.nodeId))) continue;
    const point = rectCenter(candidate);
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const primary =
      direction === "left" ? -dx :
      direction === "right" ? dx :
      direction === "up" ? -dy :
      dy;
    if (primary <= 0) continue;
    const perpendicular = direction === "left" || direction === "right"
      ? Math.abs(dy)
      : Math.abs(dx);
    // Favor the requested direction strongly while still choosing the closest
    // visual neighbor when several nodes occupy the same rank.
    const anglePenalty = perpendicular / Math.max(1, primary);
    const distance = Math.hypot(dx, dy);
    const score = distance + anglePenalty * 24;
    if (
      !best ||
      score < best.score ||
      (score === best.score && candidate.nodeId.localeCompare(best.nodeId) < 0)
    ) {
      best = { nodeId: candidate.nodeId, score };
    }
  }
  return best?.nodeId ?? null;
}
