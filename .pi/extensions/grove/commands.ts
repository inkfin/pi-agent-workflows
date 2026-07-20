/**
 * grove/commands.ts — /grove command + session hooks
 *
 * Subcommands:
 *   /grove                 interactive jj-log style tree view
 *   /grove commit [label]  checkpoint the current session
 *   /grove goto <target>   move to a node (change-id prefix or label)
 *   /grove fork            fork the current session into a new branch node
 *   /grove status          current position, uncheckpointed turns, code state
 *   /grove log             non-interactive node list
 *   /grove undo            undo the last repo operation
 *   /grove merge <target>  context-inject a node's subtree into the current session
 *   /grove pick <target>   cherry-pick a node's content into the current session
 *   /grove sync            (Phase 3 stub)
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { JjCliBackend, JjUnavailableError } from "./backend/jj-cli";
import type { TreeBackend, GroveNode } from "./backend/types";
import {
  checkpointSession,
  recordFork,
  recordMerge,
  ensureSessionAvailable,
  nodeSummaryForInject,
  nodeForSession,
} from "./mapping/ops";
import { machineId, codeState } from "./lib/identity";
import { countSessionMessages } from "./lib/sessions";
import { GroveTreeView, type GroveViewResult } from "./ui/tree-view";

function findNode(nodes: GroveNode[], target: string): GroveNode | undefined {
  const lower = target.toLowerCase();
  return (
    nodes.find((n) => n.changeId.startsWith(target)) ??
    nodes.find((n) => n.manifest?.label === target) ??
    nodes.find((n) => n.manifest?.label.toLowerCase().includes(lower))
  );
}

export function setupGrove(pi: ExtensionAPI) {
  let backend: TreeBackend | null = null;
  let backendCwd: string | null = null;

  function getBackend(cwd: string): TreeBackend {
    if (!backend || backendCwd !== cwd) {
      backend = new JjCliBackend(cwd);
      backendCwd = cwd;
    }
    return backend;
  }

  // ── Session hooks: status bar + fork capture ─────────────────

  pi.on("session_start", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const be = getBackend(ctx.cwd);
    // Lazy: never create a repo just because pi started in a project.
    // The tree comes into existence on the first explicit grove operation.
    if (!fs.existsSync(path.join(be.repoDir(), ".jj"))) return;
    try {
      await JjCliBackend.checkAvailability();
    } catch {
      return; // jj missing: grove stays silent
    }
    const sessionFile = ctx.sessionManager.getSessionFile();

    if (event.reason === "fork" && sessionFile) {
      // Capture forks from any source (built-in /fork, ctx.fork, /grove fork).
      try {
        const nodes = await be.listNodes();
        const parentNode = event.previousSessionFile
          ? nodeForSession(nodes, event.previousSessionFile)
          : undefined;
        await recordFork(be, ctx.cwd, {
          sessionFile,
          entryId: ctx.sessionManager.getLeafId(),
          parentChangeId: parentNode?.changeId ?? (await be.currentChangeId()),
        });
      } catch (err: any) {
        ctx.ui.notify(`grove: fork capture failed: ${err?.message ?? err}`, "warning");
      }
    }

    if (ctx.hasUI) {
      try {
        const nodes = await be.listNodes();
        const node = nodeForSession(nodes, sessionFile);
        ctx.ui.setStatus("grove", node ? `◆ ${node.manifest?.label ?? "node"}` : "◇ untracked");
      } catch {
        /* repo not initialized yet */
      }
    }
  });

  // ── Command registration ─────────────────────────────────────

  pi.registerCommand("grove", {
    description: "Grove: jj-backed session tree (interactive view, commit, goto, fork, merge, pick, undo)",
    handler: async (args, ctx) => {
      const notify = ctx.ui.notify.bind(ctx.ui); // stale-ctx-safe error reporting
      try {
        await JjCliBackend.checkAvailability();
      } catch (err: any) {
        notify(err instanceof JjUnavailableError ? err.message : String(err), "error");
        return;
      }
      try {
        await handle(args, ctx, getBackend(ctx.cwd), pi);
      } catch (err: any) {
        notify(`/grove: ${err?.message ?? String(err)}`, "error");
      }
    },
  });
}

