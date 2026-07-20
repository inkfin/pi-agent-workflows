/**
 * project-tree/index.ts — Project Tree extension entry point
 *
 * Provides:
 *   /branch              — interactive tree view (tig-style)
 *   /branch create <name>— create branch from current
 *   /branch switch <name>— switch to another branch
 *   /branch rename <name>— rename current branch
 *   /branch archive      — archive branch
 *   /branch list         — list branches (non-interactive)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupBranchCommands } from "./branch-commands";

export default function (pi: ExtensionAPI) {
  setupBranchCommands(pi);
}
