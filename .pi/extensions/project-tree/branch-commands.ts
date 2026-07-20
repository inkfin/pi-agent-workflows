/**
 * project-tree/branch-commands.ts — Register /branch commands
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  loadTree,
  saveTree,
  findBranch,
  getCurrentBranch,
  createBranch,
  archiveBranch,
  touchBranch,
  buildTree,
  listProjectSessions,
  countSessionMessages,
  sessionLastModified,
  type Branch,
  type ProjectTree,
} from "./state";
import { TreeView, type TreeViewResult } from "./ui/tree-view";
import { uuid } from "../shared/utils";
import * as path from "node:path";
import * as fs from "node:fs";

// ─── Auto-register current session as a branch ──────────────

/**
 * Ensure the current session is tracked in the project tree.
 * Called on session_start.
 * If the session file is not in the tree, auto-create a "main" branch
 * or add it as a child of the appropriate parent.
 */
function ensureCurrentSessionInTree(cwd: string, sessionFile: string | null): void {
  if (!sessionFile) return;

  const tree = loadTree(cwd);
  const existing = tree.branches.find((b) => b.sessionFile === sessionFile);
  if (existing) {
    touchBranch(tree, existing.id);
    saveTree(cwd, tree);
    return;
  }

  // New session not in tree — auto-register
  // If no branches exist, make it "main"
  if (tree.branches.length === 0) {
    createBranch(tree, {
      name: "main",
      sessionFile,
      description: "Initial branch",
    });
    saveTree(cwd, tree);
    return;
  }

  // If branches exist but this session is new, register with a generated name
  const name = `branch-${tree.branches.length + 1}`;
  createBranch(tree, {
    name,
    sessionFile,
    description: "Auto-registered session",
  });
  saveTree(cwd, tree);
}

// ─── Command Registration ───────────────────────────────────

