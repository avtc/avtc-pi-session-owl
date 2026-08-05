// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, it } from "vitest";
import { OBSERVER_SYSTEM } from "../../src/prompts/observer.js";

describe("OBSERVER_SYSTEM prompt", () => {
  it("is non-empty", () => {
    expect(OBSERVER_SYSTEM.length).toBeGreaterThan(0);
  });

  // String-equality snapshot guard: the prompt is approved protected text from
  // the design doc. Any change must be a deliberate re-approval, not a drift.
  it("matches the approved text exactly (drift guard)", () => {
    expect(OBSERVER_SYSTEM).toBe(
      [
        "You read one chunk of a coding session and record observations — each one a",
        "piece of information worth keeping, captured concisely as its essential meaning.",
        "Once the raw messages are compacted away, these observations become the agent's",
        "memory of this chunk.",
        "The full detail stays in the source: a decision is worth its outcome and",
        "rationale, not the discussion; a constraint is worth its rule, not the exchange",
        "that surfaced it.",
        "",
        "The chunk is a sequence of tagged blocks; each carries its source entry id as",
        "entry=id:",
        "- <USER entry=id>  <ASSISTANT entry=id>  <THINKING entry=id>",
        "- <TOOLCALL:name entry=id> — immediately followed by its own result",
        "  <TOOLRESULT entry=id> (or <TOOLRESULT entry=id error> when the call failed)",
        "",
        "Each observation carries an importance — how much it matters if lost, by nature:",
        "- crit — a hard, persistent constraint or correction; losing it would cause",
        "  real harm",
        "- high — a decision, choice, or unresolved blocker",
        "- med — meaningful context that is not itself a decision or constraint",
        "- low — routine activity or minor detail with little durable consequence",
        "",
        "Call record_observations with a batch (array) of observations, as many times as",
        "needed to cover the chunk. Each item has three fields: summary (the concise",
        "observation — the full detail stays in the source), importance, and sourceEntryIds (the source entry ids it draws on",
        "— an observation may span several blocks). When the chunk is fully covered, reply",
        "with the single word Done; if the chunk has nothing worth capturing, skip the",
        "tool and reply Done.",
        "",
        "Examples:",
        '- summary: "Every commit must keep the build green." — importance: crit —',
        '  sourceEntryIds: ["12"]',
        '- summary: "Chose vitest for all new tests." — importance: high —',
        '  sourceEntryIds: ["7", "9"]',
      ].join("\n"),
    );
  });
});
