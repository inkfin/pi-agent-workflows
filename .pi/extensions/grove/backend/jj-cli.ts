/**
 * jj-backed GraphTransaction store.
 *
 * jj provides durable, syncable transaction history. Grove materializes its
 * own SessionNode/Edge graph and never treats jj parents as semantic edges.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  decodeTransaction,
  encodeTransaction,
  isEffectivelySealed,
  newDomainId,
  type AmendDraftOptions,
  type AttachmentRecord,
  type EdgeRecord,
  type GraphApplyOptions,
  type GraphApplyResult,
  type GraphRecord,
  type GraphTransaction,
  type GroveGraph,
  type GroveRevision,
  type MaterializedAttachment,
  type MaterializedEdge,
  type SessionNode,
  type SessionNodeRecord,
  type TreeBackend,
} from "./types";

const SEP = "\x1f";
const MIN_JJ_VERSION = "0.20.0";
const LOCK_STALE_MS = 2 * 60 * 1000;
const OBJECT_PATH_RE = /^objects\/[a-f0-9]{64}\.(?:jsonl|json)$/;

export class JjUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JjUnavailableError";
  }
}

export class GroveWriteConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroveWriteConflictError";
  }
}

function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map((x) => parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newer<T extends { revision: number }>(
  current: { value: T; ref: GroveRevision } | undefined,
  value: T,
  ref: GroveRevision,
): boolean {
  if (!current) return true;
  if (value.revision !== current.value.revision) return value.revision > current.value.revision;
  const byTime = ref.timestamp.localeCompare(current.ref.timestamp);
  return byTime > 0 || (byTime === 0 && ref.changeId.localeCompare(current.ref.changeId) > 0);
}

export class JjCliBackend implements TreeBackend {
  private readonly cwd: string;
  private readonly relDir = path.join(".pi", "tree");
  private queue: Promise<unknown> = Promise.resolve();

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  repoDir(): string {
    return path.join(this.cwd, this.relDir);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(fn);
    this.queue = pending.catch(() => {});
    return pending;
  }

  private run(args: string[], opts?: { cwd?: string }): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "jj",
        ["--no-pager", ...args],
        {
          cwd: opts?.cwd ?? this.repoDir(),
          maxBuffer: 64 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`jj ${args.join(" ")} failed: ${stderr.trim() || error.message}`));
          } else {
            resolve(stdout);
          }
        },
      );
    });
  }

  static async checkAvailability(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("jj", ["--version"], (error, stdout) => {
        if (error) {
          reject(new JjUnavailableError("jj not found. Install jujutsu (brew install jj) to use grove."));
          return;
        }
        const version = stdout.trim().replace(/^jj\s+/, "");
        if (compareVersion(version, MIN_JJ_VERSION) < 0) {
          reject(new JjUnavailableError(`jj ${version} is too old; grove needs >= ${MIN_JJ_VERSION}.`));
          return;
        }
        resolve(version);
      });
    });
  }

  async ensureRepo(): Promise<string> {
    const dir = this.repoDir();
    const readyPath = path.join(dir, ".grove-ready");
    if (fs.existsSync(path.join(dir, ".jj")) && fs.existsSync(readyPath)) return dir;
    const parent = path.dirname(dir);
    const lockPath = path.join(parent, "tree.init.lock");
    fs.mkdirSync(parent, { recursive: true });
    let acquired = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        fs.mkdirSync(lockPath);
        acquired = true;
        break;
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        try {
          if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
            fs.rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        await sleep(50);
      }
    }
    if (!acquired) throw new GroveWriteConflictError("grove: timed out initializing Tree Repo");
    try {
      if (fs.existsSync(path.join(dir, ".jj")) && fs.existsSync(readyPath)) return dir;
      if (!fs.existsSync(path.join(dir, ".jj"))) {
        await this.run(["git", "init", "--no-colocate", this.relDir], { cwd: this.cwd });
      }
      await this.run(["config", "set", "--repo", "user.name", "grove"]);
      await this.run(["config", "set", "--repo", "user.email", "grove@local"]);
      const createdAt = new Date().toISOString();
      const transaction: GraphTransaction = {
        v: 1,
        recordType: "transaction",
        txId: newDomainId("tx"),
        records: [],
        createdAt,
      };
      await this.run(["describe", "-m", encodeTransaction(transaction)]);
      fs.writeFileSync(
        path.join(dir, ".gitignore"),
        ["state.json", ".DS_Store", ".grove-ready", "journal/", "alignment.json", "outbox/"].join("\n") + "\n",
      );
      await this.run(["st"]);
      fs.writeFileSync(readyPath, "v1\n");
      return dir;
    } finally {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  }

  private async revisionsFromLog(revset: string): Promise<GroveRevision[]> {
    const template =
      `change_id ++ "${SEP}" ++ commit_id ++ "${SEP}" ++ description.first_line() ++ "${SEP}" ++` +
      `parents.map(|c| c.change_id()).join(",") ++ "${SEP}" ++` +
      `committer.timestamp().utc().format("%Y-%m-%dT%H:%M:%SZ") ++ "\n"`;
    const output = await this.run(["log", "--no-graph", "-r", revset, "-T", template]);
    const revisions: GroveRevision[] = [];
    for (const line of output.split("\n")) {
      if (!line) continue;
      const [changeId, commitId, description, parentsRaw, timestamp] = line.split(SEP);
      if (!changeId || !commitId || /^0+$/.test(commitId)) continue;
      revisions.push({
        changeId,
        commitId,
        parents: parentsRaw ? parentsRaw.split(",").filter(Boolean) : [],
        timestamp: timestamp || "",
        transaction: decodeTransaction(description ?? ""),
      });
    }
    return revisions;
  }

  private async transactionHeads(): Promise<string[]> {
    const revisions = (await this.revisionsFromLog("all()"))
      .filter((revision) => revision.transaction);
    const hasChildren = new Set(revisions.flatMap((revision) => revision.parents));
    return revisions
      .filter((revision) => !hasChildren.has(revision.changeId))
      .map((revision) => revision.changeId);
  }

  async currentChangeId(): Promise<string> {
    const output = await this.run(["log", "--no-graph", "-r", "@", "-T", 'change_id ++ "\n"']);
    return output.trim();
  }

  async currentOperationId(): Promise<string> {
    const output = await this.run(["op", "log", "--limit", "1", "-T", 'self.id() ++ "\n"']);
    return output.match(/[0-9a-f]{16,}/)?.[0] ?? output.trim().split(/\s+/).at(-1) ?? "";
  }

  async graphRevision(): Promise<string> {
    await this.ensureRepo();
    const commitIds = (await this.revisionsFromLog("all()"))
      .filter((revision) => revision.transaction)
      .map((revision) => revision.commitId)
      .sort();
    return createHash("sha256").update(commitIds.join("\n")).digest("hex");
  }

  private writeFiles(files: Record<string, string> | undefined): void {
    if (!files) return;
    for (const [relative, content] of Object.entries(files)) {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
        throw new Error(`grove: unsafe repo path ${relative}`);
      }
      const target = path.join(this.repoDir(), relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
  }

  private deleteFiles(files: string[] | undefined): void {
    for (const relative of files ?? []) {
      if (!OBJECT_PATH_RE.test(relative)) {
        throw new Error(`grove: refusing to delete non-object path ${relative}`);
      }
      fs.rmSync(path.join(this.repoDir(), relative), { force: true });
    }
  }

  private async acquireWriteLock(): Promise<() => void> {
    const lockPath = path.join(this.repoDir(), "journal", "write.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(
          path.join(lockPath, "owner.json"),
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
        );
        return () => fs.rmSync(lockPath, { recursive: true, force: true });
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const age = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (age > LOCK_STALE_MS) {
            fs.rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        await sleep(50);
      }
    }
    throw new GroveWriteConflictError("grove: timed out waiting for the Tree Repo writer");
  }

  async applyGraphTransaction(opts: GraphApplyOptions): Promise<GraphApplyResult> {
    return this.enqueue(async () => {
      await this.ensureRepo();
      const release = await this.acquireWriteLock();
      const preOpId = await this.currentOperationId();
      let mutated = false;
      try {
        const before = await this.graphRevision();
        if (opts.expectedGraphRevision && opts.expectedGraphRevision !== before) {
          throw new GroveWriteConflictError(
            `grove graph changed: expected ${opts.expectedGraphRevision}, got ${before}`,
          );
        }
        const transaction: GraphTransaction = {
          v: 1,
          recordType: "transaction",
          txId: newDomainId("tx"),
          expectedGraphRevision: opts.expectedGraphRevision,
          records: opts.records,
          createdAt: new Date().toISOString(),
        };
        const parents = await this.transactionHeads();
        await this.run(["new", ...(parents.length ? parents : [await this.currentChangeId()])]);
        mutated = true;
        this.deleteFiles(opts.deleteFiles);
        this.writeFiles(opts.files);
        await this.run(["describe", "-m", encodeTransaction(transaction)]);
        const revision = (await this.revisionsFromLog("@"))[0];
        if (!revision) throw new Error("grove: failed to read back GraphTransaction");
        return {
          transaction,
          revision,
          graphRevision: await this.graphRevision(),
        };
      } catch (error) {
        if (mutated) {
          try {
            await this.run(["op", "restore", preOpId]);
          } catch {
            /* coordinator journal retains the outer recovery intent */
          }
        }
        throw error;
      } finally {
        release();
      }
    });
  }

  async listRevisions(): Promise<GroveRevision[]> {
    await this.ensureRepo();
    return this.revisionsFromLog("all()");
  }

  async getGraph(): Promise<GroveGraph> {
    const revisions = await this.listRevisions();
    const nodes = new Map<string, { value: SessionNodeRecord; ref: GroveRevision }>();
    const edges = new Map<string, { value: EdgeRecord; ref: GroveRevision }>();
    const attachments = new Map<string, { value: AttachmentRecord; ref: GroveRevision }>();
    const dispositions = [];
    const frontiers = [];

    for (const revision of revisions) {
      for (const record of revision.transaction?.records ?? []) {
        if (record.recordType === "node") {
          const current = nodes.get(record.nodeId);
          if (newer(current, record, revision)) nodes.set(record.nodeId, { value: record, ref: revision });
        } else if (record.recordType === "edge") {
          const current = edges.get(record.edgeId);
          if (newer(current, record, revision)) edges.set(record.edgeId, { value: record, ref: revision });
        } else if (record.recordType === "attachment") {
          const current = attachments.get(record.attachmentId);
          if (!current || revision.changeId.localeCompare(current.ref.changeId) < 0) {
            attachments.set(record.attachmentId, { value: record, ref: revision });
          }
        } else if (record.recordType === "disposition") {
          dispositions.push(record);
        } else {
          frontiers.push(record);
        }
      }
    }

    const tombstoned = new Set(
      dispositions
        .filter((record) => record.targetType === "attachment" && record.action === "tombstoned")
        .map((record) => record.targetId),
    );
    return {
      revision: await this.graphRevision(),
      nodes: [...nodes.values()].map(({ value, ref }) => ({
        ...value,
        backendRef: {
          changeId: ref.changeId,
          commitId: ref.commitId,
          timestamp: ref.timestamp,
        },
      })),
      edges: [...edges.values()].map(({ value, ref }) => ({
        ...value,
        backendRef: {
          changeId: ref.changeId,
          commitId: ref.commitId,
          timestamp: ref.timestamp,
        },
      })),
      attachments: [...attachments.values()]
        .filter(({ value }) => !tombstoned.has(value.attachmentId))
        .map(({ value, ref }) => ({
          ...value,
          backendRef: {
            changeId: ref.changeId,
            commitId: ref.commitId,
            timestamp: ref.timestamp,
          },
        })),
      dispositions,
      frontiers,
    };
  }

  async getNode(nodeId: string): Promise<SessionNode | null> {
    return (await this.getGraph()).nodes.find((node) => node.nodeId === nodeId) ?? null;
  }

  async recordNode(opts: {
    node: SessionNodeRecord;
    edges?: EdgeRecord[];
    attachments?: AttachmentRecord[];
    files?: Record<string, string>;
    expectedGraphRevision?: string;
  }): Promise<SessionNode> {
    const graph = await this.getGraph();
    if (graph.nodes.some((node) => node.nodeId === opts.node.nodeId)) {
      throw new Error(`grove: node already exists: ${opts.node.nodeId}`);
    }
    await this.applyGraphTransaction({
      records: [opts.node, ...(opts.edges ?? []), ...(opts.attachments ?? [])],
      files: opts.files,
      expectedGraphRevision: opts.expectedGraphRevision ?? graph.revision,
    });
    const node = await this.getNode(opts.node.nodeId);
    if (!node) throw new Error(`grove: failed to materialize node ${opts.node.nodeId}`);
    return node;
  }

  async amendDraft(opts: AmendDraftOptions): Promise<SessionNode> {
    const graph = await this.getGraph();
    const current = graph.nodes.find((node) => node.nodeId === opts.nodeId);
    if (!current) throw new Error(`grove: node not found: ${opts.nodeId}`);
    if (current.revision !== opts.expectedRevision) {
      throw new GroveWriteConflictError(
        `grove node revision changed: expected ${opts.expectedRevision}, got ${current.revision}`,
      );
    }
    if (isEffectivelySealed(current, graph.edges)) {
      throw new GroveWriteConflictError(`grove: node ${opts.nodeId} is sealed`);
    }
    const { backendRef: _backendRef, ...record } = current;
    const next: SessionNodeRecord = {
      ...record,
      ...opts.patch,
      nodeId: current.nodeId,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    await this.applyGraphTransaction({
      records: [next, ...(opts.attachments ?? [])],
      files: opts.files,
      deleteFiles: opts.deleteFiles,
      expectedGraphRevision: opts.expectedGraphRevision ?? graph.revision,
    });
    return (await this.getNode(opts.nodeId))!;
  }

  async appendEdge(opts: {
    edge: EdgeRecord;
    expectedGraphRevision?: string;
  }): Promise<MaterializedEdge> {
    const graph = await this.getGraph();
    if (!graph.nodes.some((node) => node.nodeId === opts.edge.fromNodeId)) {
      throw new Error(`grove: edge source missing: ${opts.edge.fromNodeId}`);
    }
    if (!graph.nodes.some((node) => node.nodeId === opts.edge.toNodeId)) {
      throw new Error(`grove: edge target missing: ${opts.edge.toNodeId}`);
    }
    await this.applyGraphTransaction({
      records: [opts.edge],
      expectedGraphRevision: opts.expectedGraphRevision ?? graph.revision,
    });
    return (await this.getGraph()).edges.find((edge) => edge.edgeId === opts.edge.edgeId)!;
  }

  async deleteEdge(opts: {
    edgeId: string;
    expectedGraphRevision?: string;
  }): Promise<MaterializedEdge> {
    const graph = await this.getGraph();
    const edge = graph.edges.find((candidate) => candidate.edgeId === opts.edgeId);
    if (!edge) throw new Error(`grove: edge not found: ${opts.edgeId}`);
    const { backendRef: _backendRef, ...record } = edge;
    const deleted: EdgeRecord = {
      ...record,
      revision: edge.revision + 1,
      state: "deleted",
      createdAt: new Date().toISOString(),
    };
    await this.applyGraphTransaction({
      records: [deleted],
      expectedGraphRevision: opts.expectedGraphRevision ?? graph.revision,
    });
    return (await this.getGraph()).edges.find((candidate) => candidate.edgeId === opts.edgeId)!;
  }

  async appendAttachment(opts: {
    attachment: AttachmentRecord;
    files?: Record<string, string>;
    expectedGraphRevision?: string;
  }): Promise<MaterializedAttachment> {
    const graph = await this.getGraph();
    const existing = graph.attachments.find(
      (attachment) => attachment.attachmentId === opts.attachment.attachmentId,
    );
    if (existing) return existing;
    if (
      graph.dispositions.some(
        (record) =>
          record.targetType === "attachment" &&
          record.targetId === opts.attachment.attachmentId &&
          record.action === "tombstoned",
      )
    ) {
      throw new Error(`grove: attachment was tombstoned: ${opts.attachment.attachmentId}`);
    }
    if (!graph.nodes.some((node) => node.nodeId === opts.attachment.targetNodeId)) {
      throw new Error(`grove: attachment target missing: ${opts.attachment.targetNodeId}`);
    }
    await this.applyGraphTransaction({
      records: [opts.attachment],
      files: opts.files,
      expectedGraphRevision: opts.expectedGraphRevision ?? graph.revision,
    });
    return (await this.getGraph()).attachments.find(
      (attachment) => attachment.attachmentId === opts.attachment.attachmentId,
    )!;
  }

  async showFile(rev: string, relative: string): Promise<string | null> {
    try {
      return await this.run(["file", "show", "-r", rev, relative]);
    } catch {
      return null;
    }
  }

  async edit(changeId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.run(["edit", changeId]);
    });
  }

  async gotoNode(nodeId: string): Promise<void> {
    const node = await this.getNode(nodeId);
    if (!node) throw new Error(`grove: node not found: ${nodeId}`);
    await this.edit(node.backendRef.changeId);
  }

  async undo(): Promise<void> {
    return this.enqueue(async () => {
      await this.run(["undo"]);
    });
  }

  async restoreOperation(opId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.run(["op", "restore", opId]);
    });
  }

  async setBookmark(name: string, changeId: string): Promise<void> {
    return this.enqueue(async () => {
      try {
        await this.run(["bookmark", "set", name, "-r", changeId]);
      } catch {
        await this.run(["bookmark", "create", name, "-r", changeId]);
      }
    });
  }

  async listBookmarks(): Promise<Array<{ name: string; changeId: string }>> {
    await this.ensureRepo();
    const output = await this.run([
      "bookmark",
      "list",
      "-T",
      `name ++ "${SEP}" ++ normal_target.change_id() ++ "\\n"`,
    ]);
    return output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, changeId] = line.split(SEP);
        return { name, changeId };
      })
      .filter((bookmark) => Boolean(bookmark.name && bookmark.changeId));
  }

  async ensureRemote(name: string, url: string): Promise<void> {
    return this.enqueue(async () => {
      await this.ensureRepo();
      try {
        await this.run(["git", "remote", "add", name, url]);
      } catch {
        await this.run(["git", "remote", "set-url", name, url]);
      }
    });
  }

  async gitPush(opts: { remote: string; bookmark: string }): Promise<void> {
    return this.enqueue(async () => {
      await this.run(["git", "push", "--remote", opts.remote, "--bookmark", opts.bookmark]);
    });
  }

  async gitFetch(opts: { remote: string }): Promise<void> {
    return this.enqueue(async () => {
      await this.run(["git", "fetch", "--remote", opts.remote]);
    });
  }
}
