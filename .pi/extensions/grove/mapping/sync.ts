/**
 * Explicit per-origin Tree Repo synchronization.
 */

import type {
  FrontierRecord,
  GraphApplyResult,
  SessionNodeRecord,
  TreeBackend,
} from "../backend/types";
import { machineId, originBookmarkName } from "../lib/identity";
import { syncEnabled, loadProjectSettings, saveProjectSettings } from "../lib/settings";
import { OperationCoordinator } from "./coordinator";

function semanticHeads(
  nodes: Array<{ nodeId: string }>,
  edges: Array<{ fromNodeId: string; toNodeId: string; kind: string; state: string }>,
): string[] {
  const parents = new Set(
    edges
      .filter((edge) => edge.kind === "lineage" && edge.state === "active")
      .map((edge) => edge.fromNodeId),
  );
  return nodes.filter((node) => !parents.has(node.nodeId)).map((node) => node.nodeId);
}

async function publishFrontier(backend: TreeBackend): Promise<GraphApplyResult> {
  const graph = await backend.getGraph();
  const publishedAt = new Date().toISOString();
  const nodeRevisions: SessionNodeRecord[] = graph.nodes
    .filter((node) => !node.publishedAt)
    .map(({ backendRef: _backendRef, ...node }) => ({
      ...node,
      revision: node.revision + 1,
      publishedAt,
      updatedAt: publishedAt,
    }));
  const frontier: FrontierRecord = {
    v: 1,
    recordType: "frontier",
    frontierId: `frontier_${machineId()}_${Date.now().toString(36)}`,
    origin: machineId(),
    nodeIds: semanticHeads(graph.nodes, graph.edges),
    createdAt: publishedAt,
  };
  return backend.applyGraphTransaction({
    records: [...nodeRevisions, frontier],
    expectedGraphRevision: graph.revision,
  });
}

export async function syncPush(backend: TreeBackend, cwd: string): Promise<string> {
  const gate = syncEnabled(cwd);
  if (!gate.ok) throw new Error(gate.reason);

  const coordinator = new OperationCoordinator(backend);
  await coordinator.begin("sync_push", { remote: gate.remote });
  try {
    await backend.ensureRemote("grove", gate.remote);
    const result = await publishFrontier(backend);
    const bookmark = originBookmarkName();
    await backend.setBookmark(bookmark, result.revision.changeId);
    await backend.gitPush({ remote: "grove", bookmark });
    await coordinator.succeed(result.revision.changeId);
    return `pushed ${bookmark} → ${gate.remote}`;
  } catch (error: any) {
    await coordinator.failAndRestore(error?.message ?? String(error));
    throw error;
  }
}

export async function syncPull(backend: TreeBackend, cwd: string): Promise<string> {
  const gate = syncEnabled(cwd);
  if (!gate.ok) throw new Error(gate.reason);

  const coordinator = new OperationCoordinator(backend);
  await coordinator.begin("sync_pull", { remote: gate.remote });
  try {
    await backend.ensureRemote("grove", gate.remote);
    await backend.gitFetch({ remote: "grove" });
    await coordinator.succeed();
    const bookmarks = await backend.listBookmarks();
    const origins = bookmarks.filter((bookmark) => bookmark.name.startsWith("grove/origins/"));
    return `fetched ${gate.remote}; ${origins.length} origin bookmark(s) visible`;
  } catch (error: any) {
    await coordinator.failAndRestore(error?.message ?? String(error));
    throw error;
  }
}

export function configureSync(
  cwd: string,
  opts: { treeRemote: string; confirmPrivate?: boolean; encrypt?: boolean },
): string {
  const current = loadProjectSettings(cwd);
  current.treeRemote = opts.treeRemote;
  if (opts.confirmPrivate) current.privateRemoteConfirmed = true;
  if (opts.encrypt) current.encryptPayload = true;
  saveProjectSettings(cwd, current);
  return `treeRemote=${opts.treeRemote}; private=${!!current.privateRemoteConfirmed}; encrypt=${!!current.encryptPayload}`;
}
