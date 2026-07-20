/**
 * review.ts — Multi-dimensional code review
 *
 * Evaluation dimensions:
 *   1. Correctness    — Does the code do what it claims?
 *   2. Completeness   — Edge cases, error paths, missing pieces
 *   3. Documentation  — Comments, docstrings, README, ADR updates needed
 *   4. Potential issues — Race conditions, memory, resource leaks, subtle bugs
 *   5. Security       — Injection, auth, data exposure, dependency risks
 *   6. Maintainability — Readability, naming, structure, DRY, coupling
 *   7. Test coverage  — Tests present? Adequate? Testable design?
 *   8. Performance    — Obvious bottlenecks, N+1 queries, unnecessary work
 *
 * Additionally cross-references against domain glossary to catch
 * terminology drift and architectural inconsistency.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { gitDiff, gitChangedFiles, projectName } from "../shared/utils";
import {
  buildContextSections,
  renderContextSections,
  readContextFile,
  discoverDomains,
} from "../shared/context-builder";
import * as fs from "node:fs";
import * as path from "node:path";

const DIMENSIONS = [
  { key: "correctness",    label: "Correctness",      icon: "✓", weight: "critical", prompt: "Does the code correctly implement the intended behavior? Check logic, conditionals, type safety, edge case handling. Flag any bugs or likely-incorrect assumptions." },
  { key: "completeness",   label: "Completeness",     icon: "◧", weight: "high", prompt: "Are there missing parts? Unhandled edge cases? Missing error handling? Incomplete implementation of stated goals? Dead code or stubs left in?" },
  { key: "documentation",  label: "Documentation",    icon: "📄", weight: "medium", prompt: "Do comments and docstrings need updates? Should ADRs be created/updated for architectural decisions? Does the README or CONTEXT.md need changes? Are new public APIs documented?" },
  { key: "potential",      label: "Potential Issues", icon: "⚠", weight: "high", prompt: "Any race conditions, memory leaks, resource exhaustion, infinite loops, off-by-one errors, null/undefined access? Timezone, encoding, or locale issues?" },
  { key: "security",       label: "Security",         icon: "🔒", weight: "critical", prompt: "Injection risks (SQL, command, template)? Authentication/authorization bypass? Sensitive data exposure? Unsafe deserialization? Dependency with known vulnerabilities?" },
  { key: "maintainability",label: "Maintainability",  icon: "🔧", weight: "medium", prompt: "Is the code readable? Good naming? Appropriate abstractions? Not over-engineered? Follows project conventions? Single responsibility? Low coupling?" },
  { key: "test",           label: "Test Coverage",   icon: "🧪", weight: "medium", prompt: "Are there tests for the new/changed code? Do existing tests cover edge cases? Is the design testable? Should integration or E2E tests be added?" },
  { key: "performance",    label: "Performance",      icon: "⚡", weight: "low", prompt: "Any obvious performance problems? N+1 queries, unnecessary allocations, blocking I/O, large memory footprint, missing caching opportunities?" },
] as const;

function buildReviewPrompt(
  paths: string[],
  opts: { commit?: string; fullFiles?: boolean; quick?: boolean },
  cwd: string,
): string {
  const diff = gitDiff({ staged: false, commit: opts.commit, paths }, cwd);
  const changedFiles = gitChangedFiles({ commit: opts.commit }, cwd);
  const allChanged = changedFiles.length > 0 ? changedFiles : (paths.length > 0 ? paths : []);

  const parts: string[] = [];

  // ── Project context ──
  parts.push(`Reviewing code changes in **${projectName(cwd)}**.`);

  const ctxSections = buildContextSections(cwd, {
    includeGit: true,
    includeAdrs: false,
    fullGlossary: false,
  });

  // Inject domain glossary so reviewer knows the canonical language
  if (ctxSections.termsBlock) {
    parts.push(`### Domain Glossary (from CONTEXT.md)\n${ctxSections.termsBlock}`);
    parts.push("Flag any code that uses terminology inconsistently with these canonical definitions.\n");
  }

  // ── File listing ──
  if (allChanged.length > 0) {
    parts.push(`### Files Changed (${allChanged.length})\n${allChanged.map((f) => `- ${f}`).join("\n")}`);
  }

  // ── Full file content (for small changesets) ──
  if (opts.fullFiles && allChanged.length <= 5 && allChanged.length > 0) {
    parts.push("### Full File Contents (for context)");
    for (const file of allChanged) {
      const fp = path.join(cwd, file);
      try {
        const content = fs.readFileSync(fp, "utf-8");
        parts.push(`\n**${file}:**\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``);
      } catch { /* binary or missing */ }
    }
  }

  // ── Diff ──
  parts.push(`### Diff\n\`\`\`diff\n${diff ?? "(no changes detected — reviewing working tree vs HEAD)"}\n\`\`\``);

  // ── Evaluation framework ──
  if (opts.quick) {
    // Quick mode: just a summary
    parts.push(`## Evaluation\n\nProvide a concise review. Focus on correctness and security. Flag anything blocking.`);
  } else {
    // Full multi-dimensional review
    const dimensionList = DIMENSIONS.map(
      (d) => `  - **${d.icon} ${d.label}** [${d.weight}]: ${d.prompt}`,
    ).join("\n");

    parts.push(`## Multi-Dimensional Review

Evaluate the changes across these dimensions. For each, provide:
- A rating: ✅ pass / ⚠ concern / ❌ fail / — n/a
- Specific findings with file locations and line ranges
- Actionable suggestions

${dimensionList}

### Output Format

Use this structure:

\`\`\`markdown
## Review: <one-line summary>

### Dimension Scores

| Dimension | Rating | Key Finding |
|-----------|--------|-------------|
| ✓ Correctness | ✅/⚠/❌ | ... |
| ◧ Completeness | ✅/⚠/❌ | ... |
| 📄 Documentation | ✅/⚠/❌ | ... |
| ⚠ Potential Issues | ✅/⚠/❌ | ... |
| 🔒 Security | ✅/⚠/❌ | ... |
| 🔧 Maintainability | ✅/⚠/❌ | ... |
| 🧪 Test Coverage | ✅/⚠/❌ | ... |
| ⚡ Performance | ✅/⚠/❌ | ... |

### Detailed Findings

For each finding, include:
- **Dimension** | **Severity**: critical / warning / note
- **File**: path and line range
- **Issue**: what's wrong
- **Fix**: how to fix it

### Overall Verdict

One of: ✅ LGTM / ⚠ Needs minor changes / ❌ Needs rework / 🔄 Needs discussion

### Positive Highlights
What's done well — good patterns, clever solutions, clean code.
\`\`\`
`);
  }

  return parts.join("\n\n");
}

