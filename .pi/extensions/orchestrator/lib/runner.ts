/**
 * orchestrator/lib/runner.ts — spawn pi --mode json subagents
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "./agents";

export interface RunnerUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface RunnerResult {
  agent: string;
  task: string;
  exitCode: number;
  stdoutText: string;
  stderr: string;
  usage: RunnerUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  events: unknown[];
}

export interface RunnerOptions {
  cwd: string;
  agent: AgentConfig;
  task: string;
  modelOverride?: string;
  toolsOverride?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  killGraceMs?: number;
  onUpdate?: (partial: RunnerResult) => void;
  /** Enables edit/write and unrestricted bash inside an isolated worktree. */
  mutating?: boolean;
  /** Test seam for a fake Pi executable. */
  command?: string;
}

const PER_TASK_OUTPUT_CAP = 50 * 1024;

function getPiInvocation(
  args: string[],
  command?: string,
): { command: string; args: string[] } {
  // Prefer the same pi binary the host is running
  return { command: command ?? "pi", args };
}

function workerGuardPath(): string {
  try {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "worker-guard.ts");
  } catch {
    return path.join(
      process.cwd(),
      ".pi",
      "extensions",
      "orchestrator",
      "worker-guard.ts",
    );
  }
}

function getFinalAssistantText(events: any[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    const msg = ev?.message ?? ev;
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) return part.text;
      }
    }
  }
  return "";
}

export function truncateOutput(output: string): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;
  let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

async function writePromptFile(name: string, prompt: string): Promise<{ dir: string; file: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-orch-prompt-"));
  const file = path.join(dir, `prompt-${name.replace(/[^\w.-]+/g, "_")}.md`);
  await fs.promises.writeFile(file, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir, file };
}

export async function runSubagent(opts: RunnerOptions): Promise<RunnerResult> {
  const model = opts.modelOverride || opts.agent.model;
  const tools = opts.toolsOverride || opts.agent.tools;
  const args: string[] = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--extension",
    workerGuardPath(),
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
  ];
  if (model) args.push("--model", model);
  if (tools && tools.length) args.push("--tools", tools.join(","));

  let tmpDir: string | null = null;
  let tmpFile: string | null = null;

  const result: RunnerResult = {
    agent: opts.agent.name,
    task: opts.task,
    exitCode: 0,
    stdoutText: "",
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model,
    events: [],
  };

  const emit = () => {
    result.stdoutText = truncateOutput(getFinalAssistantText(result.events as any[]));
    opts.onUpdate?.(result);
  };

  try {
    if (opts.agent.systemPrompt.trim()) {
      const tmp = await writePromptFile(opts.agent.name, opts.agent.systemPrompt);
      tmpDir = tmp.dir;
      tmpFile = tmp.file;
      args.push("--append-system-prompt", tmpFile);
    }
    args.push(`Task: ${opts.task}`);

    let wasAborted = false;
    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args, opts.command);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: opts.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PI_ORCHESTRATOR_WORKER_MODE: opts.mutating ? "edit" : "readonly",
        },
      });
      let buffer = "";
      let timer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let closed = false;

      const killProc = () => {
        if (closed) return;
        wasAborted = true;
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!closed) proc.kill("SIGKILL");
        }, opts.killGraceMs ?? 5000);
      };

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(killProc, opts.timeoutMs);
      }

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        result.events.push(event);

        if (event.type === "message_end" && event.message) {
          const msg = event.message;
          if (msg.role === "assistant") {
            result.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              result.usage.input += usage.input || 0;
              result.usage.output += usage.output || 0;
              result.usage.cacheRead += usage.cacheRead || 0;
              result.usage.cacheWrite += usage.cacheWrite || 0;
              result.usage.cost += usage.cost?.total || 0;
              result.usage.contextTokens = usage.totalTokens || 0;
            }
            if (msg.model) result.model = msg.model;
            if (msg.stopReason) result.stopReason = msg.stopReason;
            if (msg.errorMessage) result.errorMessage = msg.errorMessage;
          }
          emit();
        }
        if (event.type === "tool_result_end" || event.type === "message_update") {
          emit();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        result.stderr += data.toString();
      });
      proc.on("close", (code) => {
        closed = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? (wasAborted ? 1 : 0));
      });
      proc.on("error", (error) => {
        closed = true;
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        result.errorMessage = error.message;
        resolve(1);
      });

      if (opts.signal) {
        if (opts.signal.aborted) killProc();
        else opts.signal.addEventListener("abort", killProc, { once: true });
      }
    });

    result.exitCode = exitCode;
    result.stdoutText = truncateOutput(getFinalAssistantText(result.events as any[]));
    if (wasAborted) {
      result.stopReason = "aborted";
      result.errorMessage = result.errorMessage || "Subagent was aborted";
    }
    return result;
  } finally {
    if (tmpFile) {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
    }
    if (tmpDir) {
      try {
        fs.rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }
    }
  }
}

export function isFailedResult(result: RunnerResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  limit: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  const results = new Array<TOut>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
