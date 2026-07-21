/**
 * commands/index.ts — Pi extension: common workflow commands
 *
 * Registers:
 *   /review     — Code review
 *   /commit     — Generate/apply commit message
 *   /todo       — Project task management
 *   /context    — View/edit project context files
 *
 * Note: /plan is owned by the orchestrator extension (Ask → Plan → Build).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerReviewCommand } from "./review";
import { registerCommitCommand } from "./commit";
import { registerTodoCommand } from "./todo";
import { registerContextCommand, setupContextAutoLoad } from "./context";
import { setupGlossaryTool } from "./context-tool";

export default function (pi: ExtensionAPI) {
  // Wrap pi.registerCommand so we can pass it to sub-modules
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
          ctx.ui.notify(`/ ${name}: ${err?.message ?? String(err)}`, "error");
        }
      },
    });
  }

  registerReviewCommand(register);
  registerCommitCommand(register);
  registerTodoCommand(register);
  registerContextCommand(register);

  // Domain-aware context auto-loading
  setupContextAutoLoad(pi);

  // Glossary update tool (LLM can add/update/remove terms)
  setupGlossaryTool(pi);

  // Session start notification
  pi.on("session_start", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("cmds", "pi-workflow v0.1");
    }
  });
}
