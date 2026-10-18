// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

//  ledger inputs — the cost seam. The platform's turn.complete usage
// carries NO cost (the API reports token counts only), so owl computes it
// owl-side from token counts × model rates — pi-ai's behavior when a
// provider omits rates maps to null here: the cost zeroes and the shim's
// own computeCost (pinned in shim-runstage.spec) logs one line. The table
// below is the known Claude families (USD per million tokens, the catalog
// prices); anything else (a gateway alias, an unknown id) is honestly
// unknown → null → zeroed + logged, never guessed.
import type { ModelRates } from "../../shims/pi-agent-core/index.js";

/** One family entry: the id PREFIX (the part before any date suffix) and
 *  its per-million rates. Longest prefix wins. */
const FAMILY_RATES: ReadonlyArray<{ prefix: string; rates: ModelRates }> = [
  { prefix: "claude-opus-4-5", rates: { inputPerM: 5, outputPerM: 25 } },
  { prefix: "claude-opus-4", rates: { inputPerM: 15, outputPerM: 75 } },
  { prefix: "claude-sonnet-4", rates: { inputPerM: 3, outputPerM: 15 } },
  { prefix: "claude-haiku-4", rates: { inputPerM: 1, outputPerM: 5 } },
  { prefix: "claude-3-7-sonnet", rates: { inputPerM: 3, outputPerM: 15 } },
  { prefix: "claude-3-5-haiku", rates: { inputPerM: 0.8, outputPerM: 4 } },
];

/** Resolve a model id's rates by longest family-prefix match; null when the
 *  model is unknown (a gateway alias, a future id) — the caller zeroes the
 *  cost and logs, never guesses. */
export function lookupModelRates(model: string): ModelRates | null {
  let best: { prefix: string; rates: ModelRates } | null = null;
  for (const entry of FAMILY_RATES) {
    if (model.startsWith(entry.prefix)) {
      if (best === null || entry.prefix.length > best.prefix.length) best = entry;
    }
  }
  return best === null ? null : best.rates;
}
