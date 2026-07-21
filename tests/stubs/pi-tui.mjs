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
export const CURSOR_MARKER = "";
export const Key = {
  ctrlAlt(key) { return `ctrl-alt-${key}`; },
};
