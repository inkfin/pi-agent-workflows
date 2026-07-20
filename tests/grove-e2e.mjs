/**
 * tests/grove-e2e.mjs — grove end-to-end and unit checks
 *
 * Runs the TreeBackend against a real jj repo in a temp dir, plus unit
 * checks for manifest codec, identity, session helpers, redaction, and
 * module loading (ui/commands load with a stubbed pi-tui).
 *
 * Requires: jj on PATH. Run: npm test
 */

import { createJiti } from "jiti";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GROVE = path.join(ROOT, ".pi", "extensions", "grove");

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: { "@earendil-works/pi-tui": path.join(ROOT, "tests", "stubs", "pi-tui.mjs") },
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "grove-test-"));
const projDir = path.join(tmp, "proj");
fs.mkdirSync(projDir, { recursive: true });

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}

const { JjCliBackend } = await jiti.import(path.join(GROVE, "backend", "jj-cli.ts"));
const types = await jiti.import(path.join(GROVE, "backend", "types.ts"));
const identity = await jiti.import(path.join(GROVE, "lib", "identity.ts"));
const sessions = await jiti.import(path.join(GROVE, "lib", "sessions.ts"));
const ops = await jiti.import(path.join(GROVE, "mapping", "ops.ts"));

function manifest(kind, label, extra = {}) {
  return {
    v: 1, kind, label, sessionRef: "20260720_abc.jsonl", entryId: "entry-1",
    project: { name: "proj" }, origin: "test-mac", code: null,
    createdAt: new Date().toISOString(), ...extra,
  };
}

console.log("grove e2e\n=========");

// ── backend lifecycle ────────────────────────────────────────
const version = await JjCliBackend.checkAvailability();
console.log(`jj ${version}`);

const be = new JjCliBackend(projDir);
await be.ensureRepo();
assert.ok(fs.existsSync(path.join(be.repoDir(), ".jj")), "repo initialized");
assert.ok(!fs.existsSync(path.join(be.repoDir(), ".git")), "non-colocated (no .git in worktree)");
ok("ensureRepo (git-backed, non-colocated)");

{
  const nodes = await be.listNodes();
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].manifest?.kind, "root");
  ok("root node described at init");
}

const n1 = await be.commitNode({
  manifest: manifest("checkpoint", "first checkpoint"),
  files: { "sessions/20260720_abc.jsonl": '{"role":"user","content":[{"type":"text","text":"hi"}]}\n' },
});
assert.equal(n1.manifest.label, "first checkpoint");
assert.equal(n1.parents.length, 1, "checkpoint hangs off root");
ok("commitNode checkpoint + snapshot file");

const n2 = await be.commitNode({ manifest: manifest("fork", "fork experiment", { entryId: null }) });
assert.deepEqual(n2.parents, [n1.changeId]);
ok("commitNode fork parenting");

const n3 = await be.commitNode({
  parents: [n1.changeId, n2.changeId],
  manifest: manifest("merge", "merge test", { entryId: null }),
});
assert.deepEqual(new Set(n3.parents), new Set([n1.changeId, n2.changeId]));
ok("commitNode merge (two parents)");

assert.equal((await be.listNodes()).length, 4);
ok("listNodes = root + 3");

const snap = await be.showFile(n1.changeId, "sessions/20260720_abc.jsonl");
assert.ok(snap.includes('"hi"'));
ok("showFile reads snapshot at revision");

await be.edit(n1.changeId);
assert.equal(await be.currentChangeId(), n1.changeId);
await be.undo();
assert.equal(await be.currentChangeId(), n3.changeId);
ok("edit + undo");

// ── manifest codec ───────────────────────────────────────────
{
  const m = manifest("checkpoint", "codec");
  assert.deepEqual(types.decodeManifest(types.encodeManifest(m)), m);
  assert.equal(types.decodeManifest("not json"), null);
  assert.equal(types.decodeManifest('{"v":2}'), null);
  ok("manifest codec roundtrip + rejection");
}

// ── lib ──────────────────────────────────────────────────────
assert.ok(typeof identity.machineId() === "string" && identity.machineId().length > 0);
ok("machineId stable from XDG config");

{
  const sum = sessions.summarizeSessionContent(
    '{"role":"user","content":[{"type":"text","text":"hello"}]}\n' +
    '{"role":"assistant","content":[{"type":"text","text":"world"}]}\n' +
    '{"role":"toolResult","content":[]}\n',
  );
  assert.ok(sum.includes("[user] hello") && sum.includes("[assistant] world"));
  assert.ok(!sum.includes("toolResult"));
  ok("summarizeSessionContent filters roles");
}

assert.equal(ops.redact("key sk-abcdefghijklmnopqrstuvwxyz123456 done"), "key sk-…REDACTED done");
ok("redact masks sk- tokens");

{
  const nodes = await be.listNodes();
  const found = ops.nodeForSession(nodes, "/any/where/20260720_abc.jsonl");
  assert.ok(found, "finds by basename");
  assert.equal(found.manifest.label, "merge test", "latest node for session wins");
  ok("nodeForSession latest-match");
}

// ── module loading (ui/commands with stubbed pi-tui) ─────────
{
  const commands = await jiti.import(path.join(GROVE, "commands.ts"));
  assert.equal(typeof commands.setupGrove, "function");
  const tv = await jiti.import(path.join(GROVE, "ui", "tree-view.ts"));
  const theme = { fg: (_c, s) => s, bg: (_c, s) => s, bold: (s) => s };
  const view = new tv.GroveTreeView(
    [{ changeId: "aaa", commitId: "bbb", parents: [], timestamp: new Date().toISOString(), manifest: manifest("checkpoint", "render test") }],
    "aaa", "20260720_abc.jsonl", theme,
  );
  const lines = view.render(80);
  assert.ok(lines.join("\n").includes("render test"));
  ok("ui/commands load; tree-view renders");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