async function handle(
  args: string,
  ctx: ExtensionCommandContext,
  be: TreeBackend,
  pi: ExtensionAPI,
): Promise<void> {
  const sub = args.trim().split(/\s+/)[0] || "";
  const rest = args.trim().split(/\s+/).slice(1).join(" ");

  switch (sub) {
    case "commit":
    case "c": {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("No active session.", "error");
        return;
      }
      const label = rest || (await ctx.ui.input("Checkpoint label:"));
      if (!label) return;
      const node = await checkpointSession(be, ctx.cwd, {
        label,
        sessionFile,
        entryId: ctx.sessionManager.getLeafId(),
      });
      ctx.ui.setStatus("grove", `◆ ${label}`);
      ctx.ui.notify(`Checkpoint: ${label} (${node.changeId.slice(0, 8)})`, "success");
      break;
    }

    case "goto":
    case "go": {
      if (!rest) {
        ctx.ui.notify("Usage: /grove goto <change-id|label>", "error");
        return;
      }
      const nodes = await be.listNodes();
      const target = findNode(nodes, rest);
      if (!target?.manifest) {
        ctx.ui.notify(`Node not found: ${rest}`, "error");
        return;
      }
      await gotoNode(ctx, be, target);
      break;
    }

    case "fork":
    case "f": {
      const leafId = ctx.sessionManager.getLeafId();
      if (!leafId) {
        ctx.ui.notify("No active session entry to fork from.", "error");
        return;
      }
      // The session_start(reason:"fork") hook records the node — single path.
      const result = await ctx.fork(leafId, {
        withSession: async (replacementCtx) => {
          replacementCtx.ui.notify("Forked — node recorded in grove.", "success");
        },
      });
      if (result.cancelled) ctx.ui.notify("Fork cancelled.", "info");
      break;
    }

    case "status":
    case "st": {
      const nodes = await be.listNodes();
      const sessionFile = ctx.sessionManager.getSessionFile();
      const node = nodeForSession(nodes, sessionFile);
      const currentChange = await be.currentChangeId();
      const lines: string[] = [];
      lines.push(`machine: ${machineId()}`);
      lines.push(`tree repo: ${be.repoDir()}`);
      lines.push(`@ change: ${currentChange.slice(0, 12)}`);
      if (node?.manifest) {
        lines.push(`current node: ◆ ${node.manifest.label} (${node.changeId.slice(0, 8)})`);
        const tracked = node.manifest.sessionRef;
        const same = sessionFile && path.basename(sessionFile) === tracked;
        if (same && sessionFile) {
          const turns = countSessionMessages(sessionFile);
          lines.push(`session turns: ${turns} (snapshot at checkpoint time)`);
        }
      } else {
        lines.push("current session: untracked (no checkpoint yet)");
      }
      const code = codeState(ctx.cwd);
      if (code) lines.push(`code: ${code.rev.slice(0, 8)}${code.dirty ? " (dirty)" : ""}`);
      lines.push(`nodes: ${nodes.length}`);
      ctx.ui.notify(lines.join("\n"), "info");
      break;
    }

    case "log":
    case "ls": {
      const nodes = await be.listNodes();
      if (nodes.length === 0) {
        ctx.ui.notify("No nodes yet. Create one with /grove commit <label>.", "info");
        return;
      }
      const currentChange = await be.currentChangeId();
      const lines = nodes.map((n) => {
        const m = n.manifest;
        const at = n.changeId === currentChange ? "@" : " ";
        const glyph = m?.kind === "fork" ? "⑂" : m?.kind === "merge" ? "⊙" : "◆";
        const label = m?.label ?? "(non-grove)";
        return `${at} ${glyph} ${n.changeId.slice(0, 8)} ${label}${m?.origin ? ` · ${m.origin}` : ""}`;
      });
      ctx.ui.notify(lines.join("\n"), "info");
      break;
    }

    case "undo":
    case "u": {
      await be.undo();
      ctx.ui.notify("Undid the last tree operation (jj undo).", "success");
      break;
    }

    case "merge":
    case "m":
    case "pick":
    case "p": {
      if (!rest) {
        ctx.ui.notify(`Usage: /grove ${sub} <change-id|label>`, "error");
        return;
      }
      const nodes = await be.listNodes();
      const target = findNode(nodes, rest);
      if (!target?.manifest) {
        ctx.ui.notify(`Node not found: ${rest}`, "error");
        return;
      }
      const summary = await nodeSummaryForInject(be, target);
      const header = sub === "m" || sub === "merge" ? "Merged node" : "Cherry-picked node";
      pi.sendUserMessage(
        `## ${header}: ${target.manifest.label}\n\n${summary}\n\nConsider the above work as context for continuing the current task.`,
        { deliverAs: "followUp" },
      );
      if (sub === "m" || sub === "merge") {
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (sessionFile) {
          await recordMerge(be, ctx.cwd, {
            label: `merge: ${target.manifest.label}`,
            sessionFile,
            sourceChangeId: target.changeId,
          });
        }
      }
      ctx.ui.notify(`${header}: ${target.manifest.label}`, "success");
      break;
    }

    case "sync": {
      ctx.ui.notify("grove sync is Phase 3 — see TODO.md.", "info");
      break;
    }

    case "": {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Interactive tree view requires TUI mode.", "error");
        return;
      }
      const nodes = await be.listNodes();
      const sessionFile = ctx.sessionManager.getSessionFile();
      const currentChange = await be.currentChangeId();
      const currentRef = sessionFile ? path.basename(sessionFile) : null;

      const result: GroveViewResult | null = await ctx.ui.custom<GroveViewResult | null>(
        (_tui, theme, _kb, done) => {
          const view = new GroveTreeView(nodes, currentChange, currentRef, theme);
          view.setResolve((r) => done(r));
          return view;
        },
      );

      if (!result || result.action === "close") break;

      switch (result.action) {
        case "goto": {
          if (result.node) await gotoNode(ctx, be, result.node);
          break;
        }
        case "commit": {
          const label = await ctx.ui.input("Checkpoint label:");
          const sf = ctx.sessionManager.getSessionFile();
          if (label && sf) {
            const node = await checkpointSession(be, ctx.cwd, {
              label,
              sessionFile: sf,
              entryId: ctx.sessionManager.getLeafId(),
            });
            ctx.ui.setStatus("grove", `◆ ${label}`);
            ctx.ui.notify(`Checkpoint: ${label} (${node.changeId.slice(0, 8)})`, "success");
          }
          break;
        }
        case "fork": {
          // Fork always branches the CURRENT session. If the user picked a
          // different node in the view, they must goto it first.
          const currentRef = (() => {
            const sf = ctx.sessionManager.getSessionFile();
            return sf ? path.basename(sf) : null;
          })();
          if (result.node?.manifest && result.node.manifest.sessionRef !== currentRef) {
            ctx.ui.notify(
              `Fork branches the current session. Goto "${result.node.manifest.label}" first (press s), then fork.`,
              "info",
            );
            break;
          }
          const forkEntry =
            result.node?.manifest?.entryId ?? ctx.sessionManager.getLeafId();
          if (!forkEntry) {
            ctx.ui.notify("No active session entry to fork from.", "error");
            break;
          }
          await ctx.fork(forkEntry, {
            withSession: async (replacementCtx) => {
              replacementCtx.ui.notify("Forked — node recorded in grove.", "success");
            },
          });
          break;
        }
        case "merge":
        case "pick": {
          if (!result.node?.manifest) break;
          const summary = await nodeSummaryForInject(be, result.node);
          const header = result.action === "merge" ? "Merged node" : "Cherry-picked node";
          pi.sendUserMessage(
            `## ${header}: ${result.node.manifest.label}\n\n${summary}\n\nConsider the above work as context for continuing the current task.`,
            { deliverAs: "followUp" },
          );
          if (result.action === "merge") {
            const sf = ctx.sessionManager.getSessionFile();
            if (sf) {
              await recordMerge(be, ctx.cwd, {
                label: `merge: ${result.node.manifest.label}`,
                sessionFile: sf,
                sourceChangeId: result.node.changeId,
              });
            }
          }
          ctx.ui.notify(`${header}: ${result.node.manifest.label}`, "success");
          break;
        }
        case "undo": {
          await be.undo();
          ctx.ui.notify("Undid the last tree operation (jj undo).", "success");
          break;
        }
      }
      break;
    }

    default: {
      ctx.ui.notify(
        `Unknown subcommand: ${sub}\nUsage: /grove [commit|goto|fork|status|log|undo|merge|pick|sync]`,
        "error",
      );
      break;
    }
  }
}

