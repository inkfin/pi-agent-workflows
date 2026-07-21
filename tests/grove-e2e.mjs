/**
 * tests/grove-e2e.mjs — grove end-to-end and unit checks
 *
 * Requires: jj on PATH. Run: npm test
 */

import { createJiti } from "jiti";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GROVE = path.join(ROOT, ".pi", "extensions", "grove");

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: { "@earendil-works/pi-tui": path.join(ROOT, "tests", "stubs", "pi-tui.mjs") },
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grove-test-"));
const projDir = path.join(tmp, "proj");
fs.mkdirSync(projDir, { recursive: true });
execSync("git init", { cwd: projDir, stdio: "ignore" });
fs.writeFileSync(path.join(projDir, "README.md"), "grove test\n");
execSync('git add README.md && git -c user.email=t@t -c user.name=t commit -m init', {
  cwd: projDir,
  stdio: "ignore",
});

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}

const { JjCliBackend } = await jiti.import(path.join(GROVE, "backend", "jj-cli.ts"));
const types = await jiti.import(path.join(GROVE, "backend", "types.ts"));
const identity = await jiti.import(path.join(GROVE, "lib", "identity.ts"));
const sessions = await jiti.import(path.join(GROVE, "lib", "sessions.ts"));
const snapshots = await jiti.import(path.join(GROVE, "lib", "snapshots.ts"));
const ops = await jiti.import(path.join(GROVE, "mapping", "ops.ts"));
const harness = await jiti.import(path.join(GROVE, "mapping", "harness.ts"));
const sync = await jiti.import(path.join(GROVE, "mapping", "sync.ts"));
const registry = await jiti.import(path.join(GROVE, "mapping", "registry.ts"));
const settings = await jiti.import(path.join(GROVE, "lib", "settings.ts"));
const commands = await jiti.import(path.join(GROVE, "commands.ts"));
const coordinatorMod = await jiti.import(path.join(GROVE, "mapping", "coordinator.ts"));

function manifest(kind, label, extra = {}) {
  return {
    v: 1,
    kind,
    label,
    projectId: "projtest",
    sessionId: "20260720_abc.jsonl",
    snapshotId: extra.snapshotId ?? null,
    anchor: extra.anchor ?? { entryId: "entry-1", entryHash: "abcd", ordinal: 0, prefixHash: "pref" },
    lifecycle: extra.lifecycle ?? "pinned",
    project: { name: "proj" },
    origin: "test-mac",
    code: null,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

console.log("grove e2e\n=========");

const version = await JjCliBackend.checkAvailability();
console.log(`jj ${version}`);

const be = new JjCliBackend(projDir);
await be.ensureRepo();
assert.ok(fs.existsSync(path.join(be.repoDir(), ".jj")));
assert.ok(!fs.existsSync(path.join(be.repoDir(), ".git")));
ok("ensureRepo (git-backed, non-colocated)");

{
  const nodes = await be.listNodes();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].manifest?.kind, "root");
  assert.equal(nodes[0].manifest?.v, 1);
  ok("root node described at init");
}

const sessionContent =
  '{"id":"entry-1","role":"user","content":[{"type":"text","text":"hi"}]}\n' +
  '{"id":"entry-2","role":"assistant","content":[{"type":"text","text":"hello"}]}\n';
// Write a temp session file for snapshot builder
const sessDir = path.join(tmp, "agent", "sessions", sessions.cwdToSessionSlug(projDir));
fs.mkdirSync(sessDir, { recursive: true });
const sessionFile = path.join(sessDir, "20260720_abc.jsonl");
fs.writeFileSync(sessionFile, sessionContent);

const built = snapshots.buildSnapshotFromSession(sessionFile);
assert.ok(built.snapshotId.length === 64);
ok("content-addressed snapshot id");

const n1 = await be.commitNode({
  manifest: manifest("checkpoint", "first checkpoint", { snapshotId: built.snapshotId }),
  files: built.files,
});
assert.equal(n1.manifest.label, "first checkpoint");
assert.equal(n1.parents.length, 1);
ok("commitNode checkpoint + object snapshot");

const n2 = await be.commitNode({
  manifest: manifest("fork", "fork experiment", {
    sessionId: "forked.jsonl",
    forkFrom: {
      parentChangeId: n1.changeId,
      parentSessionId: "20260720_abc.jsonl",
      parentAnchor: { entryId: "entry-1" },
    },
  }),
  parents: [n1.changeId],
});
assert.deepEqual(n2.parents, [n1.changeId]);
assert.equal(n2.manifest.forkFrom.parentChangeId, n1.changeId);
ok("commitNode fork with forkFrom");

