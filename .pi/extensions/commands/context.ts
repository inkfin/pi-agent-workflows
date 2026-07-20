/**
 * context.ts — Domain-aware context management
 *
 * Implements grill-with-docs' multi-context model:
 *   - CONTEXT.md          — root/system-wide domain glossary
 *   - CONTEXT-MAP.md      — maps domain names → paths where their CONTEXT.md live
 *   - docs/adr/*.md       — architectural decision records
 *   - src/<domain>/CONTEXT.md  — domain-specific glossaries
 *
 * Commands:
 *   /context            — show domain glossary
 *   /context domains    — list all domains
 *   /context use <name> — set active domain
 *   /context edit [name]— edit domain glossary
 *   /context adrs       — list ADRs
 *   /context adr <title>— view/create ADR
 *   /context reload     — reload pi
 *
 * Auto-loading:
 *   before_agent_start injects the right domain glossary based on
 *   prompt content + explicit active domain.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  discoverDomains,
  readContextFile,
  extractTerms,
  discoverAdrs,
  detectDomain,
  type DomainInfo,
} from "../shared/context-builder";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── Active Domain State ───────────────────────────────────

const activeDomains = new Map<string, string>(); // cwd → domain name

function getActiveDomain(cwd: string): string {
  return activeDomains.get(cwd) || "root";
}

function setActiveDomain(cwd: string, name: string): void {
  activeDomains.set(cwd, name);
}

function findDomain(domains: DomainInfo[], name: string): DomainInfo | undefined {
  return domains.find((d) => d.name === name);
}

// ─── Command Registration ──────────────────────────────────

export function registerContextCommand(
  register: (name: string, opts: {
    description: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  }) => void,
) {
  register("context", {
    description: "Domain context management: glossary, ADRs, domain switching",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0] || "show";
      const rest = parts.slice(1).join(" ");

      const domains = discoverDomains(ctx.cwd);
      const active = getActiveDomain(ctx.cwd);
      const currentDomain = findDomain(domains, active) || domains[0];

      switch (sub) {
        // ── /context (show glossary) ──
        case "show":
        case "view": {
          if (!currentDomain) {
            ctx.ui.notify("No domains configured.", "info");
            return;
          }

          const content = readContextFile(currentDomain.contextFile);
          if (!content) {
            ctx.ui.notify(
              `No CONTEXT.md for "${active}". Create one with /context edit.`,
              "info",
            );
            return;
          }

          const terms = extractTerms(content);
          if (terms.length === 0) {
            const preview = content.length > 500
              ? content.slice(0, 500) + "\n... (truncated — /context edit to see full)"
              : content;
            ctx.ui.notify(`Domain: ${active}\n\n${preview}`, "info");
            return;
          }

          const maxLen = Math.max(...terms.map((t) => t.term.length));
          const lines = [`Domain: ${active} (${terms.length} terms)`];
          for (const t of terms) {
            lines.push(`  ${t.term.padEnd(maxLen + 2)} ${t.definition}`);
          }
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        // ── /context domains ──
        case "domains":
        case "list": {
          if (domains.length <= 1 && !domains[0].exists) {
            ctx.ui.notify(
              "No domains found.\n" +
                "Create CONTEXT.md (root glossary) or CONTEXT-MAP.md (multi-domain).",
              "info",
            );
            return;
          }

          const lines = ["Domains:"];
          for (const d of domains) {
            const marker = d.name === active ? " ●" : "  ";
            const fileStatus = d.exists ? "✓" : "✗";
            const desc = d.description ? ` — ${d.description}` : "";
            lines.push(`${marker} ${d.name} [${fileStatus}]${desc}`);
            if (d.path) lines.push(`       path: ${d.path}`);
          }
          lines.push("");
          lines.push("● = active. /context use <name> to switch.");
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        // ── /context use ──
        case "use":
        case "switch": {
          if (!rest) {
            ctx.ui.notify("Usage: /context use <domain-name>", "error");
            return;
          }

          const found = findDomain(domains, rest);
          if (!found) {
            ctx.ui.notify(
              `Unknown: ${rest}. Available: ${domains.map((d) => d.name).join(", ")}`,
              "error",
            );
            return;
          }

          setActiveDomain(ctx.cwd, rest);
          ctx.ui.notify(
            `Active: ${rest}${found.exists ? "" : " (new — /context edit to create glossary)"}`,
            "success",
          );
          break;
        }

        // ── /context edit ──
        case "edit":
        case "e": {
          let target = currentDomain;
          if (rest) {
            const found = findDomain(domains, rest);
            if (found) target = found;
            else {
              ctx.ui.notify(`Unknown: ${rest}`, "error");
              return;
            }
          }

          if (!target) return;

          fs.mkdirSync(path.dirname(target.contextFile), { recursive: true });

          let existing = "";
          try { existing = fs.readFileSync(target.contextFile, "utf-8"); } catch { /* new */ }

          if (!existing) {
            const domainLabel = target.name === "root"
              ? path.basename(ctx.cwd)
              : target.name;
            existing = `# ${domainLabel} Glossary\n\n<!--\nFormat: **Term**: canonical definition. Zero implementation details.\n-->\n\n`;
          }

          const edited = await ctx.ui.editor(
            `Edit: ${path.relative(ctx.cwd, target.contextFile)}`,
            existing,
          );

          if (edited === undefined) {
            ctx.ui.notify("Edit cancelled.", "info");
            return;
          }

          fs.writeFileSync(target.contextFile, edited);

          if (target.name !== "root" && !fs.existsSync(path.join(ctx.cwd, "CONTEXT-MAP.md"))) {
            ctx.ui.notify(
              `Saved: ${path.relative(ctx.cwd, target.contextFile)}\n⚠ Tip: create CONTEXT-MAP.md to register this domain for auto-loading.`,
              "warning",
            );
          } else {
            ctx.ui.notify(`Saved: ${path.relative(ctx.cwd, target.contextFile)}`, "success");
          }
          break;
        }

        // ── /context adrs ──
        case "adrs": {
          const domain = rest ? findDomain(domains, rest) : currentDomain;
          if (!domain) { ctx.ui.notify(`Unknown domain`, "error"); return; }

          const adrs = discoverAdrs(domain.adrDir);
          if (adrs.length === 0) {
            ctx.ui.notify(
              `No ADRs in ${path.relative(ctx.cwd, domain.adrDir)}/\nCreate: /context adr "<title>"`,
              "info",
            );
            return;
          }

          ctx.ui.notify(
            `ADRs — ${domain.name}:\n` +
              adrs.map((a) => `  ${a.number ? a.number + ". " : ""}${a.title}`).join("\n"),
            "info",
          );
          break;
        }

        // ── /context adr ──
        case "adr": {
          if (!rest) {
            ctx.ui.notify('Usage: /context adr "<title>"', "error");
            return;
          }

          const domain = currentDomain;
          if (!domain) return;

          fs.mkdirSync(domain.adrDir, { recursive: true });

          const existing = discoverAdrs(domain.adrDir);
          const nextNum = String(existing.length + 1).padStart(4, "0");
          const slug = rest.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
          const filename = `${nextNum}-${slug}.md`;
          const filePath = path.join(domain.adrDir, filename);

          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, "utf-8");
            const edited = await ctx.ui.editor(`ADR: ${path.relative(ctx.cwd, filePath)}`, content);
            if (edited !== undefined) {
              fs.writeFileSync(filePath, edited);
              ctx.ui.notify(`Saved: ${path.relative(ctx.cwd, filePath)}`, "success");
            }
            return;
          }

          const date = new Date().toISOString().split("T")[0];
          const template = `# ${rest}

- **Date**: ${date}
- **Status**: proposed
- **Domain**: ${domain.name}

## Context

## Decision

## Alternatives Considered

## Consequences
`;

          const edited = await ctx.ui.editor(`New ADR: ${filename}`, template);
          if (edited === undefined) {
            ctx.ui.notify("Cancelled.", "info");
            return;
          }

          fs.writeFileSync(filePath, edited);
          ctx.ui.notify(`Created: ${path.relative(ctx.cwd, filePath)}`, "success");
          break;
        }

        // ── /context reload ──
        case "reload": {
          await ctx.reload();
          break;
        }

        default: {
          ctx.ui.notify(
            "/context               show domain glossary\n" +
            "/context domains       list all domains\n" +
            "/context use <name>    switch active domain\n" +
            "/context edit [name]   edit glossary\n" +
            "/context adrs [domain] list ADRs\n" +
            '/context adr "<title>" create/view ADR\n' +
            "/context reload        reload extensions",
            "info",
          );
        }
      }
    },
  });
}

