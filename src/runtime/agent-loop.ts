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
import type { Api, CacheRetention, Message, Model, ThinkingLevel } from "@earendil-works/pi-ai";
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

/** Empty string constant for the no-progress text check (no bare literals). */
const EMPTY_TEXT = "";
/** Cap for the error text included in a tool-call debug line. */
const TOOL_LOG_TEXT_CAP = 200;
const ELLIPSIS = "…";

/** Debug-log one completed tool call: name + ok/error (+ collapsed, capped
 *  error text). Gives tool-level visibility (rejected/truncated calls, what
 *  the model got wrong) when `debugLog` is on. */
function logToolExecutionEnd(toolName: string, isError: boolean, result: unknown): void {
  const status = isError ? "error" : "ok";
  const text = isError ? firstResultText(result) : EMPTY_TEXT;
  const suffix = text === EMPTY_TEXT ? EMPTY_TEXT : `: ${text}`;
  log.debug(`runStage: tool ${toolName} ${status}${suffix}`);
}

/** First text block of a tool result, whitespace-collapsed and capped to one
 *  physical line (long/stacky errors stay greppable without flooding the log). */
function firstResultText(result: unknown): string {
  const blocks = (result as { content?: Array<{ type: string; text?: string }> } | null)?.content;
  if (!Array.isArray(blocks)) return EMPTY_TEXT;
  const text = blocks.find((b) => b.type === "text" && typeof b.text === "string")?.text ?? EMPTY_TEXT;
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= TOOL_LOG_TEXT_CAP) return oneLine;
  return `${oneLine.slice(0, TOOL_LOG_TEXT_CAP - ELLIPSIS.length)}${ELLIPSIS}`;
}

/** Per-run usage accumulated by a stage (input/output/cacheRead/cacheWrite/cost/turns). */
export interface StageUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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
  /** Turn-stop override: replaces the maxTurns cap as the loop's
   *  shouldStopAfterTurn when present (e.g. the Observer's no-progress rule —
   *  stop after N consecutive turns that neither advanced work nor emitted
   *  text). */
  stopAfterTurn?: TurnPredicate;
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
  /** LLM session-affinity id forwarded to the provider (Anthropic `x-session-affinity`,
   *  Mistral `promptCacheKey`). Omit for one-shot calls with no recurring prefix
   *  (e.g. goal-extract). Absent = no affinity header / cache namespace. */
  sessionId?: string;
  /** Prompt-cache retention forwarded to the provider. Omit for recurring-prefix
   *  stages (defaults to the provider's "short"). Set `"none"` for one-shot calls
   *  whose prefix never recurs (no wasted cache write). */
  cacheRetention?: CacheRetention;
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

/** A terminal model/runtime failure — the agentLoop stream ended with the final
 *  assistant message's stopReason "error" (server unavailable, wrong model
 *  hosted, provider error). Per the StreamFn contract such failures NEVER throw
 *  from the stream; they are encoded as a final assistant message with stopReason
 *  "error" and an errorMessage. `runStage` detects that stopReason and throws this
 *  so the stage caller (Observer/Builder/Selector → compaction hook) cancels
 *  compaction instead of silently treating the run as a no-record success
 *  (which would let Pi prune an unobserved gap). Propagates UNWRAPPED — see
 *  `runStage`'s catch, which re-throws `StageModelError` as-is rather than
 *  wrapping it in a generic `StageRunError`. */
export class StageModelError extends Error {
  /** The model's own errorMessage from the final assistant message, or null. */
  readonly modelErrorMessage: string | null;
  constructor(modelErrorMessage: string | null) {
    const detail = modelErrorMessage?.trim();
    super(
      detail
        ? `agent model call failed (stopReason "error"): ${detail}`
        : 'agent model call failed (stopReason "error")',
    );
    this.name = "StageModelError";
    this.modelErrorMessage = detail || null;
  }
}

/** A fresh zeroed usage accumulator. */
function emptyUsage(): StageUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, elapsedMs: 0 };
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

