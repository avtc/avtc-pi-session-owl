// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// TurnUsage → CompletionUsage: the turn.complete envelope's API-reported
// usage (snake_case counts + model id) into the shim's StageUsage source.
// Pure data in/out; import-free so it sits inside the hooks closure.
import type { CompletionUsage } from "../engine-bridge.js";

/** Read a turn.complete's usage field (null when absent/malformed). */
export function completionUsageOf(raw: unknown): CompletionUsage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  return {
    input: Number(r.input_tokens ?? 0),
    output: Number(r.output_tokens ?? 0),
    cacheRead: Number(r.cache_read_input_tokens ?? 0),
    cacheWrite: Number(r.cache_creation_input_tokens ?? 0),
    model: String(r.model ?? ""),
  };
}
