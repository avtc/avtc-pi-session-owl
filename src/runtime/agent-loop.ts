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

import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { agentLoop } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, ThinkingLevel } from "@earendil-works/pi-ai";

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
  /** Live two-tier streaming-output-token counter (primary usage, fallback chars/4). */
  streamingOutputTokens: number;
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

/** A stage run failure carrying the partial usage accumulated before the throw. */
export class StageRunError extends Error {
  readonly partialUsage: StageUsage;
  readonly aborted: boolean;
  constructor(cause: unknown, partialUsage: StageUsage, aborted: boolean) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`stage run failed: ${msg}`);
    this.name = "StageRunError";
    this.partialUsage = partialUsage;
    this.aborted = aborted;
  }
}

const CHARS_PER_TOKEN_ESTIMATE = 4;

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

/** Read cumulative usage off a `message_end` message (always an assistant message). */
function messageEndUsage(message: AgentMessage): {
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
} {
  // message_end always carries an assistant message with usage at runtime.
  const u = (
    message as {
      usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } };
    }
  ).usage;
  return {
    input: u?.input ?? 0,
    output: u?.output ?? 0,
    cacheRead: u?.cacheRead ?? 0,
    cost: u?.cost?.total ?? 0,
  };
}

/** Read a provider-streamed output token count off a `message_update` partial. */
function streamedOutputOf(ev: AgentEvent): number | null {
  if (ev.type !== "message_update") return null;
  const partial = (ev.assistantMessageEvent as { partial?: { usage?: { output?: number } } }).partial;
  const out = partial?.usage?.output;
  return typeof out === "number" ? out : null;
}

/** Extract the delta string from a streamed assistant-message event (fallback tier). */
function deltaTextOf(ev: AgentEvent): string | null {
  if (ev.type !== "message_update") return null;
  const inner = ev.assistantMessageEvent;
  if (inner.type === "text_delta" || inner.type === "thinking_delta" || inner.type === "toolcall_delta") {
    return inner.delta;
  }
  return null;
}

/**
 * Run one LLM stage: build the agentLoop context + config, drain its event
 * stream, accumulate usage + streaming tokens, honour abort, and settle the
 * `onStageEnd` hook. Throws `StageRunError` on failure (carrying partial usage).
 */
export async function runStage(input: StageRunInput): Promise<StageRunResult> {
  const usage = emptyUsage();
  let primaryTokens = 0;
  let fallbackTokens = 0;

  try {
    const context: AgentContext = {
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      tools: input.tools,
    };

    const config: AgentLoopConfig = {
      model: input.model,
      convertToLlm: (msgs: AgentMessage[]) => msgs as unknown as Message[],
      toolExecution: SEQUENTIAL,
      shouldStopAfterTurn: makeTurnCap(input.maxTurns),
      getApiKey: () => input.apiKey,
      ...(input.reasoning === null ? {} : { reasoning: input.reasoning }),
    };

    const loop = input.loopFn ?? agentLoop;
    const stream = loop(input.messages, context, config, input.signal);

    for await (const event of stream) {
      if (input.onEvent !== null) input.onEvent(event);

      if (event.type === "message_end") {
        const u = messageEndUsage(event.message);
        usage.input += u.input;
        usage.output += u.output;
        usage.cacheRead += u.cacheRead;
        usage.cost += u.cost;
      } else if (event.type === "turn_end") {
        usage.turns += 1;
      } else if (event.type === "message_update") {
        const out = streamedOutputOf(event);
        if (out !== null && out > primaryTokens) {
          primaryTokens = out;
        }
        const delta = deltaTextOf(event);
        if (delta !== null) {
          fallbackTokens += Math.ceil(delta.length / CHARS_PER_TOKEN_ESTIMATE);
        }
      }
    }

    const messages = await stream.result();
    const streamingOutputTokens = primaryTokens > 0 ? primaryTokens : fallbackTokens;
    return { messages, usage, streamingOutputTokens, aborted: input.signal.aborted };
  } catch (cause) {
    throw new StageRunError(cause, usage, input.signal.aborted);
  } finally {
    if (input.onStageEnd !== null) input.onStageEnd(usage);
  }
}