/** A `shouldStopAfterTurn` predicate over one completed turn. */
export type TurnPredicate = (turn: Parameters<NonNullable<AgentLoopConfig["shouldStopAfterTurn"]>>[0]) => boolean;

/** Build a `shouldStopAfterTurn` that stops after `maxSequential` consecutive
 *  NO-PROGRESS turns — a turn that neither advanced `progress()` (e.g. accepted
 *  records count) nor emitted any plain text. A turn with text or progress
 *  resets the streak. Bounds the degenerate retry spiral (model emits a
 *  failing tool call every turn, never valid work, never a terminal plain-text
 *  message) that would otherwise loop forever under `NO_TURN_LIMIT`. */
export function makeNoProgressTurnStop(maxSequential: number, progress: () => number): TurnPredicate {
  let streak = 0;
  let lastProgress = progress();
  return (turn) => {
    const now = progress();
    const advanced = now > lastProgress;
    lastProgress = now;
    const hasText = turn.message.content.some(
      (block) => block.type === "text" && block.text.trim().length > EMPTY_TEXT.length,
    );
    if (advanced || hasText) {
      streak = 0;
      return false;
    }
    streak += 1;
    return streak >= maxSequential;
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
      shouldStopAfterTurn: input.stopAfterTurn ?? makeTurnCap(input.maxTurns),
      getApiKey: () => input.apiKey,
      // Per-turn output cap (applied to every provider request; a truncated
      // response's tool calls are rejected by agentLoop).
      maxTokens: input.maxTokens,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.cacheRetention ? { cacheRetention: input.cacheRetention } : {}),
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
      // Track the terminal assistant stopReason. Per the StreamFn contract, a
      // model/runtime failure (server down, wrong model hosted, provider error)
      // is encoded as a final assistant message with stopReason "error" — it
      // does NOT throw from the stream. The agent loop stops immediately after
      // such a message, so the LAST assistant message_end is authoritative.
      // ("aborted" is NOT a model error — it is covered by the signal-based
      // aborted/timedOut flags below.)
      let lastAssistantStopReason: string | undefined;
      let lastAssistantErrorMessage: string | undefined;

      for await (const event of stream) {
        if (input.onEvent !== null) input.onEvent(event);

        if (event.type === "message_end") {
          const endMsg = event.message as { role?: string; stopReason?: string; errorMessage?: string };
          if (endMsg.role === "assistant") {
            lastAssistantStopReason = endMsg.stopReason;
            lastAssistantErrorMessage = endMsg.errorMessage;
          }
          // Only assistant messages carry usage; prompt/steering messages have none
          // (messageEndUsage returns null) and contribute zero.
          const u = messageEndUsage(event.message);
          if (u !== null) {
            usage.input += u.input;
            usage.output += u.output;
            usage.cacheRead += u.cacheRead;
            usage.cacheWrite += u.cacheWrite;
            usage.cost += u.cost;
          }
        } else if (event.type === "turn_end") {
          usage.turns += 1;
        } else if (event.type === "tool_execution_end") {
          logToolExecutionEnd(event.toolName, event.isError, event.result);
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
      // A terminal model failure: surface it instead of returning a clean
      // no-record result (which would let the stage caller proceed and Pi prune
      // an unobserved gap). The outer catch re-throws StageModelError unwrapped.
      if (lastAssistantStopReason === "error") {
        throw new StageModelError(lastAssistantErrorMessage ?? null);
      }
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
    // StageModelError is a DETECTED terminal model failure (stopReason "error"),
    // not an unexpected throw — re-throw it as-is so its type/message survive to
    // callers and logs (a generic StageRunError wrap would hide the cause).
    if (cause instanceof StageModelError) throw cause;
    throw new StageRunError(cause);
  } finally {
    usage.elapsedMs = Date.now() - startMs;
    if (input.onStageEnd !== null) input.onStageEnd(usage);
  }
}
