/**
 * Grove semantic graph and outcome-capture e2e checks.
 */

import { createJiti } from "jiti";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { visibleWidth } from "./stubs/pi-tui.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GROVE = path.join(ROOT, ".pi", "extensions", "grove");
const SHARED = path.join(ROOT, ".pi", "extensions", "shared");
const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: { "@earendil-works/pi-tui": path.join(ROOT, "tests", "stubs", "pi-tui.mjs") },
});

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}

function gitProject(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const project = path.join(tmp, "project");
  fs.mkdirSync(project);
  execSync("git init", { cwd: project, stdio: "ignore" });
  fs.writeFileSync(path.join(project, "README.md"), "grove\n");
  execSync("git add . && git -c user.email=t@t -c user.name=t commit -m init", {
    cwd: project,
    stdio: "ignore",
  });
  return { tmp, project };
}

const { JjCliBackend, GroveWriteConflictError } = await jiti.import(
  path.join(GROVE, "backend", "jj-cli.ts"),
);
const types = await jiti.import(path.join(GROVE, "backend", "types.ts"));
const identity = await jiti.import(path.join(GROVE, "lib", "identity.ts"));
const sessions = await jiti.import(path.join(GROVE, "lib", "sessions.ts"));
const snapshots = await jiti.import(path.join(GROVE, "lib", "snapshots.ts"));
const ops = await jiti.import(path.join(GROVE, "mapping", "ops.ts"));
const capture = await jiti.import(path.join(GROVE, "mapping", "capture.ts"));
const harness = await jiti.import(path.join(GROVE, "mapping", "harness.ts"));
const journal = await jiti.import(path.join(GROVE, "lib", "journal.ts"));
const coordinatorMod = await jiti.import(path.join(GROVE, "mapping", "coordinator.ts"));
const settings = await jiti.import(path.join(GROVE, "lib", "settings.ts"));
const sync = await jiti.import(path.join(GROVE, "mapping", "sync.ts"));
const registry = await jiti.import(path.join(GROVE, "mapping", "registry.ts"));
const commands = await jiti.import(path.join(GROVE, "commands.ts"));
const graphView = await jiti.import(path.join(GROVE, "ui", "graph-view-model.ts"));
const graphLayout = await jiti.import(path.join(GROVE, "ui", "graph-layout.ts"));
const graphCamera = await jiti.import(path.join(GROVE, "ui", "graph-camera.ts"));
const graphCanvas = await jiti.import(path.join(GROVE, "ui", "graph-canvas.ts"));
const graphWorkspace = await jiti.import(path.join(GROVE, "ui", "graph-workspace.ts"));
const threadLoader = await jiti.import(path.join(GROVE, "ui", "thread-loader.ts"));
const threadWindow = await jiti.import(path.join(GROVE, "ui", "thread-window.ts"));
const outcomes = await jiti.import(path.join(SHARED, "outcomes.ts"));

console.log("grove e2e\n=========");
console.log(`jj ${await JjCliBackend.checkAvailability()}`);

{
  const concurrent = gitProject("grove-init-");
  await Promise.all([
    new JjCliBackend(concurrent.project).ensureRepo(),
    new JjCliBackend(concurrent.project).ensureRepo(),
  ]);
  assert.equal((await new JjCliBackend(concurrent.project).listRevisions()).length, 1);
  fs.rmSync(concurrent.tmp, { recursive: true, force: true });
  ok("Tree Repo initialization is cross-instance safe");
}

const { tmp, project } = gitProject("grove-graph-");
const backend = new JjCliBackend(project);
await backend.ensureRepo();
assert.ok(fs.existsSync(path.join(backend.repoDir(), ".jj")));
assert.ok(!fs.existsSync(path.join(backend.repoDir(), ".git")));
assert.equal((await backend.getGraph()).nodes.length, 0);
ok("Tree Repo initializes with an empty GraphTransaction");

