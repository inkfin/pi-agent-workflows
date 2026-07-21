/**
 * tests/orchestrator-e2e.mjs — unit + worktree e2e for orchestrator
 *
 * Run: node tests/orchestrator-e2e.mjs
 */

import { createJiti } from "jiti";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ORCH = path.join(ROOT, ".pi", "extensions", "orchestrator");

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-tui": path.join(ROOT, "tests", "stubs", "pi-tui.mjs"),
    "@earendil-works/pi-ai": path.join(ROOT, "tests", "stubs", "pi-ai.mjs"),
    typebox: path.join(ROOT, "tests", "stubs", "typebox.mjs"),
  },
});

let passed = 0;
function ok(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("orchestrator e2e\n================");

const plan = await jiti.import(path.join(ORCH, "lib", "plan.ts"));
const safe = await jiti.import(path.join(ORCH, "lib", "safe-commands.ts"));
const agents = await jiti.import(path.join(ORCH, "lib", "agents.ts"));
const worktree = await jiti.import(path.join(ORCH, "lib", "worktree.ts"));
const workflowMod = await jiti.import(path.join(ORCH, "lib", "workflow.ts"));
const runner = await jiti.import(path.join(ORCH, "lib", "runner.ts"));
const scheduler = await jiti.import(path.join(ORCH, "lib", "scheduler.ts"));
const workerGuard = await jiti.import(path.join(ORCH, "worker-guard.ts"));
const configMod = await jiti.import(path.join(ORCH, "lib", "config.ts"));
const uiMod = await jiti.import(path.join(ORCH, "lib", "ui.ts"));
const orchestratorModule = await jiti.import(path.join(ORCH, "index.ts"));

// ── plan validation ────────────────────────────────────────
{
  const good = plan.normalizeIncomingPlan({
    summary: "Add feature X",
    openQuestions: [],
    tasks: [
      { id: "scout1", kind: "research", agent: "scout", goal: "Find call sites", dependsOn: [], allowedPaths: [] },
      {
        id: "edit1",
        kind: "edit",
        agent: "worker",
        goal: "Implement X",
        dependsOn: ["scout1"],
        allowedPaths: ["src/"],
      },
      {
        id: "rev1",
        kind: "review",
        agent: "reviewer",
        goal: "Review",
        dependsOn: ["edit1"],
        allowedPaths: [],
      },
    ],
  });
  assert.equal(good.revision, 1);
  assert.equal(plan.validatePlan(good).length, 0);
  ok("valid plan accepts");

  const badCycle = plan.normalizeIncomingPlan({
    summary: "cycle",
    tasks: [
      { id: "a", kind: "research", agent: "scout", goal: "a", dependsOn: ["b"], allowedPaths: [] },
      { id: "b", kind: "research", agent: "scout", goal: "b", dependsOn: ["a"], allowedPaths: [] },
    ],
  });
  assert.ok(plan.validatePlan(badCycle).some((e) => e.code === "cycle"));
  ok("detects dependency cycle");

  const overlap = plan.normalizeIncomingPlan({
    summary: "overlap",
    tasks: [
      { id: "e1", kind: "edit", agent: "worker", goal: "one", dependsOn: [], allowedPaths: ["src/a.ts"] },
      { id: "e2", kind: "edit", agent: "worker", goal: "two", dependsOn: [], allowedPaths: ["src/"] },
    ],
  });
  assert.ok(plan.validatePlan(overlap).some((e) => e.code === "path_overlap"));
  ok("detects overlapping edit paths without deps");

  const ordered = plan.normalizeIncomingPlan({
    summary: "ordered overlap",
    tasks: [
      { id: "e1", kind: "edit", agent: "worker", goal: "one", dependsOn: [], allowedPaths: ["src/a.ts"] },
      { id: "e2", kind: "edit", agent: "worker", goal: "two", dependsOn: ["e1"], allowedPaths: ["src/"] },
    ],
  });
  assert.equal(plan.validatePlan(ordered).length, 0);
  ok("allows overlapping paths when ordered by deps");

  const noPaths = plan.normalizeIncomingPlan({
    summary: "missing paths",
    tasks: [{ id: "e1", kind: "edit", agent: "worker", goal: "x", dependsOn: [], allowedPaths: [] }],
  });
  assert.ok(plan.validatePlan(noPaths).some((e) => e.code === "paths"));
  ok("edit tasks require allowedPaths");

  const traversing = plan.normalizeIncomingPlan({
    summary: "unsafe paths",
    tasks: [
      {
        id: "e1",
        kind: "edit",
        agent: "worker",
        goal: "x",
        dependsOn: [],
        allowedPaths: ["../outside"],
      },
    ],
  });
  assert.ok(plan.validatePlan(traversing).some((e) => e.code === "paths"));
  ok("rejects parent-traversing allowedPaths");

  const wrongPhase = plan.normalizeIncomingPlan({
    summary: "wrong phase",
    tasks: [
      {
        id: "review",
        kind: "review",
        agent: "reviewer",
        goal: "review",
        dependsOn: [],
        allowedPaths: [],
      },
      {
        id: "edit",
        kind: "edit",
        agent: "worker",
        goal: "edit after review",
        dependsOn: ["review"],
        allowedPaths: ["src/"],
      },
    ],
  });
  assert.ok(plan.validatePlan(wrongPhase).some((e) => e.code === "phase_order"));
  ok("rejects edit depending on post-build task");

  const withQ = { ...good, openQuestions: ["Which API?"] };
  assert.equal(plan.canBuild(withQ, []).ok, false);
  assert.equal(plan.canBuild(good, []).ok, true);
  ok("open questions disable build");

  const r2 = plan.normalizeIncomingPlan(
    { summary: "v2", openQuestions: [], tasks: good.tasks },
    good,
  );
  assert.equal(r2.revision, 2);
  ok("plan revision increments");

  const ready = plan.readyTasks(good.tasks, new Set(["scout1"]), new Set());
  assert.deepEqual(
    ready.map((t) => t.id),
    ["edit1"],
  );
  ok("readyTasks respects deps");
}

// ── safe commands ──────────────────────────────────────────
{
  assert.equal(safe.isSafeCommand("git status"), true);
  assert.equal(safe.isSafeCommand("rg TODO src"), true);
  assert.equal(safe.isSafeCommand("rm -rf /"), false);
  assert.equal(safe.isSafeCommand("git commit -am x"), false);
  assert.equal(safe.isSafeCommand("echo hi > file"), false);
  ok("safe-command allowlist");
}

// ── agents ─────────────────────────────────────────────────
{
  const { agents: list } = agents.discoverAgents(ROOT, "builtin");
  const names = list.map((a) => a.name).sort();
  assert.ok(names.includes("scout"));
  assert.ok(names.includes("worker"));
  assert.ok(names.includes("reviewer"));
  assert.ok(names.includes("tester"));
  assert.equal(list.find((a) => a.name === "worker")?.mutating, true);
  assert.equal(list.find((a) => a.name === "scout")?.mutating, false);
  assert.equal(list.find((a) => a.name === "scout")?.model, undefined);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "orch-agents-"));
  fs.mkdirSync(path.join(project, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".pi", "agents", "scout.md"),
    [
      "---",
      "name: scout",
      "description: untrusted override",
      "tools: read, edit, write",
      "---",
      "",
      "override",
    ].join("\n"),
  );
  const overridden = agents.discoverAgents(project, "both").agents
    .find((agent) => agent.name === "scout");
  assert.equal(overridden.source, "project");
  assert.equal(overridden.mutating, true);
  ok("builtin agents discovered");
}

