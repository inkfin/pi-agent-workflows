/**
 * Pure, deterministic projection of Grove's domain graph into UI-friendly data.
 *
 * This module deliberately contains no TUI or backend calls so layout, colors,
 * action gating, and filtering remain cheap and straightforward to test.
 */

import {
  isEffectivelySealed,
  type GroveGraph,
  type MaterializedAttachment,
  type MaterializedEdge,
  type SessionNode,
} from "../backend/types";

export const NODE_COLOR_SLOTS = [
  "accent",
  "mdLink",
  "customMessageLabel",
  "syntaxFunction",
  "syntaxType",
  "syntaxString",
  "syntaxNumber",
  "syntaxKeyword",
] as const;

export type NodeColorSlot = (typeof NODE_COLOR_SLOTS)[number];

export type NodeAction =
  | "goto"
  | "realign"
  | "fork"
  | "merge"
  | "pick"
  | "pin"
  | "auto-keep"
  | "auto-replace"
  | "auto-split";

export interface ActionEligibility {
  enabled: boolean;
  reason?: string;
}

export interface GraphNodeView {
  node: SessionNode;
  colorSlot: NodeColorSlot;
  glyph: "@" | "■" | "◆" | "○";
  isCurrent: boolean;
  isCurrentSession: boolean;
  isSealed: boolean;
  attachments: MaterializedAttachment[];
  incoming: MaterializedEdge[];
  outgoing: MaterializedEdge[];
  lineageParents: string[];
  lineageChildren: string[];
  actions: Record<NodeAction, ActionEligibility>;
}