export function setupBranchCommands(pi: ExtensionAPI) {
  // Auto-register current session on start
  pi.on("session_start", (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    ensureCurrentSessionInTree(ctx.cwd, sessionFile);
    if (ctx.hasUI) {
      const tree = loadTree(ctx.cwd);
      const current = getCurrentBranch(tree, sessionFile);
      ctx.ui.setStatus("branch", current?.name || "?");
    }
  });

  // Helper to register commands
  function register(
    name: string,
    opts: {
      description: string;
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
    },
  ) {
    pi.registerCommand(name, {
      description: opts.description,
      handler: async (args, ctx) => {
        try {
          await opts.handler(args, ctx);
        } catch (err: any) {
          ctx.ui.notify(`/branch ${name}: ${err?.message ?? String(err)}`, "error");
        }
      },
    });
  }

  // ── /branch ───────────────────────────────────────────────
  register("branch", {
    description: "Open the project tree (interactive branch browser)",
    handler: async (args, ctx) => {
      const sub = args.trim().split(/\s+/)[0] || "";
      const rest = args.trim().split(/\s+/).slice(1).join(" ");

      switch (sub) {
        case "create":
        case "c": {
          const name = rest;
          if (!name) {
            ctx.ui.notify("Usage: /branch create <name> [description]", "error");
            return;
          }

          const currentSessionFile = ctx.sessionManager.getSessionFile();
          if (!currentSessionFile) {
            ctx.ui.notify("No active session.", "error");
            return;
          }

          const tree = loadTree(ctx.cwd);
          const currentBranch = getCurrentBranch(tree, currentSessionFile);

          // Create a new session via fork
          const forkResult = await ctx.fork(
            ctx.sessionManager.getLeafId() || "",
            { withSession: async (replacementCtx) => {
              const newSessionFile = replacementCtx.sessionManager.getSessionFile();
              if (newSessionFile) {
                const newTree = loadTree(ctx.cwd);
                createBranch(newTree, {
                  name,
                  sessionFile: newSessionFile,
                  parentBranchId: currentBranch?.id ?? null,
                  parentEntryId: ctx.sessionManager.getLeafId(),
                  description: rest.split(" ").slice(1).join(" ") || undefined,
                });
                saveTree(ctx.cwd, newTree);
                replacementCtx.ui.notify(
                  `Branch created: ${name}${currentBranch ? ` (from ${currentBranch.name})` : ""}`,
                  "success",
                );
              }
            }},
          );

          if (forkResult.cancelled) {
            ctx.ui.notify("Branch creation cancelled.", "info");
          }
          break;
        }

        case "switch":
        case "s": {
          const name = rest;
          if (!name) {
            ctx.ui.notify("Usage: /branch switch <name>", "error");
            return;
          }

          const tree = loadTree(ctx.cwd);
          const target = findBranch(tree, name);
          if (!target) {
            ctx.ui.notify(`Branch not found: ${name}. Use /branch to list branches.`, "error");
            return;
          }

          const currentSessionFile = ctx.sessionManager.getSessionFile();
          if (target.sessionFile === currentSessionFile) {
            ctx.ui.notify(`Already on branch: ${target.name}`, "info");
            return;
          }

          // Switch to the target session
          await ctx.switchSession(target.sessionFile, {
            withSession: async (replacementCtx) => {
              const t = loadTree(ctx.cwd);
              touchBranch(t, target.id);
              saveTree(ctx.cwd, t);
              replacementCtx.ui.notify(`Switched to: ${target.name}`, "success");
            },
          });
          break;
        }

        case "rename":
        case "rn": {
          const tree = loadTree(ctx.cwd);
          const currentSessionFile = ctx.sessionManager.getSessionFile();
          const branch = getCurrentBranch(tree, currentSessionFile);

          if (!branch) {
            ctx.ui.notify("Current session is not tracked as a branch.", "error");
            return;
          }

          const newName = rest || "";
          if (!newName) {
            ctx.ui.notify("Usage: /branch rename <new-name>", "error");
            return;
          }

          // Check for duplicates
          if (tree.branches.some((b) => b.name === newName && b.id !== branch.id)) {
            ctx.ui.notify(`Branch "${newName}" already exists.`, "error");
            return;
          }

          branch.name = newName;
          saveTree(ctx.cwd, tree);
          ctx.ui.setStatus("branch", newName);
          ctx.ui.notify(`Renamed to: ${newName}`, "success");
          break;
        }

        case "archive":
        case "ar": {
          const name = rest;
          const tree = loadTree(ctx.cwd);
          let target: Branch | undefined;

          if (name) {
            target = findBranch(tree, name);
          } else {
            const currentSessionFile = ctx.sessionManager.getSessionFile();
            target = getCurrentBranch(tree, currentSessionFile);
          }

          if (!target) {
            ctx.ui.notify(`Branch not found: ${name || "(current)"}`, "error");
            return;
          }

          // Don't archive if it has active children
          const children = tree.branches.filter(
            (b) => b.parentBranchId === target!.id && b.status === "active",
          );
          if (children.length > 0) {
            ctx.ui.notify(
              `Cannot archive: ${target.name} has ${children.length} active child branch(es). Archive them first.`,
              "error",
            );
            return;
          }

          const confirmed = await ctx.ui.confirm(
            "Archive branch?",
            `Archive "${target.name}"? It will be hidden from the tree (not deleted).`,
          );
          if (!confirmed) return;

          archiveBranch(tree, target.id);
          saveTree(ctx.cwd, tree);
          ctx.ui.notify(`Archived: ${target.name}`, "success");
          break;
        }

        case "list":
        case "ls": {
          const tree = loadTree(ctx.cwd);
          const nodes = buildTree(tree);
          const currentSessionFile = ctx.sessionManager.getSessionFile();
          const currentBranch = getCurrentBranch(tree, currentSessionFile);

          const lines: string[] = [];
          lines.push(`Project: ${tree.projectName} (${tree.branches.filter((b) => b.status === "active").length} active)`);
          lines.push("");

          const render = (node: typeof nodes[0], depth: number, isLast: boolean) => {
            const b = node.branch;
            const isCur = b.id === currentBranch?.id;
            const prefix = "  ".repeat(depth) + (depth > 0 ? (isLast ? "└─ " : "├─ ") : "");
            const marker = isCur ? "●" : (b.source === "remote" ? "○" : "●");
            const msgs = countSessionMessages(b.sessionFile);
            const ago = sessionLastModified(b.sessionFile);
            const age = ago.startsWith("1970") ? "" : ` · ${timeAgoShort(ago)}`;

            lines.push(`${prefix}${marker} ${isCur ? `[${b.name}]` : b.name}${msgs > 0 ? ` (${msgs} msg${age})` : ""}`);

            for (let i = 0; i < node.children.length; i++) {
              render(node.children[i], depth + 1, i === node.children.length - 1);
            }
          };

          for (let i = 0; i < nodes.length; i++) {
            render(nodes[i], 0, i === nodes.length - 1);
          }

          lines.push("");
          lines.push("Use /branch to open interactive tree view.");
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        case "":
        default: {
          // Open interactive tree view
          if (ctx.mode !== "tui") {
            ctx.ui.notify("Interactive tree view requires TUI mode.", "error");
            return;
          }

          const tree = loadTree(ctx.cwd);
          const currentSessionFile = ctx.sessionManager.getSessionFile();

          const result: TreeViewResult | null = await ctx.ui.custom<TreeViewResult | null>(
            (tui, theme, _kb, done) => {
              const view = new TreeView(tree, currentSessionFile, theme);
              view.setResolve((r) => done(r));
              tui.on("resize", () => view.invalidate());
              return view;
            },
          );

          if (!result || result.action === "close") break;

          // Handle tree view result actions
          switch (result.action) {
            case "switch": {
              if (result.branch?.sessionFile) {
                await ctx.switchSession(result.branch.sessionFile, {
                  withSession: async (replacementCtx) => {
                    const t = loadTree(ctx.cwd);
                    touchBranch(t, result.branch!.id);
                    saveTree(ctx.cwd, t);
                    replacementCtx.ui.notify(`Switched to: ${result.branch!.name}`, "success");
                  },
                });
              }
              break;
            }

            case "merge": {
              if (result.branch) {
                await mergeBranchIntoCurrent(pi, ctx, result.branch);
              }
              break;
            }

            case "create": {
              ctx.ui.notify("Use /branch create <name> to create a new branch.", "info");
              break;
            }

            case "archive": {
              if (result.branch) {
                const confirmed = await ctx.ui.confirm(
                  "Archive?",
                  `Archive branch "${result.branch.name}"?`,
                );
                if (confirmed) {
                  const t = loadTree(ctx.cwd);
                  archiveBranch(t, result.branch.id);
                  saveTree(ctx.cwd, t);
                  ctx.ui.notify(`Archived: ${result.branch.name}`, "success");
                }
              }
              break;
            }

            case "rename": {
              if (result.branch) {
                const newName = await ctx.ui.input("Rename branch to:");
                if (newName) {
                  const t = loadTree(ctx.cwd);
                  const b = findBranch(t, result.branch.id);
                  if (b) {
                    b.name = newName;
                    saveTree(ctx.cwd, t);
                    ctx.ui.notify(`Renamed to: ${newName}`, "success");
                  }
                }
              }
              break;
            }

            default:
              break;
          }

          break;
        }
      }
    },
  });
}

// ─── Merge Helper ────────────────────────────────────────────

async function mergeBranchIntoCurrent(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  source: Branch,
): Promise<void> {
  // Read the source session to get a summary of its work
  const msgs = countSessionMessages(source.sessionFile);
  const sourceTree = loadTree(ctx.cwd);
  const sourceBranch = findBranch(sourceTree, source.id);

  if (!sourceBranch) {
    ctx.ui.notify("Source branch not found in tree.", "error");
    return;
  }

  // Build a context injection prompt
  const summary = [
    `## Merged Branch: ${sourceBranch.name}`,
    sourceBranch.description ? `\nDescription: ${sourceBranch.description}` : "",
    `\nMessages: ${msgs}`,
    `\nLast active: ${sourceBranch.lastActiveAt || sessionLastModified(sourceBranch.sessionFile)}`,
    "",
    "This branch's content has been merged. Please consider the work done in this branch when continuing the current work.",
  ].filter(Boolean).join("\n");

  // Inject as a user message
  pi.sendUserMessage(summary, { deliverAs: "followUp" });
  ctx.ui.notify(`Merged ${sourceBranch.name} into current branch.`, "success");
}

// ─── Helpers ─────────────────────────────────────────────────

function timeAgoShort(iso: string): string {
  if (!iso || iso.startsWith("1970")) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
