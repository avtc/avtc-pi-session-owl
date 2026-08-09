// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * agentLoop stage-runner seam.
 *
 * A single helper every LLM stage (Observer / Builder / Selector) calls to run
 * its `agentLoop`. Owns: building `AgentContext` / `AgentLoopConfig`, draining
 * the `EventStream`, accumulating per-run usage, two-tier streaming-output-token
 * tracking, cooperative abort, and the `onEvent` sink for the widget.
 *
 * Owns NOTHING about the run-lock, the prompt, or the tools — each stage
 * provides those. This module is pure plumbing.
 */

import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import { agentLoop } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { log } from "../log.js";
import { deltaTextOf, deltaTokens, messageEndUsage } from "./streaming-tokens.js";

// --- named sentinels (no bare literals at call sites) ----------------------

/** `maxTurns` / `reasoning` / `onEvent` / `onStageEnd` / `loopFn` "not set" value. */
export const NO_TURN_LIMIT = null;
export const NO_REASONING = null;
export const NO_EVENT_SINK = null;
export const NO_STAGE_END_HOOK = null;
export const NO_LOOP_OVERRIDE = null;

/** Sequential tool execution (memkeeper stages run tools one-by-one). */
export const SEQUENTIAL = "sequential" as const;

/** Per-run usage accumulated by a stage (input/output/cacheRead/cost/turns). */
export interface StageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
  turns: number;
  /** Wall-clock milliseconds the stage call spent running (LLM + tool calls). */
  elapsedMs: number;
}

/** What `runStage` returns on a clean (non-throwing) run. */
export interface StageRunResult {
  messages: AgentMessage[];
  usage: StageUsage;
  /** Final two-tier output-token count (primary usage.output, fallback chars/4). */
  outputTokens: number;
  /** True when `input.signal` (the run/compaction signal) was aborted during the run. */
  aborted: boolean;
  /** True when the per-LLM-call timeout fired (distinct from a run-signal abort).
   *  Surfaced so the caller can STOP the stage + notify (a timeout is an error
   *  condition, not a silent no-op pass). */
  timedOut: boolean;
}

/** Input to `runStage`. Every field is required; pass a `NO_*` sentinel for "absent". */
export interface StageRunInput {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: AgentTool[];
  model: Model<Api>;
  apiKey: string | undefined;
  signal: AbortSignal;
  /** Thinking level, or `NO_REASONING` to omit. */
  reasoning: ThinkingLevel | null;
  /** Per-pass turn cap, or `NO_TURN_LIMIT` for unbounded. */
  maxTurns: number | null;
  /** Maximum output tokens per LLM call (per agentLoop turn). Applied to every
   *  provider request; a response hitting it is truncated and its tool calls
   *  rejected. Bounds runaway generation. */
  maxTokens: number;
  /** Per-LLM-call wall-clock timeout (ms), or `null` = no limit. Re-armed each
   *  turn via the transformContext seam; aborting the in-flight fetch ends the
   *  run. Bounds stalled/slow generation. */
  timeoutMs: number | null;
  /** Widget/ledger event sink, or `NO_EVENT_SINK`. */
  onEvent: ((event: AgentEvent) => void) | null;
  /** Fired once at stage end with the accumulated (possibly partial) usage, or `NO_STAGE_END_HOOK`. */
  onStageEnd: ((usage: StageUsage) => void) | null;
  /** Test seam — fake loop override, or `NO_LOOP_OVERRIDE` for the real `agentLoop`. */
  loopFn: typeof agentLoop | null;
}

/** A stage run failure. The `onStageEnd` hook fires in `runStage`'s finally
 *  regardless of success/failure, so the ledger already folds partial usage —
 *  this error carries only the cause (no redundant usage/aborted fields). */
export class StageRunError extends Error {
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`stage run failed: ${msg}`, { cause });
    this.name = "StageRunError";
  }
}

/** A per-LLM-call timeout — a stage-stopping error. Propagates to the compaction
 *  hook (which cancels compaction + notifies the user) so a slow/oversized call
 *  surfaces instead of silently producing a partial/wrong summary. */
export class StageTimeoutError extends Error {
  constructor(stage: string, limitMs: number | null) {
    const limit = limitMs === null ? "the time limit" : `${Math.round(limitMs / 1000)}s time limit`;
    super(`${stage} stopped: an LLM call exceeded the ${limit}`);
    this.name = "StageTimeoutError";
  }
}

/** A fresh zeroed usage accumulator. */
function emptyUsage(): StageUsage {
  return { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0, elapsedMs: 0 };
}

/**
 * Build a `shouldStopAfterTurn` that caps a run at `maxTurns` completed turns
 * (counted from `turn_end` callbacks). `null` ⇒ never stop.
 */
export function makeTurnCap(
  maxTurns: number | null,
): (context: Parameters<NonNullable<AgentLoopConfig["shouldStopAfterTurn"]>>[0]) => boolean {
  if (maxTurns === null) {
    const never = (): boolean => false;
    return never;
  }
  let count = 0;
  return (): boolean => {
    count += 1;
    return count >= maxTurns;
  };
}

/**
 * Run one LLM stage: build the agentLoop context + config, drain its event
 * stream, accumulate usage + streaming tokens, honour abort, and settle the
 * `onStageEnd` hook. Throws `StageRunError` on failure (carrying partial usage).
 */
