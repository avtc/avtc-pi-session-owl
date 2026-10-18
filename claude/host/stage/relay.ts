// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The turn.step relay — the port's run control over engine-owned agent
// loops. pi runs its stages through an in-process agentLoop whose knobs
// (AbortSignal, per-call llmCallTimeoutMs, per-call maxTokens, the
// Observer's no-progress rule) it owns directly; the engine owns the loop
// here, and this relay holds the same levers from the event layer:
//
//   abort      once a run's abort flag is set, every further step of that
//              agent is answered with a fabricated end_turn — milliseconds,
//              zero real model calls (the engine re-asks while tool results
//              are pending; every re-ask is answered before any request
//              goes out);
//   timeout    each step races the engine iterator against the per-call
//              timeout (pi's fetch-wrapping controller, re-armed per call by
//              construction); a stalled stream fabricates the stop and marks
//              the run timedOut;
//   cap        streamed tokens (text/thinking/tool-arg JSON) are counted per
//              step; at the stage's cap the step ends with a synthetic
//              'max_tokens' stop and its tool calls are rejected (the
//              text streamed up to the cap stays);
//   no-progress steps with zero accepted records count against the run; the
//              configured count trips the abort flag (the NEXT step then
//              fabricates) — streamed text does NOT reset it (pi parity).
//
// `{deny}` keeps its real role (validation refusal) — never used here.
// Timers come in as a clock capsule (`$.clock.after`): timer callbacks carry
// no `$`, so flags set by them are read at the next hook dispatch.
//
// Chunk/result shapes mirror the engine's generated types (TurnStepChunk /
// TurnStepResult), spelled structurally; the only import is the runs module
// (itself import-free), so this file stays inside the hooks closure.

import { errDetail, sayError } from "../log/err-detail.js";
import { markFabricatedStop } from "./dumps.js";
import { completeStep, getStageRun, timeoutRun } from "./runs.js";

/** A cancellable timer (the `$.clock.after` capsule's return). */
export interface TimerHandle {
  cancel: () => void;
}

/** The `next` seam of a turn.step dispatch: the chain's stream for the step. */
export type StepStream = (e: unknown) => AsyncGenerator<unknown, unknown>;

/** Relay options: the timer capsule (register arms it from `$.clock.after`). */
export interface RelayOptions {
  clockAfter: (ms: number, fn: () => void) => TimerHandle;
}

/** One streamed chunk the relay understands (the kinds it counts/drops on). */
interface Chunk {
  kind: string;
  text?: string;
  json?: string;
}

/** The four counts + answering model a real step's resolved value carries
 *  (the engine's TurnUsage: Anthropic spelling, one per request). */
export interface StepUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  model: string;
}

/** The step result the relay returns (a structural echo of TurnStepResult). */
export interface StepResult {
  turnId: unknown;
  index: unknown;
  answer: string;
  toolUses: unknown[];
  stopReason: string | null;
  usage: StepUsage | null;
}

/** The streaming-tier token estimate: chars/4 per chunk delta, ceiled —
 *  pi's `deltaTokens` unit (streaming-tokens.ts), not the whole-string
 *  `estimateContentTokens` (which would under-count across many chunks). */
export function estimateStepTokens(_kind: "text" | "thinking" | "input", text: string): number {
  return Math.ceil(text.length / 4);
}

/** Step values pass through untouched: the pass-through arm and the
 *  real-stream completion both return the chain's OWN resolved value (a
 *  reconstruction would strip fields like serverToolUses/usage from what
 *  hooks above owl read); the fabricated arms build their objects via
 *  fabricate(). */

/** Fabricate a step response: no tool calls, no usage. */
function fabricate(
  e: { turnId: unknown; index: number },
  stopReason: "end_turn" | "max_tokens",
  answer: string,
): StepResult {
  return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason, usage: null };
}

/** Close the message the step opened on the run's event sink — the widget's
 *  per-request context lens. pi's in-process agent loop emits a real
 *  `message_end` per assistant message; this engine-owned loop relays through
 *  the hook layer, so the relay writes it (the tracker consumed hand-fed
 *  events while no live source existed — the ctx slot collapsed to `?` for
 *  every stage). With the response's usage: four counts -> totalTokens (the
 *  stage completion's own proven derivation) + the answering model, accrual-
 *  neutral side counts so the run-completion `message_end` stays the single
 *  summing source. Without: the pair still closes and the last reading stands
 *  (the tracker's last-wins rule). */
function closeStep(onEvent: ((event: unknown) => void) | null, result: unknown): void {
  if (onEvent === null) return;
  const u = (result as { usage?: StepUsage } | null | undefined)?.usage;
  if (u === undefined || u === null || typeof u.input_tokens !== "number") {
    onEvent({ type: "message_end", message: {} });
    return;
  }
  const totalTokens = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
  onEvent({
    type: "message_end",
    message: {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens },
      ...(typeof u.model === "string" && u.model.length > 0 ? { model: u.model } : {}),
    },
  });
}

/** Read a chunk's countable text (text/thinking deltas, tool-arg JSON). */
function chunkText(chunk: Chunk): string | null {
  if (chunk.kind === "text" || chunk.kind === "thinking") return chunk.text ?? "";
  if (chunk.kind === "input") return chunk.json ?? "";
  return null;
}

/** Extract the agentId from a step envelope (absent on the main loop). */
function agentIdOf(e: unknown): string | undefined {
  const id = (e as { agentId?: unknown }).agentId;
  return typeof id === "string" ? id : undefined;
}

