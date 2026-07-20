/**
 * grove/backend/jj-cli.ts — TreeBackend implementation via jj CLI (ADR-0001)
 *
 * Verified against jj 0.43:
 * - `jj git init <dir>` (git-backed storage)
 * - `jj new [parents...]` / `jj describe -m <json>` / `jj edit <changeid>`
 * - `jj log --no-graph -T <template with \x1f separators>`
 * - `jj file show -r <rev> <path>` / `jj undo`
 *
 * All operations are serialized through an in-process queue (naive concurrency).
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  encodeManifest,
  decodeManifest,
  type TreeBackend,
  type GroveNode,
  type CommitNodeOpts,
} from "./types";

const SEP = "\x1f";
const MIN_JJ_VERSION = "0.20.0";

export class JjUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JjUnavailableError";
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

export class JjCliBackend implements TreeBackend {
  private cwd: string;
  private relDir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(cwd: string) {
    this.cwd = cwd;
    this.relDir = path.join(".pi", "tree");
  }

  repoDir(): string {
    return path.join(this.cwd, this.relDir);
  }

  /** Serialize repo operations (naive concurrency model). */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
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
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`jj ${args.join(" ")} failed: ${stderr.trim() || err.message}`));
          } else {
            resolve(stdout);
          }
        },
      );
    });
  }

  /** Check jj availability and minimum version. Throws JjUnavailableError. */
  static async checkAvailability(): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("jj", ["--version"], (err, stdout) => {
        if (err) {
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
    if (fs.existsSync(path.join(dir, ".jj"))) return dir;
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await this.run(["git", "init", "--no-colocate", this.relDir], { cwd: this.cwd });
    // Local identity so nodes can be created/pushed without global jj config.
    await this.run(["config", "set", "--repo", "user.name", "grove"]);
    await this.run(["config", "set", "--repo", "user.email", "grove@local"]);
    // Turn the initial empty commit into the tree's root node so every
    // real node hangs off a labeled genesis point.
    await this.run([
      "describe",
      "-m",
      JSON.stringify({
        v: 1,
        kind: "root",
        label: "root",
        sessionRef: "",
        entryId: null,
        project: { name: "" },
        origin: "",
        createdAt: new Date().toISOString(),
      }),
    ]);
    // Keep the working copy clean: legacy state.json and OS noise stay
    // out of tree history.
    fs.writeFileSync(path.join(dir, ".gitignore"), "state.json\n.DS_Store\n");
    await this.run(["st"]); // snapshot the .gitignore
    return dir;
  }

  private nodeFromLog(revset: string): Promise<GroveNode[]> {
    const template =
      `change_id ++ "${SEP}" ++ commit_id ++ "${SEP}" ++ description.first_line() ++ "${SEP}" ++` +
      `parents.map(|c| c.change_id()).join(",") ++ "${SEP}" ++` +
      `committer.timestamp().utc().format("%Y-%m-%dT%H:%M:%SZ") ++ "\n"`;
    return this.run(["log", "--no-graph", "-r", revset, "-T", template]).then((out) => {
      const nodes: GroveNode[] = [];
      for (const line of out.split("\n")) {
        if (!line) continue;
        const [changeId, commitId, description, parentsRaw, timestamp] = line.split(SEP);
        if (!changeId || !commitId) continue;
        if (/^0+$/.test(commitId)) continue; // jj virtual root
        nodes.push({
          changeId,
          commitId,
          parents: parentsRaw ? parentsRaw.split(",").filter(Boolean) : [],
          timestamp: timestamp || "",
          manifest: decodeManifest(description ?? ""),
        });
      }
      return nodes;
    });
  }

  async currentChangeId(): Promise<string> {
    const out = await this.run(["log", "--no-graph", "-r", "@", "-T", 'change_id ++ "\n"']);
    return out.trim();
  }

  async commitNode(opts: CommitNodeOpts): Promise<GroveNode> {
    return this.enqueue(async () => {
      await this.ensureRepo();
      const parents = opts.parents?.length ? opts.parents : [await this.currentChangeId()];

      // 1. Create a fresh change on the parents.
      await this.run(["new", ...parents]);

      // 2. Write files into the working copy (snapshotted by the next jj command).
      if (opts.files) {
        for (const [rel, content] of Object.entries(opts.files)) {
          const fp = path.join(this.repoDir(), rel);
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, content);
        }
      }

      // 3. Describe: stores the manifest and snapshots the files in one step.
      await this.run(["describe", "-m", encodeManifest(opts.manifest)]);

      const nodes = await this.nodeFromLog("@");
      const node = nodes[0];
      if (!node) throw new Error("grove: failed to read back committed node");
      return node;
    });
  }

  async listNodes(): Promise<GroveNode[]> {
    await this.ensureRepo();
    return this.nodeFromLog("all()");
  }

  async showFile(rev: string, relPath: string): Promise<string | null> {
    try {
      return await this.run(["file", "show", "-r", rev, relPath]);
    } catch {
      return null;
    }
  }

  async edit(changeId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.run(["edit", changeId]);
    });
  }

  async undo(): Promise<void> {
    return this.enqueue(async () => {
      await this.run(["undo"]);
    });
  }
}