const n3 = await be.commitNode({
  parents: [n1.changeId, n2.changeId],
  manifest: manifest("context_merge", "merge test", {
    mergeOf: [{ changeId: n2.changeId, label: "fork", sessionId: "forked.jsonl", anchor: { entryId: null } }],
    injectStrategy: "summary",
    payloadHash: "deadbeef",
  }),
});
assert.deepEqual(new Set(n3.parents), new Set([n1.changeId, n2.changeId]));
ok("commitNode merge (two parents + mergeOf)");

assert.equal((await be.listNodes()).length, 4);
ok("listNodes = root + 3");

const shown = await be.showFile(n1.changeId, `objects/${built.snapshotId}.jsonl`);
assert.ok(shown.includes('"hi"'));
ok("showFile reads content-addressed snapshot");

await be.edit(n1.changeId);
assert.equal(await be.currentChangeId(), n1.changeId);
const preOp = await be.currentOperationId();
assert.ok(preOp.length > 8);
await be.undo();
assert.equal(await be.currentChangeId(), n3.changeId);
ok("edit + undo + operationId");

{
  const m = manifest("checkpoint", "codec");
  assert.deepEqual(types.decodeManifest(types.encodeManifest(m)), m);
  assert.equal(types.decodeManifest("not json"), null);
  assert.equal(types.decodeManifest('{"kind":"checkpoint","label":"incomplete"}'), null);
  assert.equal(types.decodeManifest(JSON.stringify({ ...m, v: 2 })), null);
  ok("manifest codec accepts only current v1 schema");
}

assert.ok(identity.machineId().length > 0);
assert.ok(identity.projectInfo(projDir).projectId.length === 16);
ok("machineId + stable projectId");

assert.equal(sessions.cwdToSessionSlug("/Users/me/My Project"), "--Users-me-My_Project--");
ok("session slug matches pi directory naming");

{
  const anchor = sessions.captureAnchor(sessionFile, "entry-1");
  assert.equal(anchor.entryId, "entry-1");
  assert.ok(anchor.prefixHash);
  const resolved = sessions.resolveAnchor(sessionFile, anchor);
  assert.equal(resolved.ok, true);
  ok("SessionAnchor capture + resolve");
}

{
  // Compaction simulation: rewrite file without entry-1 id but keep prefix
  const compacted = sessionContent.replace('"id":"entry-1"', '"id":"new-1"');
  const compactFile = path.join(sessDir, "compacted.jsonl");
  fs.writeFileSync(compactFile, compacted);
  const anchor = sessions.captureAnchor(sessionFile, "entry-1");
  // prefix of original first line won't match compacted — expect fail then prefix of rebuilt
  const bad = sessions.resolveAnchor(compactFile, { entryId: "entry-1", entryHash: "nope", ordinal: 99, prefixHash: "nope" });
  assert.equal(bad.ok, false);
  ok("compaction stale anchor detection");
}

assert.ok(sessions.summarizeSessionContent(sessionContent).includes("[user] hi"));
ok("summarizeSessionContent filters roles");

assert.equal(snapshots.redact("key sk-abcdefghijklmnopqrstuvwxyz123456 done"), "key sk-…REDACTED done");
ok("redact masks secrets");

{
  const nodes = await be.listNodes();
  const found = ops.nodeForSession(nodes, sessionFile);
  assert.ok(found);
  ok("nodeForSession latest-match");
}

{
  const older = {
    changeId: "older", commitId: "c1", parents: [], timestamp: "2026-07-20T01:00:00Z",
    manifest: manifest("checkpoint", "older"),
  };
  const newer = {
    changeId: "newer", commitId: "c2", parents: ["older"], timestamp: "2026-07-20T02:00:00Z",
    manifest: manifest("checkpoint", "newer"),
  };
  assert.equal(ops.nodeAtChange([older, newer], "older"), older);
  assert.equal(commands.groveStatusLabel(older), "◆ older");
  const can = ops.canAutoAmend(
    [{ changeId: "a", commitId: "c", parents: [], timestamp: "t", manifest: manifest("auto", "a", { lifecycle: "draft" }) }],
    "a",
  );
  assert.equal(can.ok, true);
  const blocked = ops.canAutoAmend(
    [
      { changeId: "a", commitId: "c", parents: [], timestamp: "t", manifest: manifest("auto", "a", { lifecycle: "draft" }) },
      { changeId: "b", commitId: "c2", parents: ["a"], timestamp: "t2", manifest: manifest("checkpoint", "b") },
    ],
    "a",
  );
  assert.equal(blocked.ok, false);
  ok("auto amend safety + status label");
}

assert.equal(harness.looksLikeReplacement("你做的不对，覆盖重做"), true);
assert.equal(harness.looksLikeReplacement("looks good"), false);
ok("replacement prompt heuristic");

{
  // Coordinator receipts
  const coord = new coordinatorMod.OperationCoordinator(be);
  await coord.begin("checkpoint", {});
  await coord.succeed(n1.changeId);
  assert.ok(coord.lastReceipt());
  ok("operation coordinator receipt");
}

