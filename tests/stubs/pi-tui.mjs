/**
 * Stub for @earendil-works/pi-tui — just enough for grove modules to load
 * in tests without pulling the real TUI package.
 */
export class Container {
  constructor() {
    this.children = [];
  }
  addChild(c) { this.children.push(c); }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); }
  clear() { this.children = []; }
  invalidate() {}
  render() { return []; }
}
export class Text {}
export class Spacer {}
export class Input {
  constructor() {
    this.value = "";
    this.focused = false;
  }
  getValue() { return this.value; }
  setValue(value) { this.value = value; }
  handleInput(data) {
    if (matchesKey(data, Key.enter)) this.onSubmit?.(this.value);
    else if (matchesKey(data, Key.escape)) this.onEscape?.();
    else if (data === "\x7f") this.value = this.value.slice(0, -1);
    else if (data.length === 1 && data >= " ") this.value += data;
  }
  invalidate() {}
  render(width) {
    return [truncateToWidth(this.value, width)];
  }
}
export class Markdown {
  constructor(text) {
    this.text = text;
  }
  invalidate() {}
  render(width) {
    return wrapTextWithAnsi(this.text, width);
  }
}
export const CURSOR_MARKER = "";
export const Key = {
  escape: "escape",
  enter: "enter",
  tab: "tab",
  home: "home",
  end: "end",
  pageUp: "pageUp",
  pageDown: "pageDown",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  shift(key) { return `shift+${key}`; },
  ctrlAlt(key) { return `ctrl-alt-${key}`; },
};

const RAW_KEYS = new Map([
  ["escape", "\x1b"],
  ["enter", "\r"],
  ["tab", "\t"],
  ["shift+tab", "\x1b[Z"],
  ["up", "\x1b[A"],
  ["down", "\x1b[B"],
  ["right", "\x1b[C"],
  ["left", "\x1b[D"],
  ["home", "\x1b[H"],
  ["end", "\x1b[F"],
  ["pageUp", "\x1b[5~"],
  ["pageDown", "\x1b[6~"],
]);

export function matchesKey(data, key) {
  return data === key || data === RAW_KEYS.get(key);
}

export function decodeKittyPrintable(data) {
  if (typeof data !== "string") return undefined;
  if (data.length === 1 && data >= " " && data !== "\x7f") return data;
  const match = /^\x1b\[(\d+)(?::(\d+))?(?:;(\d+))?u$/.exec(data);
  if (!match) return undefined;
  const code = Number(match[2] ?? match[1]);
  const modifiers = Number(match[3] ?? 1);
  if (modifiers > 2 || !Number.isFinite(code)) return undefined;
  return String.fromCodePoint(code);
}

export function parseKey(data) {
  if (typeof data !== "string") return undefined;
  if (data.length === 1 && data >= " ") return data;
  const kitty = decodeKittyPrintable(data);
  if (kitty) return kitty;
  const modified = /^\x1b\[27;(\d+);(\d+)~$/.exec(data);
  if (modified) {
    const modifier = Number(modified[1]);
    const char = String.fromCodePoint(Number(modified[2]));
    if (modifier === 2) {
      return `shift+${/^[A-Z]$/.test(char) ? char.toLowerCase() : char}`;
    }
  }
  return [...RAW_KEYS].find(([, raw]) => raw === data)?.[0];
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function getGraphemeSegmenter() {
  return graphemeSegmenter;
}

function charWidth(char) {
  const code = char.codePointAt(0);
  return code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60))
    ? 2
    : 1;
}

export function visibleWidth(value) {
  return Array.from(stripAnsi(value)).reduce((sum, char) => sum + charWidth(char), 0);
}

export function truncateToWidth(value, width, ellipsis = "...", pad = false) {
  let out = "";
  let used = 0;
  const chars = Array.from(stripAnsi(value));
  const total = visibleWidth(value);
  const suffix = total > width ? ellipsis : "";
  const limit = Math.max(0, width - visibleWidth(suffix));
  for (const char of chars) {
    const size = charWidth(char);
    if (used + size > limit) break;
    out += char;
    used += size;
  }
  if (total > width) out += suffix;
  if (pad) out += " ".repeat(Math.max(0, width - visibleWidth(out)));
  return out;
}

export function sliceByColumn(value, start, length) {
  let out = "";
  let column = 0;
  for (const char of Array.from(stripAnsi(value))) {
    const size = charWidth(char);
    if (column + size > start && column < start + length) out += char;
    column += size;
    if (column >= start + length) break;
  }
  return out;
}

export function wrapTextWithAnsi(value, width) {
  const output = [];
  for (const sourceLine of String(value).split("\n")) {
    if (!sourceLine) {
      output.push("");
      continue;
    }
    let rest = sourceLine;
    while (visibleWidth(rest) > width) {
      const line = truncateToWidth(rest, width, "");
      output.push(line);
      rest = Array.from(rest).slice(Array.from(line).length).join("");
    }
    output.push(rest);
  }
  return output;
}