export function registerReviewCommand(
  register: (name: string, opts: {
    description: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  }) => void,
) {
  register("review", {
    description: "Multi-dimensional code review: correctness, completeness, security, docs, tests, perf",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);

      let commit: string | undefined;
      let paths: string[] = [];
      let fullFiles = false;
      let quick = false;
      let i = 0;

      while (i < tokens.length) {
        switch (tokens[i]) {
          case "--commit":
            if (i + 1 < tokens.length) { commit = tokens[i + 1]; i += 2; }
            else i += 1;
            break;
          case "--full":
            fullFiles = true;
            i += 1;
            break;
          case "--quick":
          case "-q":
            quick = true;
            i += 1;
            break;
          default:
            paths.push(tokens[i]);
            i += 1;
        }
      }

      // Default: review unstaged changes
      if (!commit && paths.length === 0) {
        const changed = gitChangedFiles({}, ctx.cwd);
        if (changed.length === 0) {
          ctx.ui.notify(
            "No changes to review.\n" +
              "Try: /review <files> — review specific files\n" +
              "     /review --commit <hash> — review a commit\n" +
              "     /review --quick — quick summary only",
            "info",
          );
          return;
        }
        paths = changed;
      }

      const prompt = buildReviewPrompt(paths, { commit, fullFiles, quick }, ctx.cwd);
      ctx.setEditorText(prompt);
      const mode = quick ? "quick summary" : "full multi-dimensional review";
      ctx.ui.notify(`Review prompt ready (${mode}). Submit (Enter) to run.`, "info");
    },
  });
}
