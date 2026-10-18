// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

//  ledger inputs — the cost seam. The platform's turn.complete usage
// carries NO cost (the API reports token counts only), so owl computes it
// owl-side from token counts × model rates — pi-ai's behavior when a
// provider omits rates maps to null: the cost zeroes and the shim logs one
// line. The rates table is the known Claude families (USD per million
// tokens, the catalog prices); anything else (a gateway alias, an unknown
// id) is honestly unknown → null → zeroed + logged, never guessed.
import { describe, expect, test } from "vitest";
import { lookupModelRates } from "../../host/usage/inputs.js";

describe("lookupModelRates", () => {
  test("known Claude families resolve by longest-prefix match", () => {
    expect(lookupModelRates("claude-opus-4-7")).toEqual({ inputPerM: 15, outputPerM: 75 });
    // the 4-5 tier priced separately (longest prefix wins over claude-opus-4)
    expect(lookupModelRates("claude-opus-4-5")).toEqual({ inputPerM: 5, outputPerM: 25 });
    expect(lookupModelRates("claude-opus-4-5-20251101")).toEqual({ inputPerM: 5, outputPerM: 25 });
    expect(lookupModelRates("claude-sonnet-4-6-20261001")).toEqual({ inputPerM: 3, outputPerM: 15 });
    expect(lookupModelRates("claude-haiku-4-5")).toEqual({ inputPerM: 1, outputPerM: 5 });
    expect(lookupModelRates("claude-haiku-4-6-20260101")).toEqual({ inputPerM: 1, outputPerM: 5 });
    // an exact alias form (no date suffix) still matches its family
    expect(lookupModelRates("claude-opus-4-1")).toEqual({ inputPerM: 15, outputPerM: 75 });
  });

  test("unknown models yield null — zeroed + logged, never guessed", () => {
    expect(lookupModelRates("mimo-v2.6-flash")).toBeNull();
    expect(lookupModelRates("")).toBeNull();
    expect(lookupModelRates("claude-future-9")).toBeNull();
  });
});
