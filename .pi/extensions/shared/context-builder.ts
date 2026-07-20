/**
 * shared/context-builder.ts — Gather project context for agent prompts
 *
 * Used by plan, review, commit, and the context auto-load hook.
 * Builds a unified context blob from:
 *   - Domain glossary (CONTEXT.md / CONTEXT-MAP.md)
 *   - ADRs (architectural decisions)
 *   - Project structure
 *   - Git status (changed files, branch)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { git, gitChangedFiles, projectName } from "./utils";

// ─── Domain Context ────────────────────────────────────────

export interface DomainInfo {
  name: string;
  path: string;
  contextFile: string;
  adrDir: string;
  description?: string;
  exists: boolean;
}

/**
 * Parse CONTEXT-MAP.md to discover domains.
 */
export function discoverDomains(cwd: string): DomainInfo[] {
  const mapPath = path.join(cwd, "CONTEXT-MAP.md");
  const domains: DomainInfo[] = [];

  // Root always exists
  const rootFile = path.join(cwd, "CONTEXT.md");
  domains.push({
    name: "root",
    path: "",
    contextFile: rootFile,
    adrDir: path.join(cwd, "docs", "adr"),
    description: "Project-wide context",
    exists: fs.existsSync(rootFile),
  });

  // Parse CONTEXT-MAP.md if present
  try {
    const raw = fs.readFileSync(mapPath, "utf-8");
    const lines = raw.split("\n");
    let current: { name: string; attrs: Record<string, string> } | null = null;

    for (const line of lines) {
      const h2 = line.match(/^##\s+(.+)/);
      if (h2) {
        if (current) {
          const d = makeDomain(cwd, current.name, current.attrs);
          if (d) domains.push(d);
        }
        current = { name: h2[1].trim(), attrs: {} };
        continue;
      }
      if (current) {
        const kv = line.match(/^\s*-\s*(\w+)\s*:\s*(.+)/);
        if (kv) current.attrs[kv[1].trim()] = kv[2].trim();
      }
    }
    if (current) {
      const d = makeDomain(cwd, current.name, current.attrs);
      if (d) domains.push(d);
    }
  } catch { /* no CONTEXT-MAP.md */ }

  return domains;
}

function makeDomain(cwd: string, name: string, attrs: Record<string, string>): DomainInfo | null {
  const domainPath = attrs["path"] || "";
  const contextFile = path.join(cwd, domainPath, "CONTEXT.md");
  return {
    name,
    path: domainPath,
    contextFile,
    adrDir: path.join(cwd, domainPath, "docs", "adr"),
    description: attrs["description"],
    exists: fs.existsSync(contextFile),
  };
}

/**
 * Read a CONTEXT.md file, strip frontmatter, return content.
 */
export function readContextFile(filePath: string): string | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (raw.startsWith("---")) {
      const end = raw.indexOf("---", 3);
      if (end !== -1) return raw.slice(end + 3).trim();
    }
    return raw.trim();
  } catch {
    return null;
  }
}

/**
 * Extract terms from a CONTEXT.md glossary.
 * Pattern: **Term**: definition  (with optional - or * prefix)
 */
export function extractTerms(content: string): { term: string; definition: string }[] {
  const terms: { term: string; definition: string }[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(/^\s*[-*]?\s*\*\*(.+?)\*\*\s*:\s*(.+)/);
    if (match) {
      terms.push({ term: match[1].trim(), definition: match[2].trim() });
    }
  }
  return terms;
}

/**
 * Discover ADRs from a directory.
 */
export function discoverAdrs(adrDir: string): { filename: string; title: string; number: string }[] {
  const entries: { filename: string; title: string; number: string }[] = [];
  try {
    for (const file of fs.readdirSync(adrDir).sort()) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = fs.readFileSync(path.join(adrDir, file), "utf-8");
        const titleMatch = content.match(/^#\s+(.+)/m);
        const numberMatch = file.match(/^(\d+)/);
        entries.push({
          filename: file,
          title: titleMatch ? titleMatch[1] : file,
          number: numberMatch ? numberMatch[1] : "",
        });
      } catch {
        entries.push({ filename: file, title: file, number: "" });
      }
    }
  } catch { /* no adr dir */ }
  return entries;
}

// ─── Domain Detection ──────────────────────────────────────

/**
 * Score domains against a prompt to find the best match.
 */
