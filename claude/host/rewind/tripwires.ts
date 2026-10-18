// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Layer 3 — the truncation tripwires. `session.measure` reports the live
// context fill after each turn (and on plan-limit changes). A fill DROP with
// no owl compaction answered and no `compaction` row observed means the
// conversation shrank outside owl's knowledge — a rewind, or an orphaned
// fork — and triggers the canonical-view check immediately. Native
// compactions write door-`compaction` rows; if they do not arrive as
// events, the tripwire still fires the api-form check a turn later —
// bounded either way. Keys are per-conversation (the main session and each
// subagent loop are separate series).

interface KeyState {
  lastFill: number | null;
  suppressed: boolean;
  suspected: boolean;
}

/** The per-conversation tripwire state (in-memory; resets with the process). */
export class TruncationTripwires {
  private readonly keys = new Map<string, KeyState>();

  private stateFor(key: string): KeyState {
    let s = this.keys.get(key);
    if (s === undefined) {
      s = { lastFill: null, suppressed: false, suspected: false };
      this.keys.set(key, s);
    }
    return s;
  }

  /** Record a measure fill for a conversation. A drop against the previous
   *  fill, with no suppression marker outstanding, raises the suspicion. */
  observeMeasure(key: string, fill: number): void {
    const s = this.stateFor(key);
    if (s.lastFill !== null && fill < s.lastFill) {
      s.suspected = s.suppressed ? s.suspected : true;
    }
    // the marker covered this transition — it clears on use
    s.suppressed = false;
    s.lastFill = fill;
  }

  /** Owl answered a compaction on this key — the NEXT fill drop is explained. */
  noteOwlCompactionAnswered(key: string): void {
    this.stateFor(key).suppressed = true;
  }

  /** A door-compaction row was observed (any key — native compaction rows
   *  explain the main fill's next drop). */
  noteCompactionRow(_uuid: string): void {
    for (const s of this.keys.values()) s.suppressed = true;
  }

  /** The current suspicion for a key. */
  evaluate(key: string): { suspected: boolean } {
    const s = this.keys.get(key);
    return { suspected: s?.suspected ?? false };
  }

  /** A clean layered check clears the suspicion (the baseline stays — the
   *  post-rewind fill is now the truth a FUTURE drop compares against). */
  markCheckedClean(key: string): void {
    this.stateFor(key).suspected = false;
  }

  /** Release every key's series (session end — the map never leaks). */
  releaseAll(): void {
    this.keys.clear();
  }
}
