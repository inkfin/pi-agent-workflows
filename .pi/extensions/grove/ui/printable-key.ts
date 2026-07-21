import {
  decodeKittyPrintable,
  parseKey,
} from "@earendil-works/pi-tui";

/**
 * Normalize plain, Kitty CSI-u, and xterm modifyOtherKeys input into one
 * printable character. Modifier chords intentionally remain undecoded.
 */
export function printableKey(data: string): string {
  const kitty = decodeKittyPrintable(data);
  if (kitty) return kitty;
  const parsed = parseKey(data);
  if (!parsed) return data;
  if (parsed.length === 1) return parsed;
  if (parsed.startsWith("shift+")) {
    const base = parsed.slice("shift+".length);
    if (base.length === 1) {
      return /^[a-z]$/.test(base) ? base.toUpperCase() : base;
    }
  }
  return data;
}
