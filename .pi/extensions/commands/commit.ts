/**
 * commit.ts — Domain-aware commit message generation
 *
 * /commit          — generate Conventional Commit message
 * /commit --amend  — improve previous commit message
 * /commit:apply    — apply last assistant message as git commit
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  git,
  gitDiff,
  gitChangedFiles,
} from "../shared/utils";
import {
  buildContextSections,
  renderContextSections,
} from "../shared/context-builder";
import * as fs from "node:fs";

function buildCommitPrompt(cwd: string): { prompt: string; diffEmpty: boolean } {
  const stagedDiff = gitDiff({ staged: true }, cwd);
  const unstagedDiff = gitDiff({ staged: false }, cwd);
  const diff = stagedDiff && stagedDiff.length > 0 ? stagedDiff : unstagedDiff;

  if (!diff || diff.length === 0) {
    return { prompt: "", diffEmpty: true };
  }

  const isStaged = stagedDiff !== null && stagedDiff.length > 0;
  const changedFiles = gitChangedFiles({ staged: isStaged }, cwd);
  const branch = git(["branch", "--show-current"], cwd) ?? "unknown";

  // Get domain context for better scoping
  const ctxSec = buildContextSections(cwd, { includeGit: false, includeAdrs: false });
  const domainBlock = renderContextSections(ctxSec);

  return {
    prompt: `Generate a git commit message for the following changes.

### Branch
${branch}

${domainBlock ? `### Domain Context\n${domainBlock}\n` : ""}

### Changed Files
${changedFiles.map((f) => `- ${f}`).join("\n")}

### Diff
\`\`\`diff
${diff.slice(0, 8000)}
\`\`\`

Return ONLY the commit message in Conventional Commits format with the appropriate scope derived from the domain context above:

\`\`\`
<type>(<scope>): <description>

<body>
\`\`\`

Types: feat, fix, chore, docs, style, refactor, perf, test, ci
Subject: under 72 chars, imperative mood
Body: explain WHY, not WHAT. Include domain terminology from the glossary above.`,
    diffEmpty: false,
  };
}

export function registerCommitCommand(
  register: (name: string, opts: {
    description: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  }) => void,
) {
  register("commit", {
    description: "Generate a Conventional Commit message with domain-aware scoping",
    handler: async (args, ctx) => {
      const isAmend = args.trim() === "--amend";
      const { prompt, diffEmpty } = buildCommitPrompt(ctx.cwd);

      if (diffEmpty) {
        ctx.ui.notify("No changes to commit (staged or unstaged).", "warning");
        return;
      }

      if (isAmend) {
        const lastMsg = git(["log", "-1", "--format=%B"], ctx.cwd) ?? "(none)";
        const amendedPrompt =
          `The previous commit message was:\n\`\`\`\n${lastMsg}\n\`\`\`\n\n` +
          `Generate an IMPROVED commit message with better scoping and detail:\n\n${prompt}`;
        ctx.setEditorText(amendedPrompt);
      } else {
        ctx.setEditorText(prompt);
      }

      ctx.ui.notify("Commit prompt ready. Submit (Enter) to generate. Then /commit:apply to execute.", "info");
    },
  });

  register("commit:apply", {
    description: "Apply the last assistant message as a git commit",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getBranch();
      let commitMsg: string | null = null;

      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type === "message" && entry.message.role === "assistant") {
          for (const part of entry.message.content) {
            if (part.type === "text") {
              // Extract from markdown code block or use raw text
              const codeBlock = part.text.match(/```(?:commit|bash|sh|text)?\s*\n([\s\S]*?)```/);
              commitMsg = codeBlock ? codeBlock[1].trim() : part.text.trim();
              break;
            }
          }
          break;
        }
      }

      if (!commitMsg) {
        ctx.ui.notify("No commit message found. Run /commit first.", "error");
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Commit?",
        commitMsg.slice(0, 500) + (commitMsg.length > 500 ? "\n..." : ""),
      );

      if (!confirmed) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      const tmpFile = `/tmp/pi-commit-msg-${Date.now()}.txt`;
      fs.writeFileSync(tmpFile, commitMsg);

      const result = git(["commit", "-F", tmpFile], ctx.cwd);
      fs.unlinkSync(tmpFile);

      if (result !== null) {
        const hash = git(["log", "-1", "--format=%h"], ctx.cwd) ?? "?";
        ctx.ui.notify(`Committed ${hash}`, "success");
      } else {
        ctx.ui.notify("Commit failed. Check git status.", "error");
      }
    },
  });
}
