import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { projectName } from "../shared/utils";
import {
  discoverDomains,
  buildContextSections,
  renderContextSections,
} from "../shared/context-builder";
import * as fs from "node:fs";
import * as path from "node:path";

function gatherContext(goal: string, cwd: string): string {
  const ctx = buildContextSections(cwd, {
    prompt: goal,
    includeAdrs: true,
    includeGit: true,
    fullGlossary: true,
  });

  const parts: string[] = [];
  parts.push(`## Project: ${projectName(cwd)}`);
  parts.push(renderContextSections(ctx));

  // Project structure (top-level)
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => `${e.name}/`);
    const files = entries
      .filter((e) => e.isFile())
      .map((e) => e.name);
    parts.push(
      `### Project Structure\n${[...dirs, ...files.slice(0, 15)].join("\n")}`
    );
    if (files.length > 15) parts.push(`... and ${files.length - 15} more files`);
  } catch { /* ignore */ }

  return parts.join("\n\n");
}

function buildPlanPrompt(goal: string, cwd: string): string {
  const context = gatherContext(goal, cwd);
  return `I need a detailed implementation plan for:

## Goal
${goal}

${context}

Please produce a structured plan:

1. **Overview** — one paragraph summarizing the approach
2. **Steps** — numbered steps. Each step:
   - What files to create/modify (use actual paths)
   - Key design decisions
   - Dependencies on other steps
3. **Architecture** — how the new code fits into the existing structure
4. **Risks & edge cases** — what could go wrong, what needs careful handling
5. **Effort** — size per step: S (quick fix), M (meaningful work), L (multi-session)

Be concrete and precise. Reference actual file paths, function names, and data structures.`;
}

export function registerPlanCommand(
  register: (name: string, opts: {
    description: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  }) => void,
) {
  register("plan", {
    description: "Generate an implementation plan for a goal",
    handler: async (args, ctx) => {
      const goal = args.trim();

      if (!goal) {
        ctx.ui.notify("Usage: /plan <goal description>", "error");
        return;
      }

      const prompt = buildPlanPrompt(goal, ctx.cwd);
      ctx.setEditorText(prompt);
      ctx.ui.notify("Review the plan prompt and submit (Enter) to generate.", "info");
    },
  });
}
