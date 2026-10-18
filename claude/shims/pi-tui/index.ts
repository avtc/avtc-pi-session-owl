// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Local shim for @earendil-works/pi-tui inside the packaged plugin. The
// vendored core's only pi-tui VALUE import is Text (recall/owl-recall.ts,
// `import { type Component, Text } from "@earendil-works/pi-tui"`); the
// widget surface is host code and never loads from here. Constructor and
// method shapes copied from pi-tui's dist/components/text.d.ts (v1.x);
// render() does greedy word wrapping like pi-tui's Text.

/** A renderable component (pi-tui dist/tui.d.ts `Component` — the
 *  required members; the optional input/mouse handlers are not part of the
 *  vendored core's usage). */
export interface Component {
  /** Render the component to lines for the given viewport width. */
  render(width: number): string[];
  /** Invalidate cached rendering state (re-render from scratch). */
  invalidate(): void;
}

/** Multi-line text with word wrapping (pi-tui's Text, minimal form). */
export class Text implements Component {
  private text: string;
  private paddingX: number;
  private paddingY: number;
  private customBgFn?: (text: string) => string;

  constructor(text = "", paddingX = 1, paddingY = 1, customBgFn?: (text: string) => string) {
    this.text = text;
    this.paddingX = paddingX;
    this.paddingY = paddingY;
    this.customBgFn = customBgFn;
  }

  setText(text: string): void {
    this.text = text;
  }

  setCustomBgFn(customBgFn?: (text: string) => string): void {
    this.customBgFn = customBgFn;
  }

  invalidate(): void {
    // no cache in the minimal form
  }

  render(width: number): string[] {
    const inner = Math.max(0, width - this.paddingX * 2);
    const pad = " ".repeat(this.paddingX);
    const lines: string[] = [];
    for (const paragraph of this.text.split("\n")) {
      let line = "";
      for (const word of paragraph.split(" ")) {
        const candidate = line === "" ? word : `${line} ${word}`;
        if (candidate.length > inner && line !== "") {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }
    const out = lines.map((l) => {
      const padded = `${pad}${l}${pad}`;
      return this.customBgFn ? this.customBgFn(padded) : padded;
    });
    for (let i = 0; i < this.paddingY; i += 1) {
      out.unshift(" ".repeat(width));
      out.push(" ".repeat(width));
    }
    return out;
  }
}
