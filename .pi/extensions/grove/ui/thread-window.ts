/**
 * Floating/maximized read-only chat thread viewer for a selected Grove node.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { SessionNode } from "../backend/types";
import type { NodeColorSlot } from "./graph-view-model";
import { printableKey } from "./printable-key";
import type { NodeThread, ThreadItem } from "./thread-loader";

export interface ThreadWindowState {
  scrollOffset: number;
  maximized: boolean;
}

export interface ThreadWindowCallbacks {
  close: () => void;
  toggleMaximize: (state: ThreadWindowState) => void;
  switchNode: (direction: -1 | 1, state: ThreadWindowState) => void;
  requestRender: () => void;
}

type GroveTheme = Pick<Theme, "fg" | "bg" | "bold" | "italic" | "underline" | "strikethrough">;

function padVisible(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function markdownTheme(theme: GroveTheme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", theme.bold(text)),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
  };
}

function itemLabel(item: ThreadItem): string {
  switch (item.kind) {
    case "user":
      return "You";
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool";
    case "custom":
      return "Context";
    case "summary":
      return "Summary";
    default:
      return "System";
  }
}

function itemColor(item: ThreadItem): string {
  switch (item.kind) {
    case "user":
      return "accent";
    case "assistant":
      return "success";
    case "tool":
      return "warning";
    case "custom":
      return "customMessageLabel";
    case "summary":
      return "mdHeading";
    default:
      return "muted";
  }
}

export class ThreadWindow implements Component, Focusable {
  focused = false;
  private thread: NodeThread | null = null;
  private loading = true;
  private error = "";
  private viewportHeight: number;
  private scrollOffset: number;
  private renderedContentHeight = 0;

  constructor(
    private node: SessionNode,
    private colorSlot: NodeColorSlot,
    private readonly theme: GroveTheme,
    private maximized: boolean,
    viewportHeight: number,
    private readonly callbacks: ThreadWindowCallbacks,
    initialScrollOffset = 0,
  ) {
    this.viewportHeight = Math.max(8, viewportHeight);
    this.scrollOffset = Math.max(0, initialScrollOffset);
  }

  setNode(node: SessionNode, colorSlot: NodeColorSlot): void {
    this.node = node;
    this.colorSlot = colorSlot;
    this.thread = null;
    this.loading = true;
    this.error = "";
    this.scrollOffset = 0;
  }

  setViewportHeight(height: number): void {
    this.viewportHeight = Math.max(8, height);
  }

  setThread(thread: NodeThread): void {
    if (thread.nodeId !== this.node.nodeId) return;
    this.thread = thread;
    this.loading = false;
    this.error = "";
  }

  setError(error: string): void {
    this.loading = false;
    this.error = error;
  }

  getState(): ThreadWindowState {
    return {
      scrollOffset: this.scrollOffset,
      maximized: this.maximized,
    };
  }

  private clampScroll(): void {
    const bodyHeight = Math.max(1, this.viewportHeight - 4);
    this.scrollOffset = Math.max(
      0,
      Math.min(this.scrollOffset, Math.max(0, this.renderedContentHeight - bodyHeight)),
    );
  }

  private scroll(delta: number): void {
    this.scrollOffset += delta;
    this.clampScroll();
    this.callbacks.requestRender();
  }

  handleInput(data: string): void {
    const page = Math.max(3, this.viewportHeight - 7);
    const printable = printableKey(data);
    if (matchesKey(data, Key.escape) || printable === "q") {
      this.callbacks.close();
      return;
    }
    if (printable === "m") {
      this.callbacks.toggleMaximize(this.getState());
      return;
    }
    if (printable === "[") {
      this.callbacks.switchNode(-1, this.getState());
      return;
    }
    if (printable === "]") {
      this.callbacks.switchNode(1, this.getState());
      return;
    }
    if (printable === "j" || matchesKey(data, Key.down)) this.scroll(1);
    else if (printable === "k" || matchesKey(data, Key.up)) this.scroll(-1);
    else if (matchesKey(data, Key.pageDown)) this.scroll(page);
    else if (matchesKey(data, Key.pageUp)) this.scroll(-page);
    else if (matchesKey(data, Key.home)) {
      this.scrollOffset = 0;
      this.callbacks.requestRender();
    } else if (matchesKey(data, Key.end)) {
      this.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.callbacks.requestRender();
    }
  }

  invalidate(): void {
    /* rendering is derived from current state */
  }

  private renderItem(item: ThreadItem, width: number): string[] {
    const innerWidth = Math.max(4, width - 2);
    const label = this.theme.fg(
      itemColor(item) as any,
      this.theme.bold(itemLabel(item)),
    );
    const timestamp = item.timestamp
      ? this.theme.fg("dim", `  ${new Date(item.timestamp).toLocaleTimeString()}`)
      : "";
    const header = padVisible(` ${label}${timestamp}`, innerWidth);
    const markdown = new Markdown(
      item.text,
      1,
      0,
      markdownTheme(this.theme),
      { color: (text) => this.theme.fg("text", text) },
    ).render(Math.max(1, innerWidth));
    const body = markdown.length
      ? markdown.map((line) => padVisible(line, innerWidth))
      : [padVisible(this.theme.fg("muted", " (empty)"), innerWidth)];
    const background =
      item.kind === "user"
        ? (line: string) => this.theme.bg("userMessageBg", line)
        : item.kind === "custom" || item.kind === "summary"
          ? (line: string) => this.theme.bg("customMessageBg", line)
          : (line: string) => line;
    return [background(header), ...body.map(background), " ".repeat(innerWidth)];
  }

  private contentLines(width: number): string[] {
    const innerWidth = Math.max(4, width - 2);
    if (this.loading) {
      return [
        "",
        padVisible(this.theme.fg("warning", "  Loading anchored thread…"), innerWidth),
      ];
    }
    if (this.error) {
      return wrapTextWithAnsi(
        this.theme.fg("error", `Unable to load thread: ${this.error}`),
        innerWidth,
      ).map((line) => padVisible(` ${line}`, innerWidth));
    }
    if (!this.thread?.items.length) {
      return [
        "",
        padVisible(this.theme.fg("muted", "  No chat messages at this node."), innerWidth),
      ];
    }
    const lines = this.thread.items.flatMap((item) => this.renderItem(item, width));
    if (this.thread.truncatedAtAnchor) {
      lines.push(
        padVisible(
          this.theme.fg("dim", " Thread stops at this node's SessionAnchor."),
          innerWidth,
        ),
      );
    }
    return lines;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const innerWidth = safeWidth - 2;
    const mode = this.maximized ? "MAXIMIZED" : "FLOATING";
    const rightTitle = ` ${mode} `;
    const title = truncateToWidth(
      ` ${this.node.label} · Chat Thread `,
      Math.max(1, innerWidth - visibleWidth(rightTitle)),
      "…",
    );
    const titleSpace = Math.max(0, innerWidth - visibleWidth(title) - visibleWidth(rightTitle));
    const top =
      this.theme.fg(this.colorSlot as any, "╭" + title) +
      this.theme.fg("borderMuted", "─".repeat(titleSpace)) +
      this.theme.fg(this.colorSlot as any, rightTitle + "╮");

    const content = this.contentLines(safeWidth);
    this.renderedContentHeight = content.length;
    this.clampScroll();
    if (this.scrollOffset === Number.MAX_SAFE_INTEGER) this.clampScroll();
    const bodyHeight = Math.max(1, this.viewportHeight - 4);
    const visible = content.slice(this.scrollOffset, this.scrollOffset + bodyHeight);
    while (visible.length < bodyHeight) visible.push(" ".repeat(innerWidth));
    const body = visible.map(
      (line) =>
        this.theme.fg(this.colorSlot as any, "│") +
        padVisible(line, innerWidth) +
        this.theme.fg(this.colorSlot as any, "│"),
    );
    const position = `${Math.min(this.scrollOffset + 1, Math.max(1, content.length))}/${Math.max(1, content.length)}`;
    const footerText = ` j/k scroll · PgUp/PgDn · [/] node · m ${this.maximized ? "restore" : "maximize"} · Esc close `;
    const footer = truncateToWidth(
      footerText,
      Math.max(1, innerWidth - visibleWidth(position) - 1),
      "…",
    );
    const gap = Math.max(0, innerWidth - visibleWidth(footer) - visibleWidth(position));
    const bottom =
      this.theme.fg(this.colorSlot as any, "╰") +
      this.theme.fg("borderMuted", footer + "─".repeat(gap)) +
      this.theme.fg("dim", position) +
      this.theme.fg(this.colorSlot as any, "╯");
    return [top, ...body, bottom];
  }
}