export function detectDomain(prompt: string, domains: DomainInfo[]): DomainInfo | null {
  if (domains.length <= 1) return null;

  let best: DomainInfo | null = null;
  let bestScore = 0;
  const lower = prompt.toLowerCase();

  for (const d of domains) {
    if (!d.path) continue;
    let score = 0;

    if (lower.includes(d.path.toLowerCase())) score += 5;
    if (new RegExp(`\\b${d.name}\\b`, "i").test(prompt)) score += 3;

    // File path heuristics
    const words = lower.split(/[\s,]+/);
    for (const w of words) {
      if (w.includes(`/${d.name}/`) || w.includes(`${d.name}/`)) score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }

  return bestScore > 0 ? best : null;
}

// ─── Unified Context Builder ───────────────────────────────

export interface ContextSections {
  /** Domain terms as "**Term**: definition" lines */
  termsBlock?: string;
  /** Full glossary content */
  glossaryBlock?: string;
  /** ADR summaries */
  adrsBlock?: string;
  /** Changed files list */
  filesBlock?: string;
  /** Git branch */
  branch?: string;
}

export interface BuildContextOptions {
  /** Prompt text (for domain detection) */
  prompt?: string;
  /** Explicit domain name to use */
  domain?: string;
  /** Include full glossary (not just terms) */
  fullGlossary?: boolean;
  /** Include ADRs */
  includeAdrs?: boolean;
  /** Include git status */
  includeGit?: boolean;
}

/**
 * Build a contextual injection for plan/review/commit prompts.
 *
 * Strategy:
 *   - Root terms: always included (lightweight)
 *   - Domain glossary: included when domain is detected or explicit
 *   - ADRs: included when relevant
 *   - Git status: included for plan/review
 */
export function buildContextSections(cwd: string, opts: BuildContextOptions = {}): ContextSections {
  const domains = discoverDomains(cwd);
  const result: ContextSections = {};

  // 1. Domain detection
  const targetDomain =
    opts.domain
      ? domains.find((d) => d.name === opts.domain)
      : opts.prompt
        ? detectDomain(opts.prompt, domains)
        : null;

  // 2. Root terms (always)
  const rootDomain = domains[0];
  if (rootDomain?.exists) {
    const content = readContextFile(rootDomain.contextFile);
    if (content) {
      const terms = extractTerms(content);
      if (terms.length > 0) {
        result.termsBlock = terms.map((t) => `**${t.term}**: ${t.definition}`).join("\n");
      }
    }
  }

  // 3. Domain glossary
  if (targetDomain && targetDomain.exists && targetDomain.name !== "root") {
    const content = readContextFile(targetDomain.contextFile);
    if (content) {
      if (opts.fullGlossary) {
        result.glossaryBlock = `## Domain: ${targetDomain.name}\n${content}`;
      }
      // Merge domain terms into termsBlock
      const domainTerms = extractTerms(content || "");
      const allTerms = result.termsBlock
        ? result.termsBlock + "\n" + domainTerms.map((t) => `**${t.term}**: ${t.definition}`).join("\n")
        : domainTerms.map((t) => `**${t.term}**: ${t.definition}`).join("\n");
      const unique = [...new Set(allTerms.split("\n"))].join("\n");
      result.termsBlock = unique;
    }
  }

  // 4. ADRs
  if (opts.includeAdrs) {
    const adrDir = targetDomain?.adrDir || rootDomain?.adrDir;
    if (adrDir) {
      const adrs = discoverAdrs(adrDir);
      if (adrs.length > 0) {
        result.adrsBlock = adrs
          .slice(-5) // last 5 ADRs only
          .map((a) => `- [${a.number}] ${a.title}`)
          .join("\n");
      }
    }
  }

  // 5. Git status
  if (opts.includeGit) {
    result.branch = git(["branch", "--show-current"], cwd) ?? undefined;
    const changed = gitChangedFiles({}, cwd);
    if (changed.length > 0) {
      result.filesBlock = changed.map((f) => `- ${f}`).join("\n");
    }
    // Also check staged
    const staged = gitChangedFiles({ staged: true }, cwd);
    if (staged.length > 0) {
      result.filesBlock = (result.filesBlock || "") + "\nStaged:\n" + staged.map((f) => `- ${f}`).join("\n");
    }
  }

  return result;
}

/**
 * Render context sections into a prompt fragment.
 */
export function renderContextSections(sections: ContextSections): string {
  const parts: string[] = [];

  if (sections.branch) {
    parts.push(`### Branch\n${sections.branch}`);
  }

  if (sections.termsBlock) {
    parts.push(`### Domain Glossary\n\n${sections.termsBlock}\n\n⚠ These are canonical definitions from CONTEXT.md. Use this terminology in your output.`);
  }

  if (sections.glossaryBlock) {
    parts.push(sections.glossaryBlock);
  }

  if (sections.adrsBlock) {
    parts.push(`### Recent Architectural Decisions\n${sections.adrsBlock}`);
  }

  if (sections.filesBlock) {
    parts.push(`### Changed Files\n${sections.filesBlock}`);
  }

  return parts.join("\n\n");
}