const now = new Date().toISOString();
function nodeRecord(id, label, extra = {}) {
  return {
    v: 1,
    recordType: "node",
    nodeId: id,
    revision: extra.revision ?? 1,
    label,
    projectId: identity.projectInfo(project).projectId,
    sessionId: "session.jsonl",
    snapshotId: extra.snapshotId ?? null,
    anchor: extra.anchor ?? { entryId: "entry-1", ordinal: 0 },
    capture: extra.capture ?? { source: "harness", slotId: `slot:${id}`, sequence: 1 },
    state: extra.state ?? "draft",
    pinned: extra.pinned ?? false,
    project: { name: "project" },
    origin: "test",
    code: null,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

{
  const tx = {
    v: 1,
    recordType: "transaction",
    txId: "tx_codec",
    records: [nodeRecord("node_codec", "codec")],
    createdAt: now,
  };
  assert.deepEqual(types.decodeTransaction(types.encodeTransaction(tx)), tx);
  assert.equal(types.decodeTransaction("not json"), null);
  assert.equal(types.decodeTransaction(JSON.stringify({ ...tx, v: 2 })), null);
  ok("GraphTransaction codec validates current v1 records");
}

const first = await backend.recordNode({ node: nodeRecord("node_first", "first") });
const firstChange = first.backendRef.changeId;
const amended = await backend.amendDraft({
  nodeId: first.nodeId,
  expectedRevision: 1,
  patch: { label: "first amended" },
});
assert.equal(amended.nodeId, first.nodeId);
assert.equal(amended.revision, 2);
assert.notEqual(amended.backendRef.changeId, firstChange);
ok("nodeId remains stable while backend transaction locator changes");

const siblingA = nodeRecord("node_sibling_a", "sibling A");
const siblingB = nodeRecord("node_sibling_b", "sibling B");
await backend.recordNode({
  node: siblingA,
  edges: [ops.lineageEdge(first.nodeId, siblingA.nodeId)],
});
await backend.recordNode({
  node: siblingB,
  edges: [ops.lineageEdge(first.nodeId, siblingB.nodeId)],
});
{
  const graph = await backend.getGraph();
  assert.equal(
    graph.edges.filter((edge) => edge.fromNodeId === first.nodeId && edge.kind === "lineage").length,
    2,
  );
  assert.equal(types.isEffectivelySealed(graph.nodes.find((node) => node.nodeId === first.nodeId), graph.edges), true);
  assert.notDeepEqual(
    graph.nodes.find((node) => node.nodeId === siblingA.nodeId).backendRef.parents,
    [first.nodeId],
  );
  ok("semantic siblings and sealing are independent from jj parent topology");
}

{
  const graph = await backend.getGraph();
  const edge = graph.edges.find((candidate) => candidate.toNodeId === siblingA.nodeId);
  const deleted = await backend.deleteEdge({ edgeId: edge.edgeId, expectedGraphRevision: graph.revision });
  assert.equal(deleted.state, "deleted");
  const restored = {
    ...deleted,
    backendRef: undefined,
    revision: deleted.revision + 1,
    state: "active",
    createdAt: new Date().toISOString(),
  };
  delete restored.backendRef;
  await backend.appendEdge({ edge: restored });
  assert.equal((await backend.getGraph()).edges.find((item) => item.edgeId === edge.edgeId).state, "active");
  ok("edge deletion is an append-only revision, not a node rewrite");
}

{
  const attachment = {
    v: 1,
    recordType: "attachment",
    attachmentId: "attachment_test",
    targetNodeId: siblingA.nodeId,
    kind: "decision",
    producer: { extension: "test", sourceId: "decision-1" },
    contentHash: "a".repeat(64),
    createdAt: now,
  };
  const once = await backend.appendAttachment({ attachment });
  const twice = await backend.appendAttachment({ attachment });
  assert.equal(once.attachmentId, twice.attachmentId);
  assert.equal(
    (await backend.getGraph()).attachments.filter((item) => item.attachmentId === attachment.attachmentId).length,
    1,
  );
  ok("immutable attachment append is idempotent");
}

{
  const staleRevision = await backend.graphRevision();
  const physicalHead = await backend.currentChangeId();
  await backend.gotoNode(siblingA.nodeId);
  assert.equal(await backend.graphRevision(), staleRevision);
  const converged = await backend.applyGraphTransaction({
    records: [],
    expectedGraphRevision: staleRevision,
  });
  assert.ok(converged.revision.parents.includes(physicalHead));
  await assert.rejects(
    backend.applyGraphTransaction({ records: [], expectedGraphRevision: staleRevision }),
    GroveWriteConflictError,
  );
  ok("storage heads converge independently while graph revision fences stale writers");
}

{
  const left = new JjCliBackend(project);
  const right = new JjCliBackend(project);
  const revision = await left.graphRevision();
  const results = await Promise.allSettled([
    left.applyGraphTransaction({ records: [], expectedGraphRevision: revision }),
    right.applyGraphTransaction({ records: [], expectedGraphRevision: revision }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  ok("cross-instance writer lock serializes Tree Repo mutations");
}

const sessionDir = path.join(tmp, "sessions");
fs.mkdirSync(sessionDir);
const sessionFile = path.join(sessionDir, "session.jsonl");
fs.writeFileSync(
  sessionFile,
  [
    '{"id":"entry-1","role":"user","content":[{"type":"text","text":"build it"}]}',
    '{"id":"entry-2","role":"assistant","content":[{"type":"text","text":"done"}]}',
    "",
  ].join("\n"),
);
const snapshot = snapshots.buildSnapshotFromSession(sessionFile);
assert.equal(snapshot.snapshotId.length, 64);
assert.equal(sessions.resolveAnchor(sessionFile, sessions.captureAnchor(sessionFile, "entry-1")).ok, true);
ok("session snapshots and anchors remain content addressed");

const captureProject = gitProject("grove-capture-");
const captureBackend = new JjCliBackend(captureProject.project);
await captureBackend.ensureRepo();
const base = await ops.checkpointSession(captureBackend, captureProject.project, {
  label: "base",
  sessionFile,
  entryId: "entry-1",
});
const projectId = identity.projectInfo(captureProject.project).projectId;

function proposal({
  eventId,
  sourceEventId,
  slotId,
  sequence,
  baseNodeId = base.nodeId,
  payload = { status: "succeeded", value: sequence },
}) {
  return {
    v: 1,
    type: "attachment_proposal",
    eventId,
    sourceEventId,
    occurredAt: new Date().toISOString(),
    sessionId: path.basename(sessionFile),
    projectId,
    slotId,
    workItemId: slotId,
    buildAttemptId: `attempt-${sequence}`,
    planRevision: 1,
    sequence,
    baseNodeId,
    baseCodeRevision: "abc",
    kind: "execution_outcome",
    producer: { extension: "orchestrator", sourceId: sourceEventId },
    contentHash: outcomes.contentHash(payload),
    payload,
  };
}

const p1 = proposal({ eventId: "event-1", sourceEventId: "run-1", slotId: "slot-main", sequence: 1 });
const created = await capture.captureProposal(captureBackend, captureProject.project, {
  sessionFile,
  entryId: "entry-2",
  proposal: p1,
  cursor: 1,
});
assert.equal(created.status, "created");
assert.equal(created.node.capture.source, "orchestrator");
assert.equal(
  (await captureBackend.getGraph()).edges.some(
    (edge) => edge.fromNodeId === base.nodeId && edge.toNodeId === created.node.nodeId,
  ),
  true,
);
const duplicate = await capture.captureProposal(captureBackend, captureProject.project, {
  sessionFile,
  entryId: "entry-2",
  proposal: p1,
  cursor: 1,
});
assert.equal(duplicate.status, "duplicate");
ok("durable proposal creates one generic node and replays idempotently");

const p2 = proposal({ eventId: "event-2", sourceEventId: "run-2", slotId: "slot-main", sequence: 2 });
const updated = await capture.captureProposal(captureBackend, captureProject.project, {
  sessionFile,
  entryId: "entry-2",
  proposal: p2,
  cursor: 2,
});
assert.equal(updated.status, "amended");
assert.equal(updated.node.nodeId, created.node.nodeId);
assert.equal(updated.node.capture.sequence, 2);
assert.equal(
  (await captureBackend.getGraph()).attachments.filter(
    (attachment) => attachment.targetNodeId === created.node.nodeId,
  ).length,
  1,
);
ok("same-slot retry amends stable node and tombstones prior outcome");

{
  const summaryPayload = { text: "Implemented and verified." };
  const summary = {
    ...proposal({
      eventId: "event-summary",
      sourceEventId: "summary:attempt-2",
      slotId: "slot-main",
      sequence: 2,
      payload: summaryPayload,
    }),
    kind: "summary",
    contentHash: outcomes.contentHash(summaryPayload),
  };
  const result = await capture.captureProposal(captureBackend, captureProject.project, {
    sessionFile,
    entryId: "entry-2",
    proposal: summary,
    cursor: 2,
  });
  assert.equal(result.status, "attached");
  assert.equal(result.node.nodeId, created.node.nodeId);
  assert.deepEqual(
    (await captureBackend.getGraph()).attachments
      .filter((attachment) => attachment.targetNodeId === created.node.nodeId)
      .map((attachment) => attachment.kind)
      .sort(),
    ["execution_outcome", "summary"],
  );
  ok("foreground Summary appends an Attachment without creating another Node");
}

{
  const large = proposal({
    eventId: "event-large",
    sourceEventId: "run-large",
    slotId: "slot-large",
    sequence: 1,
    payload: { text: "x".repeat(capture.MAX_ATTACHMENT_BYTES + 1024) },
  });
  const result = await capture.captureProposal(captureBackend, captureProject.project, {
    sessionFile,
    entryId: "entry-2",
    proposal: large,
    cursor: 2,
  });
  const graph = await captureBackend.getGraph();
  const attachment = graph.attachments.find(
    (item) => item.targetNodeId === result.node.nodeId,
  );
  const stored = await captureBackend.showFile("@", attachment.payloadPath);
  assert.ok(Buffer.byteLength(stored, "utf8") < capture.MAX_ATTACHMENT_BYTES);
  assert.ok(stored.includes('"truncated":true'));
  ok("attachment payloads are redacted and size bounded");
}

const stale = proposal({ eventId: "event-stale", sourceEventId: "run-old", slotId: "slot-main", sequence: 1 });
assert.equal(
  (
    await capture.captureProposal(captureBackend, captureProject.project, {
      sessionFile,
      entryId: "entry-2",
      proposal: stale,
      cursor: 3,
    })
  ).status,
  "rejected",
);
ok("stale sequence cannot overwrite a newer outcome");

const pa = proposal({ eventId: "event-a", sourceEventId: "run-a", slotId: "slot-a", sequence: 1 });
const pb = proposal({ eventId: "event-b", sourceEventId: "run-b", slotId: "slot-b", sequence: 1 });
const outcomeA = await capture.captureProposal(captureBackend, captureProject.project, {
  sessionFile,
  entryId: "entry-2",
  proposal: pa,
  cursor: 4,
});
const outcomeB = await capture.captureProposal(captureBackend, captureProject.project, {
  sessionFile,
  entryId: "entry-2",
  proposal: pb,
  cursor: 5,
});
assert.notEqual(outcomeA.node.nodeId, outcomeB.node.nodeId);
assert.equal(
  (await captureBackend.getGraph()).edges.filter(
    (edge) =>
      edge.kind === "lineage" &&
      edge.fromNodeId === base.nodeId &&
      [outcomeA.node.nodeId, outcomeB.node.nodeId].includes(edge.toNodeId),
  ).length,
  2,
);
ok("accepted worktree outcomes from one explicit base form siblings");

{
  const coordinator = new coordinatorMod.OperationCoordinator(captureBackend);
  const receipt = await coordinator.undoLast();
  assert.equal(receipt.eventId, "event-b");
  const graph = await captureBackend.getGraph();
  assert.ok(
    graph.dispositions.some(
      (record) => record.targetType === "proposal" && record.targetId === "event-b",
    ),
  );
  assert.equal(graph.nodes.some((node) => node.nodeId === outcomeB.node.nodeId), false);
  const replay = await capture.captureProposal(captureBackend, captureProject.project, {
    sessionFile,
    entryId: "entry-2",
    proposal: pb,
    cursor: 5,
  });
  assert.equal(replay.status, "duplicate");
  assert.equal(
    (await captureBackend.getGraph()).nodes.some((node) => node.nodeId === outcomeB.node.nodeId),
    false,
  );
  ok("undo writes proposal disposition so restart replay cannot resurrect a node");
}

{
  const recoveredProposal = proposal({
    eventId: "event-reconcile",
    sourceEventId: "run-reconcile",
    slotId: "slot-reconcile",
    sequence: 1,
  });
  const recovered = await capture.reconcileProposals(
    captureBackend,
    captureProject.project,
    {
      sessionFile,
      entryId: "entry-2",
      entries: [
        {
          type: "custom",
          customType: outcomes.GROVE_ATTACHMENT_PROPOSAL_ENTRY,
          data: recoveredProposal,
        },
      ],
    },
  );
  assert.equal(recovered[0].status, "created");
  assert.equal(recovered[0].node.capture.latestEventId, "event-reconcile");
  ok("foreground reconciles a cross-extension proposal from session WAL");
}

{
  const entries = [
    { type: "custom", customType: outcomes.GROVE_ATTACHMENT_PROPOSAL_ENTRY, data: pa },
    { type: "custom", customType: "other", data: pb },
  ];
  assert.deepEqual(capture.attachmentProposals(entries).map((item) => item.cursor), [0]);
  assert.equal(harness.shouldRunLegacyHarness(captureProject.project, true), false);
  assert.equal(harness.shouldRunLegacyHarness(captureProject.project, false), true);
  ok("session entries are proposal truth and auto mode gates legacy capture");
}

{
  const state = journal.loadJournal(captureBackend.repoDir());
  assert.ok(state.inboxBySession[path.basename(sessionFile)].processedEventIds.includes("event-2"));
  const coordinator = new coordinatorMod.OperationCoordinator(captureBackend);
  await coordinator.begin("pin", {});
  await coordinator.succeed(undefined, base.nodeId);
  assert.equal(coordinator.lastReceipt().nodeId, base.nodeId);
  ok("journal isolates session inbox and records domain identities");
}

assert.equal(snapshots.redact("token sk-abcdefghijklmnopqrstuvwxyz123456"), "token sk-…REDACTED");
assert.equal(harness.looksLikeReplacement("你做的不对，覆盖重做"), true);
ok("redaction and replacement heuristics");

{
  const gate = settings.syncEnabled(captureProject.project);
  assert.equal(gate.ok, false);
  sync.configureSync(captureProject.project, {
    treeRemote: "git@example.com:me/tree.git",
    confirmPrivate: true,
  });
  assert.equal(settings.syncEnabled(captureProject.project).ok, true);
  const record = {
    projectId: "abc",
    name: "project",
    updatedAt: now,
    machines: ["test"],
    sessions: [],
    frontierCommitId: "fff",
  };
  registry.enqueueRegistryOutbox(captureProject.project, record);
  assert.ok(registry.flushRegistryOutbox(captureProject.project) >= 1);
  ok("sync stays private-by-default and registry outbox works");
}

{
  const materializedNode = (id, label, sessionId, createdAt) => ({
    ...nodeRecord(id, label, {
      sessionId,
      createdAt,
      updatedAt: createdAt,
      anchor: { entryId: `${id}-entry`, ordinal: 1 },
    }),
    backendRef: {
      changeId: `change-${id}`,
      commitId: `commit-${id}`,
      timestamp: createdAt,
    },
  });
  const materializedEdge = (id, fromNodeId, toNodeId, kind) => ({
    v: 1,
    recordType: "edge",
    edgeId: id,
    revision: 1,
    fromNodeId,
    toNodeId,
    kind,
    state: "active",
    createdAt: now,
    backendRef: {
      changeId: `change-${id}`,
      commitId: `commit-${id}`,
      timestamp: now,
    },
  });
  const graph = {
    revision: "graph-ui",
    nodes: [
      materializedNode("ui-root", "Root 节点", "root.jsonl", "2026-01-01T00:00:00.000Z"),
      materializedNode("ui-build", "Build result", "build.jsonl", "2026-01-02T00:00:00.000Z"),
      materializedNode("ui-review", "Review result", "review.jsonl", "2026-01-03T00:00:00.000Z"),
    ],
    edges: [
      materializedEdge("ui-lineage-a", "ui-root", "ui-build", "lineage"),
      materializedEdge("ui-lineage-b", "ui-root", "ui-review", "lineage"),
      materializedEdge("ui-context", "ui-build", "ui-review", "context"),
      materializedEdge("ui-supersedes", "ui-review", "ui-root", "supersedes"),
    ],
    attachments: [],
    dispositions: [],
    frontiers: [],
  };
  const model = graphView.buildGraphViewModel(graph, "ui-root", "root.jsonl");
  const reversed = graphView.buildGraphViewModel(
    { ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() },
    "ui-root",
    "root.jsonl",
  );
  const colorMap = (value) =>
    [...value.byId].map(([id, view]) => [id, view.colorSlot]).sort();
  assert.deepEqual(colorMap(model), colorMap(reversed));
  for (const edge of model.activeEdges) {
    assert.notEqual(
      model.byId.get(edge.fromNodeId).colorSlot,
      model.byId.get(edge.toNodeId).colorSlot,
    );
  }
  assert.equal(model.byId.get("ui-root").actions.merge.enabled, false);
  assert.equal(model.byId.get("ui-build").actions.fork.enabled, false);

  const layout = graphLayout.layoutGraph(model);
  assert.equal(layout.nodes.get("ui-root").rank, 0);
  assert.equal(layout.nodes.get("ui-build").rank, 1);
  assert.equal(
    graphLayout.findDirectionalNode(layout, "ui-root", "right") !== null,
    true,
  );
  assert.deepEqual(
    layout.orderedNodes.map(({ nodeId, rank, order }) => ({ nodeId, rank, order })),
    graphLayout.layoutGraph(reversed).orderedNodes.map(({ nodeId, rank, order }) => ({
      nodeId,
      rank,
      order,
    })),
  );
  const cycleGraph = {
    ...graph,
    revision: "graph-cycle",
    nodes: [
      ...graph.nodes,
      materializedNode("ui-orphan", "Orphan", "orphan.jsonl", "2026-01-04T00:00:00.000Z"),
    ],
    edges: [
      materializedEdge("cycle-a", "ui-root", "ui-build", "lineage"),
      materializedEdge("cycle-b", "ui-build", "ui-root", "lineage"),
      materializedEdge("missing-target", "ui-review", "does-not-exist", "lineage"),
    ],
  };
  const cycleLayout = graphLayout.layoutGraph(
    graphView.buildGraphViewModel(cycleGraph, "ui-root", "root.jsonl"),
  );
  assert.equal(cycleLayout.nodes.size, 4);
  assert.ok(
    cycleLayout.orderedNodes.every(
      (node) => Number.isFinite(node.x) && Number.isFinite(node.y),
    ),
  );

  const camera = new graphCamera.GraphCamera({ centerX: 0, centerY: 0, zoom: 1 });
  const anchor = { x: 10, y: 5 };
  const viewport = { width: 80, height: 18 };
  const before = camera.worldToScreen(anchor, viewport);
  camera.zoomBy(0.5, anchor, 1_000);
  camera.step(2_000);
  const after = camera.worldToScreen(anchor, viewport);
  assert.ok(Math.abs(before.x - after.x) < 0.001);
  assert.ok(Math.abs(before.y - after.y) < 0.001);
  assert.equal(camera.state.zoom, 1.5);

  const theme = {
    fg: (_color, text) => text,
    bg: (_color, text) => text,
    bold: (text) => text,
    italic: (text) => text,
    underline: (text) => text,
    strikethrough: (text) => text,
  };
  const rootCenter = graphCanvas.nodeWorldCenter(layout, "ui-root");
  camera.jumpTo({ centerX: rootCenter.x, centerY: rootCenter.y, zoom: 1 });
  const canvas = graphCanvas.renderGraphCanvas(
    model,
    layout,
    camera,
    viewport,
    theme,
    { selectedNodeId: "ui-root" },
  );
  assert.equal(canvas.lines.length, viewport.height);
  assert.ok(canvas.lines.every((line) => visibleWidth(line) <= viewport.width));
  assert.ok(canvas.lines.join("\n").includes("Root"));
  ok("graph view model, colors, layout, camera, and canvas are deterministic");

  const jsonl = [
    { type: "session", id: "session-ui", timestamp: now, cwd: project },
    {
      type: "message",
      id: "entry-1",
      parentId: null,
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "first" }] },
    },
    {
      type: "message",
      id: "entry-2",
      parentId: "entry-1",
      timestamp: now,
      message: { role: "assistant", content: [{ type: "text", text: "second" }] },
    },
    {
      type: "message",
      id: "entry-3",
      parentId: "entry-2",
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "after anchor" }] },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const parsed = threadLoader.parseAnchoredThread(jsonl, {
    entryId: "entry-2",
    ordinal: 2,
  });
  assert.deepEqual(parsed.items.map((item) => item.text), ["first", "second"]);
  assert.equal(parsed.truncatedAtAnchor, true);
  const jsonLines = jsonl.split("\n");
  const hashedAnchor = {
    entryId: null,
    entryHash: sessions.hashLine(jsonLines[2]),
    ordinal: 2,
    prefixHash: sessions.sha256(jsonLines.slice(0, 3).join("\n")).slice(0, 16),
  };
  assert.equal(
    sessions.resolveAnchorContent(jsonl, hashedAnchor).entryId,
    "entry-2",
  );

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const isolatedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "grove-thread-"));
  process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
  const staleSessionId = "stale-session.jsonl";
  const staleDir = sessions.projectSessionsDir(project);
  fs.mkdirSync(staleDir, { recursive: true });
  const staleRows = [...jsonLines];
  staleRows[2] = JSON.stringify({
    ...JSON.parse(staleRows[2]),
    message: { role: "assistant", content: [{ type: "text", text: "tampered future" }] },
  });
  fs.writeFileSync(path.join(staleDir, staleSessionId), staleRows.join("\n"));
  const staleThread = await threadLoader.loadNodeThread(
    { showFile: async () => jsonl },
    project,
    {
      ...graph.nodes[1],
      sessionId: staleSessionId,
      snapshotId: "f".repeat(64),
      anchor: hashedAnchor,
    },
  );
  assert.equal(staleThread.source, "snapshot");
  assert.ok(staleThread.items.some((item) => item.text === "second"));
  assert.ok(!staleThread.items.some((item) => item.text === "tampered future"));
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(isolatedAgentDir, { recursive: true, force: true });

  let toggled = null;
  const window = new threadWindow.ThreadWindow(
    graph.nodes[1],
    model.byId.get("ui-build").colorSlot,
    theme,
    false,
    18,
    {
      close: () => {},
      toggleMaximize: (state) => { toggled = state; },
      switchNode: () => {},
      requestRender: () => {},
    },
  );
  window.setThread({
    nodeId: "ui-build",
    source: "local",
    items: parsed.items,
    truncatedAtAnchor: true,
  });
  const threadLines = window.render(60);
  assert.ok(threadLines.join("\n").includes("first"));
  assert.ok(threadLines.every((line) => visibleWidth(line) <= 60));
  window.setThread({
    nodeId: "ui-build",
    source: "local",
    items: Array.from({ length: 20 }, (_, index) => ({
      id: `long-${index}`,
      parentId: index ? `long-${index - 1}` : null,
      kind: index % 2 ? "assistant" : "user",
      text: `message ${index}`,
    })),
    truncatedAtAnchor: false,
  });
  window.render(60);
  for (let index = 0; index < 5; index++) window.handleInput("\x1b[106u");
  window.handleInput("\x1b[109u");
  assert.equal(toggled.maximized, false);
  assert.ok(toggled.scrollOffset >= 5);
  ok("anchored thread and floating window exclude later turns");

  const overlays = [];
  let renders = 0;
  let focused = null;
  const tui = {
    terminal: { columns: 100, rows: 30 },
    requestRender: () => { renders++; },
    setFocus: (component) => { focused = component; },
    showOverlay: (component, options) => {
      const entry = { component, options, hidden: false };
      overlays.push(entry);
      return {
        hide: () => { entry.hidden = true; },
        setHidden: (hidden) => { entry.hidden = hidden; },
        isHidden: () => entry.hidden,
        focus: () => { focused = component; },
        unfocus: () => {},
        isFocused: () => focused === component,
      };
    },
  };
  let workspaceResult;
  const workspace = new graphWorkspace.GraphWorkspace({
    graph,
    currentNodeId: "ui-root",
    currentSessionRef: "root.jsonl",
    tui,
    theme,
    loadThread: async (node) => ({
      nodeId: node.nodeId,
      source: "local",
      items: parsed.items,
      truncatedAtAnchor: true,
    }),
    done: (result) => { workspaceResult = result; },
  });
  const workspaceLines = workspace.render(100);
  assert.equal(workspaceLines.length, 29);
  assert.ok(workspaceLines.every((line) => visibleWidth(line) <= 100));
  tui.terminal.columns = 80;
  tui.terminal.rows = 24;
  const narrowLines = workspace.render(80);
  assert.equal(narrowLines.length, 23);
  assert.ok(narrowLines.every((line) => visibleWidth(line) <= 80));
  tui.terminal.columns = 100;
  tui.terminal.rows = 30;
  workspace.handleInput("\x1b[27;2;63~");
  assert.ok(workspace.render(100).join("\n").includes("Grove navigation"));
  workspace.handleInput("\x1b[27;2;63~");
  workspace.handleInput("\x1b[27;2;43~");
  workspace.handleInput("\x1b[47u");
  assert.ok(workspace.render(100).join("\n").includes("SEARCH"));
  workspace.handleInput("\x1b");
  workspace.handleInput("\x1b[108u");
  assert.notEqual(workspace.selectedId, "ui-root");
  workspace.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(overlays.length, 1);
  assert.ok(overlays[0].component.render(70).join("\n").includes("first"));
  overlays[0].component.handleInput("m");
  assert.equal(overlays.length, 2);
  assert.equal(overlays[1].options.width, "100%");
  overlays[1].component.handleInput("\x1b");
  assert.equal(focused, workspace);
  assert.ok(renders > 0);
  workspace.dispose();

  const actionWorkspace = new graphWorkspace.GraphWorkspace({
    graph,
    currentNodeId: "ui-root",
    currentSessionRef: "root.jsonl",
    tui,
    theme,
    loadThread: async () => ({
      nodeId: "ui-root",
      source: "local",
      items: [],
      truncatedAtAnchor: false,
    }),
    done: (result) => { workspaceResult = result; },
  });
  actionWorkspace.handleInput("\x1b[97u");
  actionWorkspace.handleInput("\x1b[103u");
  assert.equal(workspaceResult.action, "goto");
  assert.equal(workspaceResult.node.nodeId, "ui-root");

  workspaceResult = undefined;
  const realignWorkspace = new graphWorkspace.GraphWorkspace({
    graph,
    currentNodeId: "ui-root",
    currentSessionRef: "root.jsonl",
    tui,
    theme,
    loadThread: async () => ({
      nodeId: "ui-root",
      source: "local",
      items: [],
      truncatedAtAnchor: false,
    }),
    done: (result) => { workspaceResult = result; },
  });
  realignWorkspace.handleInput("a");
  realignWorkspace.handleInput("\x1b[27;2;82~");
  assert.equal(workspaceResult.action, "realign");

  const pendingThreads = new Map();
  const raceWorkspace = new graphWorkspace.GraphWorkspace({
    graph,
    currentNodeId: "ui-root",
    currentSessionRef: "root.jsonl",
    tui,
    theme,
    loadThread: (node) =>
      new Promise((resolve) => pendingThreads.set(node.nodeId, resolve)),
    done: () => {},
  });
  raceWorkspace.handleInput("\r");
  const firstRaceOverlay = overlays.at(-1);
  firstRaceOverlay.component.handleInput("]");
  const secondRaceOverlay = overlays.at(-1);
  const selectedAfterSwitch = raceWorkspace.selectedId;
  pendingThreads.get(selectedAfterSwitch)({
    nodeId: selectedAfterSwitch,
    source: "local",
    items: [{ id: "new", parentId: null, kind: "assistant", text: "new thread" }],
    truncatedAtAnchor: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  pendingThreads.get("ui-root")({
    nodeId: "ui-root",
    source: "local",
    items: [{ id: "old", parentId: null, kind: "assistant", text: "stale thread" }],
    truncatedAtAnchor: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const raceRender = secondRaceOverlay.component.render(70).join("\n");
  assert.ok(raceRender.includes("new thread"));
  assert.ok(!raceRender.includes("stale thread"));
  raceWorkspace.dispose();
  assert.equal(secondRaceOverlay.hidden, true);
  ok("workspace navigation, overlay maximize, and action dispatch work");
}

{
  const graph = await captureBackend.getGraph();
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };
  const ui = await jiti.import(path.join(GROVE, "ui", "tree-view.ts"));
  const view = new ui.GroveTreeView(graph, created.node.nodeId, path.basename(sessionFile), theme);
  const rendered = view.render(100).join("\n");
  assert.ok(rendered.includes("build r1"));
  assert.ok(rendered.includes("outcome"));
  let action;
  view.setResolve((result) => {
    action = result;
  });
  view.handleInput("s");
  assert.equal(action.action, "goto");
  ok("UI renders semantic graph and Build attachment");
}

{
  let edited = "";
  const target = (await captureBackend.getGraph()).nodes.find((node) => node.nodeId === created.node.nodeId);
  const mockBackend = {
    ...captureBackend,
    repoDir: () => captureBackend.repoDir(),
    getGraph: () => captureBackend.getGraph(),
    getNode: (id) => captureBackend.getNode(id),
    gotoNode: async (nodeId) => {
      edited = nodeId;
    },
    showFile: (...args) => captureBackend.showFile(...args),
    ensureRepo: () => captureBackend.ensureRepo(),
    currentOperationId: () => captureBackend.currentOperationId(),
  };
  const currentSession = sessionFile;
  let navigated = "";
  const mockCtx = {
    cwd: captureProject.project,
    sessionManager: { getSessionFile: () => currentSession },
    navigateTree: async (entryId) => {
      navigated = entryId;
    },
    switchSession: async (_sessionPath, options) => {
      await options.withSession({
        ...mockCtx,
        sessionManager: { getSessionFile: () => _sessionPath },
      });
    },
    ui: { setStatus: () => {}, notify: () => {} },
  };
  await commands.gotoNode(mockCtx, mockBackend, target);
  assert.equal(edited, target.nodeId);
  assert.equal(navigated, "entry-2");
  navigated = "";
  await commands.gotoNode(mockCtx, mockBackend, {
    ...target,
    anchor: sessions.captureAnchor(currentSession, null),
  });
  assert.equal(navigated, "entry-2");
  assert.equal(
    (
      await commands.activeSessionNode(
        await captureBackend.getGraph(),
        mockBackend,
        currentSession,
      )
    ).nodeId,
    target.nodeId,
  );
  ok("goto navigates by nodeId, not jj change-id");
}

{
  const source = (await captureBackend.getGraph()).nodes[0];
  const injected = await ops.recordContextInjection(
    captureBackend,
    captureProject.project,
    {
      label: "context alignment",
      sessionFile,
      source,
      payload: "context payload",
    },
  );
  assert.equal(
    new coordinatorMod.OperationCoordinator(captureBackend).getAligned().nodeId,
    injected.nodeId,
  );
  ok("context injection advances semantic session alignment");
}

assert.equal(typeof commands.connectNodes, "function");
assert.equal(typeof commands.disconnectEdge, "function");
assert.equal(typeof capture.promoteWorktreeOutcome, "function");
assert.equal(typeof commands.setupGrove, "function");
ok("future graph editor seams are explicit APIs");

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(captureProject.tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