{
  // Sync config + privacy gate
  const gated = settings.syncEnabled(projDir);
  assert.equal(gated.ok, false);
  sync.configureSync(projDir, { treeRemote: "git@example.com:me/tree.git", confirmPrivate: true });
  const open = settings.syncEnabled(projDir);
  assert.equal(open.ok, true);
  ok("sync default-off + privacy gate");
}

{
  // Registry outbox
  const rec = {
    projectId: "abc",
    name: "proj",
    updatedAt: new Date().toISOString(),
    machines: ["test"],
    sessions: [],
    frontierCommitId: "fff",
  };
  registry.enqueueRegistryOutbox(projDir, rec);
  const n = registry.flushRegistryOutbox(projDir);
  assert.ok(n >= 1);
  assert.ok(registry.dashboardLines().length >= 1);
  ok("registry outbox + dashboard");
}

// Bookmark API
{
  await be.setBookmark("grove/origins/test-mac", n3.changeId);
  const bms = await be.listBookmarks();
  assert.ok(bms.some((b) => b.name === "grove/origins/test-mac"));
  ok("origin bookmark set/list");
}

// Amend draft auto
{
  const auto = await be.commitNode({
    manifest: manifest("auto", "auto draft", { lifecycle: "draft", snapshotId: built.snapshotId }),
    files: built.files,
  });
  const amended = await be.amendNode({
    changeId: auto.changeId,
    manifest: { ...auto.manifest, label: "auto amended" },
  });
  assert.equal(amended.manifest.label, "auto amended");
  ok("amendNode updates draft auto");
}

// goto alignment mock
{
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent");
  try {
    const target = {
      changeId: "target-change",
      commitId: "target-commit",
      parents: [],
      timestamp: new Date().toISOString(),
      manifest: manifest("checkpoint", "remote checkpoint", {
        sessionId: "remote.jsonl",
        snapshotId: built.snapshotId,
        anchor: { entryId: "remote-entry" },
      }),
    };
    let edited = "";
    let switchedTo = "";
    let navigatedTo = "";
    let status = "";
    const mockBackend = {
      repoDir: () => be.repoDir(),
      edit: async (changeId) => { edited = changeId; },
      showFile: async () => sessionContent,
      ensureRepo: async () => be.repoDir(),
      currentOperationId: async () => "op",
      listNodes: async () => [],
    };
    const replacementCtx = {
      navigateTree: async (entryId) => { navigatedTo = entryId; },
      ui: { setStatus: (_k, v) => { status = v; }, notify: () => {} },
    };
    const mockCtx = {
      cwd: projDir,
      sessionManager: { getSessionFile: () => path.join(tmp, "current.jsonl") },
      switchSession: async (sessionFile, opts) => {
        switchedTo = sessionFile;
        await opts.withSession(replacementCtx);
      },
      ui: { notify: () => {} },
    };
    await commands.gotoNode(mockCtx, mockBackend, target);
    assert.equal(edited, target.changeId);
    assert.equal(path.basename(switchedTo), "remote.jsonl");
    assert.equal(navigatedTo, "remote-entry");
    assert.ok(status.includes("remote checkpoint"));
    ok("goto aligns switched session to checkpoint entry");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

// UI actions
{
  const tv = await jiti.import(path.join(GROVE, "ui", "tree-view.ts"));
  const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s };
  const alpha = {
    changeId: "alpha", commitId: "ac", parents: [], timestamp: "2026-07-20T01:00:00Z",
    manifest: manifest("checkpoint", "alpha"),
  };
  const beta = {
    changeId: "beta", commitId: "bc", parents: ["alpha"], timestamp: "2026-07-20T02:00:00Z",
    manifest: manifest("auto", "beta", { lifecycle: "draft" }),
  };
  const view = new tv.GroveTreeView([alpha, beta], "beta", "20260720_abc.jsonl", theme);
  assert.ok(view.render(80).join("\n").includes("beta"));

  let action = null;
  view.setResolve((r) => { action = r; });
  view.handleInput("k");
  view.handleInput("m");
  assert.equal(action?.action, "merge");
  assert.equal(action?.node.changeId, "alpha");

  const autoView = new tv.GroveTreeView([alpha, beta], "beta", "20260720_abc.jsonl", theme);
  action = null;
  autoView.setResolve((r) => { action = r; });
  autoView.handleInput("a");
  assert.equal(action?.action, "auto-keep");

  action = null;
  autoView.setResolve((r) => { action = r; });
  autoView.handleInput("y");
  assert.equal(action?.action, "sync-push");

  action = null;
  autoView.setResolve((r) => { action = r; });
  autoView.handleInput("d");
  assert.equal(action?.action, "dashboard");
  ok("ui actions: merge/auto/sync/dashboard");
}

assert.equal(typeof commands.setupGrove, "function");
ok("commands module loads");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