// ── workflow build gate ────────────────────────────────────
{
  const ctrl = new workflowMod.WorkflowController();
  assert.equal(ctrl.buildGate().ok, false);
  const p = plan.normalizeIncomingPlan({
    summary: "s",
    openQuestions: [],
    tasks: [
      { id: "e1", kind: "edit", agent: "worker", goal: "g", dependsOn: [], allowedPaths: ["a.ts"] },
    ],
  });
  ctrl.setPlan(p, "created");
  assert.equal(ctrl.buildGate().ok, true);
  assert.equal(ctrl.revisions[0].plan.revision, 1);
  assert.equal(ctrl.revisions[0].diff, "created");
  ctrl.agentRunning = true;
  assert.equal(ctrl.buildGate().ok, false);
  ctrl.agentRunning = false;

  // Fake pi for mode transitions
  let active = ["read", "bash", "edit", "write"];
  const fakePi = {
    getActiveTools: () => active,
    setActiveTools: (t) => {
      active = t;
    },
    appendEntry: () => {},
  };
  ctrl.enterAskOrPlan(fakePi, "plan");
  assert.equal(ctrl.mode, "plan");
  assert.ok(!active.includes("edit"));
  assert.ok(active.includes("submit_plan"));

  let rejected = false;
  try {
    // simulate tool rejection path conceptually — enterBuild is the only path
    const g = ctrl.enterBuild(fakePi);
    assert.equal(g.ok, true);
    assert.equal(ctrl.mode, "build");
    assert.ok(active.includes("edit"));
  } catch {
    rejected = true;
  }
  assert.equal(rejected, false);
  ok("workflow ask/plan tightens tools; build restores writes");
}

