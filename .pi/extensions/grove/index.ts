/**
 * grove/index.ts — entry point
 *
 * Grove: jj-backed session tree (see CONTEXT.md for the domain language,
 * docs/adr/0001-0003 for the architecture decisions).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupGrove } from "./commands";

export default function (pi: ExtensionAPI) {
  setupGrove(pi);
}