/** Move to a node: repo @ first, then pi session alignment. */
async function gotoNode(
  ctx: ExtensionCommandContext,
  be: TreeBackend,
  target: GroveNode,
): Promise<void> {
  const m = target.manifest!;
  const availability = await ensureSessionAvailable(be, ctx.cwd, target);
  if (!availability) {
    ctx.ui.notify(
      `Session ${m.sessionRef} is not available locally and has no snapshot in the tree.`,
      "error",
    );
    return;
  }
  const currentSessionFile = ctx.sessionManager.getSessionFile();
  const targetChangeId = target.changeId;
  const targetLabel = m.label;
  const entryId = m.entryId;

  // Same-session target: in-place tree navigation is cheaper than a switch.
  if (currentSessionFile && availability.path === currentSessionFile) {
    await be.edit(targetChangeId);
    if (entryId) {
      await ctx.navigateTree(entryId, { summarize: true });
    }
    ctx.ui.notify(`@ → ${targetLabel}`, "success");
    return;
  }

  await be.edit(targetChangeId);
  await ctx.switchSession(availability.path, {
    withSession: async (replacementCtx) => {
      replacementCtx.ui.setStatus("grove", `◆ ${targetLabel}`);
      replacementCtx.ui.notify(
        `@ → ${targetLabel}${availability.materialized ? " (materialized from snapshot)" : ""}`,
        "success",
      );
    },
  });
}
