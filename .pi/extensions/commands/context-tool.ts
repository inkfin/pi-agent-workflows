/**
 * context-tool.ts — Tool for the LLM to update the domain glossary
 *
 * Register update_glossary tool + inject instruction in before_agent_start
 * so the agent can maintain CONTEXT.md as it works.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  discoverDomains,
  type DomainInfo,
} from "../shared/context-builder";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Glossary Update Tool ─────────────────────────────────

const GlossaryParams = Type.Object({
  domain: Type.Optional(Type.String({
    description: "Domain name to update (omitting or 'root' updates the project-wide CONTEXT.md)",
  })),
  term: Type.String({
    description: "The canonical term being defined or updated",
  }),
  definition: Type.String({
    description: "Precise definition. Zero implementation details — focus on what the term means in the domain.",
  }),
  action: Type.Optional(StringEnum(["add", "update", "remove"] as const, {
    description: 'add = insert new term. update = replace existing definition. remove = delete term. Default: add.',
    default: "add",
  })),
});

function updateGlossary(
  contextFile: string,
  term: string,
  definition: string,
  action: "add" | "update" | "remove",
): { success: boolean; message: string } {
  // Ensure directory exists
  fs.mkdirSync(path.dirname(contextFile), { recursive: true });

  let content: string;
  try {
    content = fs.readFileSync(contextFile, "utf-8");
  } catch {
    // File doesn't exist yet — create it
    const dirName = path.basename(path.dirname(contextFile));
    content = `# ${dirName} Glossary\n\n`;
  }

  const lines = content.split("\n");
  const termPattern = `**${term}**`;
  let foundIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(termPattern)) {
      foundIndex = i;
      break;
    }
  }

  switch (action) {
    case "remove": {
      if (foundIndex === -1) {
        return { success: false, message: `Term "${term}" not found in glossary.` };
      }
      lines.splice(foundIndex, 1);
      fs.writeFileSync(contextFile, lines.join("\n"));
      return { success: true, message: `Removed "${term}" from glossary.` };
    }

    case "update": {
      if (foundIndex === -1) {
        return { success: false, message: `Term "${term}" not found. Use action: "add" to create it.` };
      }
      // Preserve existing formatting (bullet prefix)
      const prefix = lines[foundIndex].match(/^(\s*[-*]?\s*)/)?.[0] || "";
      lines[foundIndex] = `${prefix}**${term}**: ${definition}`;
      fs.writeFileSync(contextFile, lines.join("\n"));
      return { success: true, message: `Updated "${term}" in glossary.` };
    }

    case "add": {
      if (foundIndex !== -1) {
        return {
          success: false,
          message: `Term "${term}" already exists. Use action: "update" to change it, or "remove" to delete.`,
        };
      }

      // Find insertion point: after the last glossary entry, or after the header
      let insertAt = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().startsWith("**") && lines[i].includes("**:")) {
          insertAt = i + 1;
          break;
        }
        if (lines[i].trim().startsWith("#") || lines[i].trim().startsWith("<!--")) {
          insertAt = i + 1;
          break;
        }
      }

      lines.splice(insertAt, 0, `**${term}**: ${definition}`);
      fs.writeFileSync(contextFile, lines.join("\n"));
      return { success: true, message: `Added "${term}" to glossary.` };
    }

    default:
      return { success: false, message: `Unknown action: ${action}` };
  }
}

// ─── Extension Setup ───────────────────────────────────────

export function setupGlossaryTool(pi: ExtensionAPI) {
  // Register the tool
  pi.registerTool({
    name: "update_glossary",
    label: "Update Glossary",
    description:
      "Add, update, or remove a term in the domain glossary (CONTEXT.md). " +
      "Use this when you discover a new domain concept, need to clarify an existing term, " +
      "or want to record a terminology decision. Keep definitions free of implementation details — " +
      "the glossary is a domain dictionary, not a spec.",
    promptSnippet: "Add/update a domain term in CONTEXT.md",
    promptGuidelines: [
      "Use update_glossary when you encounter a new domain concept that needs a canonical definition, " +
        "or when existing terminology is ambiguous and needs refinement.",
      "Do NOT put implementation details in glossary definitions. " +
        "The glossary says WHAT a term means, never HOW it's implemented.",
    ],
    parameters: GlossaryParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const domainName = params.domain || "root";
      const term = params.term.trim();
      const definition = params.definition.trim();
      const action = params.action || "add";

      if (!term || !definition) {
        return {
          content: [{ type: "text", text: "term and definition are required." }],
          details: {},
        };
      }

      const domains = discoverDomains(ctx.cwd);
      const target = domains.find((d) => d.name === domainName);

      if (!target) {
        const available = domains.map((d) => d.name).join(", ");
        return {
          content: [{ type: "text", text: `Unknown domain: "${domainName}". Available: ${available}` }],
          details: {},
        };
      }

      const result = updateGlossary(target.contextFile, term, definition, action);

      if (result.success) {
        // If this is a non-root domain and CONTEXT-MAP.md doesn't exist yet,
        // remind about registering the domain
        if (target.name !== "root" && !fs.existsSync(path.join(ctx.cwd, "CONTEXT-MAP.md"))) {
          return {
            content: [{
              type: "text",
              text: `${result.message}\n\nNote: This domain is not yet registered in CONTEXT-MAP.md. The glossary was updated but the domain won't be auto-loaded. Ask the user if they want to create CONTEXT-MAP.md.`,
            }],
            details: { domain: target.name, term, action },
          };
        }
      }

      return {
        content: [{ type: "text", text: result.message }],
        details: { domain: target.name, term, action, success: result.success },
      };
    },

    renderCall(args, theme, _context) {
      const action = args.action || "add";
      const domain = args.domain && args.domain !== "root" ? ` [${args.domain}]` : "";
      const actionIcon = action === "remove" ? "✗" : action === "update" ? "✎" : "+";
      let text =
        theme.fg("toolTitle", theme.bold("glossary ")) +
        theme.fg("accent", `${actionIcon} ${args.term}${domain}`);
      if (args.definition && typeof args.definition === "string") {
        const preview =
          args.definition.length > 50
            ? args.definition.slice(0, 50) + "..."
            : args.definition;
        text += `\n  ${theme.fg("dim", preview)}`;
      }
      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme, _context) {
      const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      const details = result.details as any;
      const success = details?.success !== false;
      const color = success ? "success" : "error";
      return new Text(theme.fg(color, text), 0, 0);
    },
  });

  // Inject glossary maintenance instruction in before_agent_start
  pi.on("before_agent_start", async (event, ctx) => {
    const domains = discoverDomains(ctx.cwd);
    const hasGlossary = domains.some((d) => d.exists);
    if (!hasGlossary) return;

    // Inject a lightweight reminder to maintain the glossary
    const instruction = [
      "## Glossary Maintenance",
      "",
      "A domain glossary is available (CONTEXT.md). As you work:",
      "- When you discover a new domain term → use `update_glossary` to add it",
      "- When a term's meaning needs refinement → use `update_glossary` action:update",
      "- Keep definitions crisp and free of implementation details",
      "- If unsure about a term, ask the user before adding it",
      "",
      "Glossary terms you add/update will be visible to future sessions and other commands like /plan and /review.",
    ].join("\n");

    return {
      systemPrompt: (event.systemPrompt || "") + "\n\n" + instruction,
    };
  });

  // Hook into turn_end to occasionally remind about glossary if terms were likely encountered
  // (We don't want to be annoying — just a light touch)
  let turnsSinceGlossaryReminder = 0;
  pi.on("turn_end", async (_event, ctx) => {
    turnsSinceGlossaryReminder++;
    // After every ~5 turns, inject a gentle nudge (only if glossary exists)
    if (turnsSinceGlossaryReminder >= 5) {
      const domains = discoverDomains(ctx.cwd);
      const hasGlossary = domains.some((d) => d.exists);
      if (hasGlossary) {
        // Use setStatus for a subtle indicator instead of spamming
        ctx.ui.setStatus("glossary", "term?");
      }
      turnsSinceGlossaryReminder = 0;
    }
  });
}
