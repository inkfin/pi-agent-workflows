/**
 * Explicitly loaded into every worker subprocess.
 *
 * `--no-extensions -e worker-guard.ts` prevents project extensions from
 * injecting tools or prompts into isolated workers. In read-only mode this
 * hook also enforces the bash allowlist; a prompt instruction alone is not a
 * security boundary.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSafeCommand } from "./lib/safe-commands";

export default function workerGuard(pi: ExtensionAPI): void {
  const mode = process.env.PI_ORCHESTRATOR_WORKER_MODE ?? "readonly";
  if (mode !== "readonly") return;

  pi.on("tool_call", async (event) => {
    if (event.toolName === "edit" || event.toolName === "write") {
      return {
        block: true,
        reason: `Read-only orchestrator worker cannot call ${event.toolName}.`,
      };
    }
    if (event.toolName === "bash") {
      const command = String((event.input as { command?: unknown })?.command ?? "");
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `Read-only orchestrator worker blocked bash command:\n${command}`,
        };
      }
    }
  });
}