// ── config, UI, and extension registration ─────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-config-"));
  fs.mkdirSync(path.join(tmp, ".pi"));
  fs.writeFileSync(
    path.join(tmp, ".pi", "orchestrator.json"),
    JSON.stringify({ maxParallel: 99, maxTasks: 0, taskTimeoutMs: 1 }),
  );
  const loaded = configMod.loadConfig(tmp);
  assert.equal(loaded.maxParallel, 8);
  assert.equal(loaded.maxTasks, 8);
  assert.equal(loaded.taskTimeoutMs, 30_000);
  ok("config loads project overrides with bounds");

  const panelCtrl = new workflowMod.WorkflowController();
  const noPlanLines = uiMod.renderPanelLines(panelCtrl, {
    fg: (_color, text) => text,
    bold: (text) => text,
  });
  assert.ok(noPlanLines.some((line) => line.includes("Build disabled")));
  const panelPlan = plan.normalizeIncomingPlan({
    summary: "panel plan",
    openQuestions: [],
    tasks: [
      {
        id: "edit",
        kind: "edit",
        agent: "worker",
        goal: "edit",
        dependsOn: [],
        allowedPaths: ["src/"],
      },
    ],
  });
  panelCtrl.setPlan(panelPlan, "Created panel plan");
  const planLines = uiMod.renderPanelLines(panelCtrl, {
    fg: (_color, text) => text,
    bold: (text) => text,
  });
  assert.ok(planLines.some((line) => line.includes("[Build]")));
  assert.ok(planLines.some((line) => line.includes("Created panel plan")));
  ok("plan panel exposes build gate and revision diff");

  const tools = [];
  const commands = new Map();
  const hooks = new Map();
  const shortcuts = [];
  const entries = [];
  let activeTools = ["read", "bash", "edit", "write"];
  const fakePi = {
    registerTool(tool) { tools.push(tool); },
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut(key, shortcut) { shortcuts.push({ key, shortcut }); },
    registerFlag() {},
    on(name, handler) {
      const list = hooks.get(name) ?? [];
      list.push(handler);
      hooks.set(name, list);
    },
    getActiveTools() { return activeTools; },
    setActiveTools(next) { activeTools = next; },
    appendEntry(type, data) { entries.push({ type: "custom", customType: type, data }); },
    sendMessage() {},
    sendUserMessage() {},
    setModel: async () => true,
    setThinkingLevel() {},
  };
  const notifications = [];
  const widgets = new Map();
  const ctx = {
    cwd: ROOT,
    hasUI: true,
    model: { provider: "fake", id: "foreground" },
    modelRegistry: { find: () => undefined },
    sessionManager: { getEntries: () => entries },
    ui: {
      theme: {
        fg: (_color, text) => text,
        bold: (text) => text,
      },
      notify: (message, level) => notifications.push({ message, level }),
      setWidget: (key, value) => widgets.set(key, value),
      setStatus: () => {},
      confirm: async () => true,
      select: async () => "Cancel",
      editor: async () => "",
    },
  };
  const registerOrchestrator =
    orchestratorModule.default ?? orchestratorModule;
  registerOrchestrator(fakePi);
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["set_workflow_mode", "submit_plan", "dispatch_research"],
  );
  assert.ok(commands.has("plan"));
  assert.ok(commands.has("build"));
  assert.ok(commands.has("orchestrator"));
  assert.equal(shortcuts[0].key, "ctrl-alt-b");

  const modeTool = tools.find((tool) => tool.name === "set_workflow_mode");
  const askResult = await modeTool.execute(
    "mode",
    { mode: "ask", reason: "test" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(askResult.details.mode, "ask");
  assert.ok(!activeTools.includes("edit"));
  const rejectedBuild = await modeTool.execute(
    "mode",
    { mode: "build" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(rejectedBuild.isError, true);

  const submitTool = tools.find((tool) => tool.name === "submit_plan");
  const submitted = await submitTool.execute(
    "plan",
    {
      summary: "registered plan",
      goal: "test",
      openQuestions: [],
      tasks: [
        {
          id: "research",
          kind: "research",
          agent: "scout",
          goal: "research",
          dependsOn: [],
          allowedPaths: [],
        },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(submitted.details.buildReady, true);
  assert.ok(widgets.has("orchestrator-plan"));

  await hooks.get("before_agent_start")[0]({ systemPrompt: "base" }, ctx);
  await hooks.get("agent_end")[0]({}, ctx);
  assert.ok(entries.some((entry) => entry.customType === "orchestrator-state"));
  ok("extension registers tools, commands, mode gate, hooks, and shortcut");
}

// ── runner helpers ─────────────────────────────────────────
{
  const long = "x".repeat(60 * 1024);
  const t = runner.truncateOutput(long);
  assert.ok(t.includes("truncated"));
  assert.ok(Buffer.byteLength(t, "utf8") < 60 * 1024);
  const mapped = await runner.mapWithConcurrencyLimit([1, 2, 3, 4], 2, async (n) => n * 2);
  assert.deepEqual(mapped, [2, 4, 6, 8]);
  ok("runner truncate + concurrency pool");

  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-runner-"));
  const fakePi = path.join(fakeDir, "fake-pi.mjs");
  fs.writeFileSync(
    fakePi,
    `#!/usr/bin/env node
console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"fake ok"}],usage:{input:1,output:2,totalTokens:3,cost:{total:0}},model:"fake/model",stopReason:"stop"}}));
`,
    { mode: 0o755 },
  );
  const fakeResult = await runner.runSubagent({
    cwd: ROOT,
    command: fakePi,
    agent: {
      name: "fake",
      description: "fake",
      systemPrompt: "",
      source: "builtin",
      filePath: fakePi,
      mutating: false,
    },
    task: "hello",
    timeoutMs: 1_000,
  });
  assert.equal(fakeResult.exitCode, 0);
  assert.equal(fakeResult.stdoutText, "fake ok");
  assert.equal(fakeResult.model, "fake/model");
  ok("runner parses a real JSONL subprocess");

  const stubbornPi = path.join(fakeDir, "stubborn-pi.mjs");
  fs.writeFileSync(
    stubbornPi,
    `#!/usr/bin/env node
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  const abort = new AbortController();
  const stubbornRun = runner.runSubagent({
    cwd: ROOT,
    command: stubbornPi,
    agent: {
      name: "stubborn",
      description: "stubborn",
      systemPrompt: "",
      source: "builtin",
      filePath: stubbornPi,
      mutating: false,
    },
    task: "wait",
    signal: abort.signal,
    timeoutMs: 5_000,
    killGraceMs: 50,
  });
  setTimeout(() => abort.abort(), 50);
  const abortedResult = await stubbornRun;
  assert.equal(abortedResult.stopReason, "aborted");
  assert.notEqual(abortedResult.exitCode, 0);
  ok("runner escalates cancellation for SIGTERM-resistant workers");
}

// ── worker read-only guard ─────────────────────────────────
{
  const originalMode = process.env.PI_ORCHESTRATOR_WORKER_MODE;
  process.env.PI_ORCHESTRATOR_WORKER_MODE = "readonly";
  let hook;
  workerGuard.default({
    on: (name, handler) => {
      if (name === "tool_call") hook = handler;
    },
  });
  assert.ok(hook);
  assert.equal(
    (await hook({ toolName: "bash", input: { command: "git status" } })) ?? null,
    null,
  );
  assert.equal(
    (await hook({ toolName: "bash", input: { command: "rm -rf build" } })).block,
    true,
  );
  assert.equal(
    (await hook({ toolName: "write", input: {} })).block,
    true,
  );
  if (originalMode === undefined) delete process.env.PI_ORCHESTRATOR_WORKER_MODE;
  else process.env.PI_ORCHESTRATOR_WORKER_MODE = originalMode;
  ok("worker guard enforces read-only bash and tools");
}

// ── worktree isolation e2e ─────────────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-wt-"));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  execSync("git init", { cwd: repo, stdio: "ignore" });
  execSync('git -c user.email=t@t -c user.name=t checkout -b main', { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(repo, "b.ts"), "export const b = 1;\n");
  execSync('git add . && git -c user.email=t@t -c user.name=t commit -m init', {
    cwd: repo,
    stdio: "ignore",
  });
  const baseline = worktree.currentHeadSha(repo);
  assert.equal(worktree.isWorkingTreeClean(repo).clean, true);

  const slot1 = worktree.createTaskWorktree(repo, baseline, "t1", "run1");
  const slot2 = worktree.createTaskWorktree(repo, baseline, "t2", "run1");
  fs.writeFileSync(path.join(slot1.path, "a.ts"), "export const a = 2;\n");
  fs.writeFileSync(path.join(slot2.path, "b.ts"), "export const b = 2;\n");

  const ch1 = worktree.changedFiles(slot1.path, baseline);
  assert.deepEqual(ch1, ["a.ts"]);
  assert.equal(worktree.assertPathsAllowed(ch1, ["a.ts"]).ok, true);
  assert.equal(worktree.assertPathsAllowed(ch1, ["b.ts"]).ok, false);
  fs.writeFileSync(path.join(slot1.path, "new-outside.ts"), "new\n");
  assert.deepEqual(
    worktree.changedFiles(slot1.path, baseline),
    ["a.ts", "new-outside.ts"],
  );
  assert.equal(
    worktree.assertPathsAllowed(
      worktree.changedFiles(slot1.path, baseline),
      ["a.ts"],
    ).ok,
    false,
  );
  fs.rmSync(path.join(slot1.path, "new-outside.ts"));
  ok("worktree path boundary");

  // Parallel worktrees do not dirty main
  assert.equal(worktree.isWorkingTreeClean(repo).clean, true);
  ok("main stays clean during parallel worktrees");

  const c1 = worktree.commitWorktreeChanges(slot1.path, "t1");
  const c2 = worktree.commitWorktreeChanges(slot2.path, "t2");
  assert.ok(c1.committed && c1.sha);
  assert.ok(c2.committed && c2.sha);

  const integ = worktree.createIntegrationBranch(repo, baseline, "run1");
  assert.equal(worktree.cherryPickCommit(integ.path, c1.sha).ok, true);
  assert.equal(worktree.cherryPickCommit(integ.path, c2.sha).ok, true);
  const applied = worktree.applyAggregateAsUnstaged(repo, integ.path, baseline);
  assert.equal(applied.ok, true);
  assert.equal(fs.readFileSync(path.join(repo, "a.ts"), "utf-8"), "export const a = 2;\n");
  assert.equal(fs.readFileSync(path.join(repo, "b.ts"), "utf-8"), "export const b = 2;\n");
  // unstaged, not committed on main
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf-8" });
  assert.ok(status.trim().length > 0);
  const log = execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" });
  assert.ok(!log.includes("pi-orch:"));
  ok("aggregate apply leaves unstaged changes without main commits");

  // Conflict case: overlapping edits without polluting main after reset
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "orch-conflict-"));
  const repo2 = path.join(tmp2, "repo");
  fs.mkdirSync(repo2);
  execSync("git init", { cwd: repo2, stdio: "ignore" });
  execSync('git -c user.email=t@t -c user.name=t checkout -b main', { cwd: repo2, stdio: "ignore" });
  fs.writeFileSync(path.join(repo2, "c.ts"), "v1\n");
  execSync('git add . && git -c user.email=t@t -c user.name=t commit -m init', {
    cwd: repo2,
    stdio: "ignore",
  });
  const base2 = worktree.currentHeadSha(repo2);
  const sA = worktree.createTaskWorktree(repo2, base2, "ca", "runC");
  const sB = worktree.createTaskWorktree(repo2, base2, "cb", "runC");
  fs.writeFileSync(path.join(sA.path, "c.ts"), "from-A\n");
  fs.writeFileSync(path.join(sB.path, "c.ts"), "from-B\n");
  const shaA = worktree.commitWorktreeChanges(sA.path, "A").sha;
  const shaB = worktree.commitWorktreeChanges(sB.path, "B").sha;
  const integ2 = worktree.createIntegrationBranch(repo2, base2, "runC");
  assert.equal(worktree.cherryPickCommit(integ2.path, shaA).ok, true);
  const conflict = worktree.cherryPickCommit(integ2.path, shaB);
  assert.equal(conflict.ok, false);
  assert.equal(fs.readFileSync(path.join(repo2, "c.ts"), "utf-8"), "v1\n");
  assert.equal(worktree.isWorkingTreeClean(repo2).clean, true);
  ok("conflict does not pollute main worktree");

  worktree.cleanupOrchResources(repo, [slot1, slot2], integ);
  worktree.cleanupOrchResources(repo2, [sA, sB], integ2);
  const fallbackCleanup = worktree.createTaskWorktree(repo, baseline, "fallback", "run-clean");
  worktree.removeWorktree(repo, fallbackCleanup.path);
  const branches = execFileSync("git", ["branch", "--list", "pi-orch/*"], {
    cwd: repo,
    encoding: "utf-8",
  });
  assert.equal(branches.trim(), "");
  ok("cleanup removes orchestrator worktrees");
}

// ── scheduler dependency + integration ordering ────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "orch-scheduler-"));
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  execSync("git init", { cwd: repo, stdio: "ignore" });
  execSync("git -c user.email=t@t -c user.name=t checkout -b main", {
    cwd: repo,
    stdio: "ignore",
  });
  fs.writeFileSync(path.join(repo, "a.ts"), "a1\n");
  fs.writeFileSync(path.join(repo, "b.ts"), "b1\n");
  execSync(
    "git add . && git -c user.email=t@t -c user.name=t commit -m init",
    { cwd: repo, stdio: "ignore" },
  );

  const executionPlan = plan.normalizeIncomingPlan({
    summary: "dependency and review ordering",
    openQuestions: [],
    tasks: [
      {
        id: "research",
        kind: "research",
        agent: "scout",
        goal: "research",
        dependsOn: [],
        allowedPaths: [],
      },
      {
        id: "edit-a",
        kind: "edit",
        agent: "worker",
        goal: "EDIT_A",
        dependsOn: ["research"],
        allowedPaths: ["a.ts"],
      },
      {
        id: "edit-b",
        kind: "edit",
        agent: "worker",
        goal: "EDIT_B",
        dependsOn: ["edit-a"],
        allowedPaths: ["b.ts"],
      },
      {
        id: "review",
        kind: "review",
        agent: "reviewer",
        goal: "REVIEW",
        dependsOn: ["edit-b"],
        allowedPaths: [],
      },
    ],
  });
  const builtinAgents = agents.discoverAgents(ROOT, "builtin").agents;
  const seen = [];
  const fakeRunAgent = async (opts) => {
    seen.push({ task: opts.task, cwd: opts.cwd });
    if (opts.task.includes("EDIT_A")) {
      fs.writeFileSync(path.join(opts.cwd, "a.ts"), "a2\n");
    } else if (opts.task.includes("EDIT_B")) {
      assert.equal(fs.readFileSync(path.join(opts.cwd, "a.ts"), "utf-8"), "a2\n");
      fs.writeFileSync(path.join(opts.cwd, "b.ts"), "b2\n");
    } else if (opts.task.includes("REVIEW")) {
      assert.equal(fs.realpathSync(opts.cwd), fs.realpathSync(repo));
      assert.equal(fs.readFileSync(path.join(repo, "a.ts"), "utf-8"), "a2\n");
      assert.equal(fs.readFileSync(path.join(repo, "b.ts"), "utf-8"), "b2\n");
    }
    return {
      agent: opts.agent.name,
      task: opts.task,
      exitCode: 0,
      stdoutText: "ok",
      stderr: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 1,
      },
      stopReason: "stop",
      events: [],
    };
  };
  const result = await scheduler.executePlan({
    cwd: repo,
    plan: executionPlan,
    config: {
      maxParallel: 2,
      maxTasks: 8,
      taskTimeoutMs: 5_000,
      agentScope: "builtin",
    },
    hooks: {
      onUpdate: () => {},
      resolveAgent: (name) => builtinAgents.find((agent) => agent.name === name),
      researchTools: ["read"],
      editTools: ["read", "edit", "write"],
      runAgent: fakeRunAgent,
    },
  });
  assert.equal(result.status, "succeeded", JSON.stringify(result, null, 2));
  assert.equal(fs.readFileSync(path.join(repo, "a.ts"), "utf-8"), "a2\n");
  assert.equal(fs.readFileSync(path.join(repo, "b.ts"), "utf-8"), "b2\n");
  assert.ok(seen.find((item) => item.task.includes("REVIEW")));
  ok("scheduler carries edit dependencies and reviews integrated main changes");
}

console.log(`\n${passed} passed`);
