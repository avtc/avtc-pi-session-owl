// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMKEEPER_SCHEMA } from "../../src/config/schema.js";

const CONFIG_PATH = resolve(__dirname, "../../docs/CONFIGURATION.md");
const README_PATH = resolve(__dirname, "../../README.md");

/** Extract every documented knob id from CONFIGURATION.md. Knobs are rendered
 *  as table rows whose first cell is a backticked id: `` | `enabled` `` . */
function documentedKnobIds(): string[] {
  const text = readFileSync(CONFIG_PATH, "utf8");
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    const match = /^\|\s*`([a-zA-Z][a-zA-Z0-9]*)`\s*\|/.exec(line);
    if (match) {
      ids.add(match[1] as string);
    }
  }
  // The layered-persistence table also uses `| path |`-style cells but none are
  // bare backticked single-word ids in the setting column, so no false matches.
  return [...ids].sort();
}

describe("docs/CONFIGURATION.md parity with MEMKEEPER_SCHEMA", () => {
  it("documents exactly the schema's setting ids (no drift either way)", () => {
    const schemaIds = MEMKEEPER_SCHEMA.settings.map((s) => s.id).sort();
    const docIds = documentedKnobIds();
    expect(docIds).toEqual(schemaIds);
  });
});

describe("README render-format example parity", () => {
  it("uses the current render format: kind icons, word counts, text importance", () => {
    const text = readFileSync(README_PATH, "utf8");
    // current format: grammar-correct child/size counts in words
    expect(text).toMatch(/\dnodes \d+obs/);
    expect(text).toMatch(/\dlines? \d+tokens?/);
    // importance rendered as text words, not the dropped colored-dot circles
    expect(text).toMatch(/crit|high|med|low/);
    // node/observation lines carry the kind icons after any indent
    expect(text).toContain("📁 nGoal");
    expect(text).toContain("  📁 n12");
    expect(text).toContain("    📄 o31");
    // the dropped importance circles must not reappear
    expect(text).not.toMatch(/🔴|🟠|🟡|⚪/);
  });
});
