/**
 * grove/mapping/sync.ts — per-origin frontier bookmark push/pull
 */

import type { TreeBackend, GroveNode, NodeManifest } from "../backend/types";
import { machineId, originBookmarkName, projectInfo } from "../lib/identity";
import { syncEnabled, loadProjectSettings, saveProjectSettings } from "../lib/settings";
import { OperationCoordinator } from "./coordinator";

function heads(nodes: GroveNode[]): string[] {
  const kids = new Set<string>();
  for (const n of nodes) for (const p of n.parents) kids.add(p);
  return nodes.filter((n) => n.manifest && !kids.has(n.changeId) && n.manifest.kind !== "root").map((n) => n.changeId);
}

async function ensureFrontier(be: TreeBackend, cwd: string): Promise<GroveNode> {
  const nodes = await be.listNodes();
  const h = heads(nodes);
  const parents = h.length ? h : [await be.currentChangeId()];
  const proj = projectInfo(cwd);
  const manifest: NodeManifest = {
    v: 1,
    kind: "frontier",
    label: `frontier ${machineId()} ${new Date().toISOString()}`,
    projectId: proj.projectId,
    sessionId: "",
    snapshotId: null,
    anchor: { entryId: null },
    lifecycle: "published",
    project: { name: proj.name, vcsRemote: proj.vcsRemote },
    origin: machineId(),
    createdAt: new Date().toISOString(),
  };
  return be.commitNode({ parents, manifest });
}

export async function syncPush(be: TreeBackend, cwd: string): Promise<string> {
  const gate = syncEnabled(cwd);
  if (!gate.ok) throw new Error(gate.reason);

  const coord = new OperationCoordinator(be);
  await coord.begin("sync_push", { remote: gate.remote });
  try {
    await be.ensureRemote("grove", gate.remote);
    const frontier = await ensureFrontier(be, cwd);
    // Mark draft autos as published when pushing
    const nodes = await be.listNodes();
    for (const n of nodes) {
      if (n.manifest?.kind === "auto" && n.manifest.lifecycle === "draft") {
        await be.amendNode({
          changeId: n.changeId,
          manifest: { ...n.manifest, lifecycle: "published" },
        });
      }
    }
    const bookmark = originBookmarkName();
    await be.setBookmark(bookmark, frontier.changeId);
    await be.gitPush({ remote: "grove", bookmark });
    await coord.succeed(frontier.changeId);
    return `pushed ${bookmark} → ${gate.remote}`;
  } catch (err: any) {
    await coord.failAndRestore(err?.message ?? String(err));
    throw err;
  }
}

export async function syncPull(be: TreeBackend, cwd: string): Promise<string> {
  const gate = syncEnabled(cwd);
  if (!gate.ok) throw new Error(gate.reason);

  const coord = new OperationCoordinator(be);
  await coord.begin("sync_pull", { remote: gate.remote });
  try {
    await be.ensureRemote("grove", gate.remote);
    await be.gitFetch({ remote: "grove" });
    await coord.succeed();
    const bookmarks = await be.listBookmarks();
    const origins = bookmarks.filter((b) => b.name.startsWith("grove/origins/"));
    return `fetched ${gate.remote}; ${origins.length} origin bookmark(s) visible`;
  } catch (err: any) {
    await coord.failAndRestore(err?.message ?? String(err));
    throw err;
  }
}

export function configureSync(
  cwd: string,
  opts: { treeRemote: string; confirmPrivate?: boolean; encrypt?: boolean },
): string {
  const cur = loadProjectSettings(cwd);
  cur.treeRemote = opts.treeRemote;
  if (opts.confirmPrivate) cur.privateRemoteConfirmed = true;
  if (opts.encrypt) cur.encryptPayload = true;
  saveProjectSettings(cwd, cur);
  return `treeRemote=${opts.treeRemote}; private=${!!cur.privateRemoteConfirmed}; encrypt=${!!cur.encryptPayload}`;
}
