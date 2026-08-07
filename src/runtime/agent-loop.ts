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
}

/** What `runStage` returns on a clean (non-throwing) run. */
export interface StageRunResult {
  messages: AgentMessage[];
  usage: StageUsage;
  /** Final two-tier output-token count (primary usage.output, fallback chars/4). */
  outputTokens: number;
  /** True when `input.signal` was aborted during the run. */
  aborted: boolean;
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

/** A fresh zeroed usage accumulator. */
function emptyUsage(): StageUsage {
  return { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0 };
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
  let fallbackTokens = 0;

  try {
    const context: AgentContext = {
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      tools: input.tools,
    };

    const config: AgentLoopConfig = {
      model: input.model,
      // memkeeper stages use standard LLM messages only (no custom message kinds),
      // so the AgentMessage[]->Message[] transform is an identity cast.
      convertToLlm: (msgs: AgentMessage[]) => msgs as unknown as Message[],
      toolExecution: SEQUENTIAL,
      shouldStopAfterTurn: makeTurnCap(input.maxTurns),
      getApiKey: () => input.apiKey,
      ...(input.reasoning === null ? {} : { reasoning: input.reasoning }),
    };

    const loop = input.loopFn ?? agentLoop;
    log.debug("runStage: starting agentLoop stream");
    // pi 0.84.1 made `streamFn` a required `agentLoop` arg. Pass `undefined` (cast to the
    // required type) so pi-agent-core falls back to its process-global default streamFn,
    // which pi-coding-agent installs at startup — that default dispatches through the
    // coding-agent model runtime, preserving resolved auth and custom providers. A test
    // overrides `loopFn` instead.
    const stream = loop(input.messages, context, config, input.signal, undefined as unknown as StreamFn);

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
    return { messages, usage, outputTokens, aborted: input.signal.aborted };
  } catch (cause) {
    throw new StageRunError(cause);
  } finally {
    if (input.onStageEnd !== null) input.onStageEnd(usage);
  }
}