// ─── Extension Setup ───────────────────────────────────────

export function setupContextAutoLoad(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const domains = discoverDomains(ctx.cwd);
    const hasRoot = domains[0]?.exists;
    if (!hasRoot && domains.length <= 1) return;

    const explicitDomain = getActiveDomain(ctx.cwd);
    const detected = detectDomain(event.prompt, domains);
    const targetDomain =
      explicitDomain !== "root"
        ? findDomain(domains, explicitDomain)
        : detected;

    const contexts: string[] = [];

    // Root terms (always)
    if (hasRoot) {
      const rootContent = readContextFile(domains[0].contextFile);
      if (rootContent) {
        const isRoot = !targetDomain || targetDomain.name === "root";
        if (isRoot || rootContent.length < 2000) {
          contexts.push(`## Project Context (root)\n${rootContent}`);
        } else {
          const terms = extractTerms(rootContent);
          if (terms.length > 0) {
            contexts.push(`## Project Terms\n${terms.map((t) => `**${t.term}**: ${t.definition}`).join("\n")}`);
          }
        }
      }
    }

    // Domain context
    if (targetDomain && targetDomain.name !== "root" && targetDomain.exists) {
      const content = readContextFile(targetDomain.contextFile);
      if (content) {
        contexts.push(`## Domain: ${targetDomain.name}\n${content}`);
      }
    }

    if (contexts.length === 0) return;

    return {
      message: {
        customType: "domain-context",
        content: contexts.join("\n\n---\n\n"),
        display: false,
      },
    };
  });

  pi.on("session_start", (event, ctx) => {
    if (event.reason === "new") activeDomains.delete(ctx.cwd);
    if (ctx.hasUI) {
      const label = getActiveDomain(ctx.cwd);
      ctx.ui.setStatus("domain", label === "root" ? "root" : label);
    }
  });
}