export async function* relayTurnStep(
  e: { turnId: unknown; index: number; agentId?: string },
  next: StepStream,
  opts: RelayOptions,
): AsyncGenerator<unknown, unknown> {
  const run = getStageRun(agentIdOf(e));

  // The main loop and every non-stage agent relay untouched — the chain's
  // OWN resolved value passes as-is (a reconstruction here would strip
  // every field outside owl's local slice — serverToolUses, the real
  // usage — from what hooks ABOVE owl read; the value IS a well-formed
  // TurnStepResult by the engine's contract).
  if (run === undefined) {
    const result = yield* next(e);
    return result;
  }

  // Abort: answered before any request goes out.
  if (run.abortFlag) {
    markFabricatedStop(run, run.abortReason ?? "signal");
    return fabricate(e, "end_turn", "");
  }

  let countedTokens = 0;
  const streamedText: string[] = [];
  // a step IS one model request: pi's per-call message_start zeroes the
  // streaming counters before the first delta lands
  if (run.onEvent !== null) run.onEvent({ type: "message_start" });

  // The inter-token stall race: timeoutMs bounds the SILENCE between
  // consecutive response bytes of the step — the request→first-byte gap and
  // every byte→byte gap mid-stream alike (silence longer than the window
  // between tokens, while the response is unfinished, is a stall). Each
  // arriving chunk RE-ARMS the
  // window, so an active stream — however slow its total — never trips it;
  // only silence longer than the window while the response is unfinished
  // aborts (a stalled provider, a broken stream). Waiting on next() is
  // in-flight time, outside the hook's own-code budget. The timer's
  // callback resolves the race's stall side directly — a never-yielding
  // stream must not hang the relay.
  const windowMs = run.config.timeoutMs;
  const handle: { timer: TimerHandle | null; stalled: Promise<"stalled"> | null } = {
    timer: null,
    stalled: null,
  };
  const armWindow = (): void => {
    if (windowMs === null) return;
    handle.timer?.cancel();
    handle.stalled = new Promise((resolve) => {
      handle.timer = opts.clockAfter(windowMs, () => resolve("stalled"));
    });
  };
  armWindow(); // the first gap: request → first response byte

  const it = next(e) as AsyncGenerator<unknown, unknown, unknown>;
  try {
    for (;;) {
      const gap = handle.stalled;
      const winner = gap === null ? await it.next() : await Promise.race([it.next(), gap]);
      if (winner === "stalled") {
        timeoutRun(run.agentId);
        markFabricatedStop(run, "timeout");
        void it.return?.(undefined).catch((err: unknown) => {
          // closing the stage stream failed — cosmetic for the run (its
          // stop is already fabricated+recorded) but still said, with stack
          sayError(`session-owl: stage stream close failed: ${errDetail(err)}`);
        });
        closeStep(run.onEvent, null);
        return fabricate(e, "end_turn", "");
      }
      if (winner.done) {
        // No-progress bookkeeping at step completion; a trip sets the abort
        // flag (the NEXT step fabricates — this one was real). The chain's
        // own value passes as-is — a REAL stream completed, so the result
        // is the engine's TurnStepResult (owl's own loops included).
        completeStep(run.agentId);
        // The widget's per-step context closes BEFORE the value leaves: this
        // iterator's done-value IS the `yield* next(e)` response the tracker
        // reads per request (the probe: per-request usage inside it).
        closeStep(run.onEvent, winner.value);
        return winner.value;
      }
      // A mid-stream abort suppresses the in-flight tool calls: the stream
      // stops relaying and the step fabricates its end (the engine records
      // no tool call whose tool chunk never left the chain).
      if (run.abortFlag) {
        void it.return?.(undefined).catch((err: unknown) => {
          // closing the stage stream failed — cosmetic for the run (its
          // stop is already fabricated+recorded) but still said, with stack
          sayError(`session-owl: stage stream close failed: ${errDetail(err)}`);
        });
        markFabricatedStop(run, run.abortReason ?? "signal");
        closeStep(run.onEvent, null);
        return fabricate(e, "end_turn", "");
      }
      // a byte landed: re-arm the window for the NEXT gap (the old timer
      // is cancelled inside armWindow — its stall promise goes orphaned)
      armWindow();
      const chunk = winner.value as Chunk;
      const text = chunkText(chunk);
      if (text !== null) {
        // the dump's <output> rows come from the CAPTURE layer's append-row
        // recordings (the run's message view, tool results included) — the
        // relay's chunk stream is the token-count input, not a second output
        // source (no double capture)
        countedTokens += estimateStepTokens(chunk.kind as "text" | "thinking" | "input", text);
        if (chunk.kind === "text") streamedText.push(text);
        // The widget's live stream (pi's message_update feed): each delta
        // reaches the tracker bridge through the run's event sink — the
        // band's tok counter tracks the generation the person watches.
        if (run.onEvent !== null) {
          const kind = chunk.kind;
          run.onEvent({
            type: "message_update",
            assistantMessageEvent: {
              type: kind === "text" ? "text_delta" : kind === "thinking" ? "thinking_delta" : "toolcall_delta",
              delta: text,
            },
          });
        }
        if (countedTokens >= run.config.maxTokens) {
          // The cap: end the step with a synthetic max_tokens stop. The
          // chunk that reached the cap stays streamed (pi truncation keeps
          // the partial); the pending tool calls are rejected.
          yield chunk;
          markFabricatedStop(run, "max_tokens");
          void it.return?.(undefined).catch((err: unknown) => {
            // closing the stage stream failed — cosmetic for the run (its
            // stop is already fabricated+recorded) but still said, with stack
            sayError(`session-owl: stage stream close failed: ${errDetail(err)}`);
          });
          closeStep(run.onEvent, null);
          return fabricate(e, "max_tokens", streamedText.join(""));
        }
      }
      yield chunk;
    }
  } finally {
    handle.timer?.cancel();
  }
}