export interface GraphViewModel {
  revision: string;
  nodes: GraphNodeView[];
  byId: Map<string, GraphNodeView>;
  activeEdges: MaterializedEdge[];
  roots: string[];
  currentNodeId: string | null;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Stable greedy graph coloring. A node starts at a slot derived from nodeId,
 * then walks the palette until it differs from every already-colored neighbor.
 * This guarantees adjacent colors when the local degree fits the palette and
 * remains deterministic for larger graphs.
 */
export function assignNodeColorSlots(
  nodes: SessionNode[],
  edges: MaterializedEdge[],
): Map<string, NodeColorSlot> {
  const neighbors = new Map<string, Set<string>>();
  for (const node of nodes) neighbors.set(node.nodeId, new Set());
  for (const edge of edges) {
    if (edge.state !== "active") continue;
    neighbors.get(edge.fromNodeId)?.add(edge.toNodeId);
    neighbors.get(edge.toNodeId)?.add(edge.fromNodeId);
  }

  const result = new Map<string, NodeColorSlot>();
  const ordered = [...nodes].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  for (const node of ordered) {
    const occupied = new Set(
      [...(neighbors.get(node.nodeId) ?? [])]
        .map((neighborId) => result.get(neighborId))
        .filter((slot): slot is NodeColorSlot => Boolean(slot)),
    );
    const start = stableHash(node.nodeId) % NODE_COLOR_SLOTS.length;
    let chosen = NODE_COLOR_SLOTS[start];
    for (let offset = 0; offset < NODE_COLOR_SLOTS.length; offset++) {
      const candidate = NODE_COLOR_SLOTS[(start + offset) % NODE_COLOR_SLOTS.length];
      if (!occupied.has(candidate)) {
        chosen = candidate;
        break;
      }
    }
    result.set(node.nodeId, chosen);
  }
  return result;
}

function actionEligibility(
  node: SessionNode,
  currentNodeId: string | null,
  currentSessionRef: string | null,
): Record<NodeAction, ActionEligibility> {
  const isCurrent = node.nodeId === currentNodeId;
  const sameSession = Boolean(currentSessionRef && node.sessionId === currentSessionRef);
  return {
    goto: { enabled: true },
    realign: { enabled: true },
    fork: sameSession
      ? { enabled: true }
      : { enabled: false, reason: `Goto "${node.label}" before forking from it.` },
    merge: isCurrent
      ? { enabled: false, reason: "Cannot inject the current node into itself." }
      : { enabled: true },
    pick: isCurrent
      ? { enabled: false, reason: "Cannot inject the current node into itself." }
      : { enabled: true },
    pin: node.pinned
      ? { enabled: false, reason: "Node is already pinned." }
      : { enabled: true },
    "auto-keep": { enabled: true },
    "auto-replace": { enabled: true },
    "auto-split": { enabled: true },
  };
}

export function buildGraphViewModel(
  graph: GroveGraph,
  currentNodeId: string | null,
  currentSessionRef: string | null,
): GraphViewModel {
  const activeEdges = graph.edges.filter((edge) => edge.state === "active");
  const colors = assignNodeColorSlots(graph.nodes, activeEdges);
  const attachmentsByNode = new Map<string, MaterializedAttachment[]>();
  const incomingByNode = new Map<string, MaterializedEdge[]>();
  const outgoingByNode = new Map<string, MaterializedEdge[]>();

  for (const attachment of graph.attachments) {
    const items = attachmentsByNode.get(attachment.targetNodeId) ?? [];
    items.push(attachment);
    attachmentsByNode.set(attachment.targetNodeId, items);
  }
  for (const edge of activeEdges) {
    const incoming = incomingByNode.get(edge.toNodeId) ?? [];
    incoming.push(edge);
    incomingByNode.set(edge.toNodeId, incoming);
    const outgoing = outgoingByNode.get(edge.fromNodeId) ?? [];
    outgoing.push(edge);
    outgoingByNode.set(edge.fromNodeId, outgoing);
  }

  const nodes = graph.nodes.map((node): GraphNodeView => {
    const attachments = attachmentsByNode.get(node.nodeId) ?? [];
    const incoming = incomingByNode.get(node.nodeId) ?? [];
    const outgoing = outgoingByNode.get(node.nodeId) ?? [];
    const isCurrent = node.nodeId === currentNodeId;
    return {
      node,
      colorSlot: colors.get(node.nodeId) ?? NODE_COLOR_SLOTS[0],
      glyph: isCurrent
        ? "@"
        : attachments.some((attachment) => attachment.kind === "execution_outcome")
          ? "■"
          : node.capture.source === "manual"
            ? "◆"
            : "○",
      isCurrent,
      isCurrentSession: Boolean(currentSessionRef && node.sessionId === currentSessionRef),
      isSealed: isEffectivelySealed(node, activeEdges),
      attachments,
      incoming,
      outgoing,
      lineageParents: incoming
        .filter((edge) => edge.kind === "lineage")
        .map((edge) => edge.fromNodeId),
      lineageChildren: outgoing
        .filter((edge) => edge.kind === "lineage")
        .map((edge) => edge.toNodeId),
      actions: actionEligibility(node, currentNodeId, currentSessionRef),
    };
  });
  const byId = new Map(nodes.map((node) => [node.node.nodeId, node]));
  const roots = nodes
    .filter((node) => node.lineageParents.every((parentId) => !byId.has(parentId)))
    .sort((left, right) => {
      const time = right.node.updatedAt.localeCompare(left.node.updatedAt);
      return time || left.node.nodeId.localeCompare(right.node.nodeId);
    })
    .map((node) => node.node.nodeId);

  return {
    revision: graph.revision,
    nodes,
    byId,
    activeEdges,
    roots,
    currentNodeId,
  };
}

export function filterGraphNodes(
  model: GraphViewModel,
  query: string,
): GraphNodeView[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return model.nodes;
  return model.nodes.filter((view) => {
    const haystack = [
      view.node.label,
      view.node.nodeId,
      view.node.sessionId,
      view.node.capture.source,
      view.node.state,
      ...view.attachments.map((attachment) => attachment.kind),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalized);
  });
}
