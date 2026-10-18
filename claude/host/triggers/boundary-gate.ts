// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The boundary gate: stage launches happen only at turn completions that
// concluded a REAL round — one carrying assistant rows that are new since
// the last launch. A resumed session's dangling boundary (the engine
// completes the replayed turn's bookkeeping as the continuation prompt
// arrives) carries no new assistant content and must not launch stages.

/** The mirrored rows the gate reads (arrival order; each row's message
 *  kind — the engine rows carry `role`, captured envelopes may carry only
 *  `type`, and both spell the assistant's side of a round). */
export interface GateRow {
  uuid: string;
  kind: string | undefined;
}

/** The newest assistant row's uuid, or null with none. */
export function newestAssistantUuid(rows: readonly GateRow[]): string | null {
  let newest: string | null = null;
  for (const row of rows) {
    if (row.kind === "assistant") newest = row.uuid;
  }
  return newest;
}

/** Whether this boundary concludes a real round: the newest assistant row
 *  exists and differs from the one the last launch fired on. Null history
 *  (first ever boundary) still requires assistant content — a session's
 *  first round must complete before any stage work. */
export function shouldFireBoundary(rows: readonly GateRow[], lastFiredAssistant: string | null): boolean {
  const newest = newestAssistantUuid(rows);
  return newest !== null && newest !== lastFiredAssistant;
}