export async function runStage(input: StageRunInput): Promise<StageRunResult> {
  const usage = emptyUsage();
  const startMs = Date.now();
  let fallbackTokens = 0;

  try {
    const context: AgentContext = {
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      tools: input.tools,
    };

    // Per-LLM-call timeout: a dedicated controller whose signal is passed to
    // the loop (so aborting it cancels the in-flight fetch and ends the run).
    // `input.signal` (run/compaction abort) is forwarded into it. The timer is
    // RE-ARMED each turn via transformContext (the only "before each LLM call"
    // seam agentLoop exposes), so a normal multi-turn run never accumulates — a
    // single runaway/stalled turn gets killed. null = no timeout.
    const turnTimeout = new AbortController();
    const forwardAbort = (): void => {
      if (!turnTimeout.signal.aborted) turnTimeout.abort(input.signal.reason);
    };
    if (input.signal.aborted) {
      turnTimeout.abort(input.signal.reason);
    } else {
      input.signal.addEventListener("abort", forwardAbort, { once: true });
    }
    let turnTimer: ReturnType<typeof setTimeout> | undefined;
    const armTurnTimeout = (): void => {
      if (turnTimer !== undefined) clearTimeout(turnTimer);
      if (input.timeoutMs !== null) {
        turnTimer = setTimeout(() => {
          if (!turnTimeout.signal.aborted) turnTimeout.abort(new Error(`stage LLM call exceeded ${input.timeoutMs}ms`));
        }, input.timeoutMs);
      }
    };

    const config: AgentLoopConfig = {
      model: input.model,
      // memkeeper stages use standard LLM messages only (no custom message kinds),
      // so the AgentMessage[]->Message[] transform is an identity cast.
      convertToLlm: (msgs: AgentMessage[]) => msgs as unknown as Message[],
      toolExecution: SEQUENTIAL,
      shouldStopAfterTurn: makeTurnCap(input.maxTurns),
      getApiKey: () => input.apiKey,
      // Per-turn output cap (applied to every provider request; a truncated
      // response's tool calls are rejected by agentLoop).
      maxTokens: input.maxTokens,
      ...(input.reasoning === null ? {} : { reasoning: input.reasoning }),
      ...(input.timeoutMs === null
        ? {}
        : {
            transformContext: async (msgs: AgentMessage[]) => {
              armTurnTimeout();
              return msgs;
            },
          }),
    };

    const loop = input.loopFn ?? agentLoop;
    log.debug("runStage: starting agentLoop stream");
    // pi 0.84.1 made `streamFn` a required `agentLoop` arg. Pass `undefined` (cast to the
    // required type) so pi-agent-core falls back to its process-global default streamFn,
    // which pi-coding-agent installs at startup — that default dispatches through the
    // coding-agent model runtime, preserving resolved auth and custom providers. A test
    // overrides `loopFn` instead.
    const signalForLoop = input.timeoutMs === null ? input.signal : turnTimeout.signal;
    const stream = loop(input.messages, context, config, signalForLoop, undefined as unknown as StreamFn);
    armTurnTimeout(); // arm for the first turn (transformContext arms subsequent ones)

    try {
      for await (const event of stream) {
        if (input.onEvent !== null) input.onEvent(event);

        if (event.type === "message_end") {
          // Only assistant messages carry usage; prompt/steering messages have none
          // (messageEndUsage returns null) and contribute zero.
          const u = messageEndUsage(event.message);
          if (u !== null) {
            usage.input += u.input;
            usage.output += u.output;
            usage.cacheRead += u.cacheRead;
            usage.cost += u.cost;
          }
        } else if (event.type === "turn_end") {
          usage.turns += 1;
        } else if (event.type === "message_update") {
          // Fallback tier: accumulate chars/4 over streamed deltas so
          // a live counter (fed via onEvent) always has a value even when the
          // provider never reports usage. The authoritative per-message output is
          // read from each message_end below (usage.output).
          const delta = deltaTextOf(event);
          if (delta !== null) {
            fallbackTokens += deltaTokens(delta);
          }
        }
      }

      const messages = await stream.result();
      log.debug(`runStage: agentLoop stream done (${usage.turns} turns)`);
      // Two-tier: the authoritative output-token count is the SUM of
      // every message_end usage.output (usage.output — per-message, correct across
      // multi-turn runs since partial.usage.output resets each message). The chars/4
      // fallback only applies when the provider reports no output at all. (A live
      // widget counter is built separately from the raw onEvent stream.)
      const outputTokens = usage.output > 0 ? usage.output : fallbackTokens;
      // aborted reflects either the run signal (compaction) or the per-turn timeout;
      // timedOut isolates the per-turn-timeout case (run signal NOT aborted) so the
      // caller can distinguish "compaction cancelled me" from "a single LLM call ran
      // too long" and treat the latter as a stage-stopping error.
      const timedOut = turnTimeout.signal.aborted && !input.signal.aborted;
      return { messages, usage, outputTokens, aborted: input.signal.aborted || turnTimeout.signal.aborted, timedOut };
    } finally {
      if (turnTimer !== undefined) clearTimeout(turnTimer);
      input.signal.removeEventListener("abort", forwardAbort);
    }
  } catch (cause) {
    throw new StageRunError(cause);
  } finally {
    usage.elapsedMs = Date.now() - startMs;
    if (input.onStageEnd !== null) input.onStageEnd(usage);
  }
}
