// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Local shim for @earendil-works/pi-agent-core inside the packaged plugin.
// The vendored core's single VALUE import is agentLoop (runtime/agent-loop.ts);
// everything else is type-only and erases at load. The shim's runtime is the
// Claude stage engine: `runStage` below spawns an engine-owned agent per run
//  and maps its completion back to pi's StageRunResult shape.
// `agentLoop` itself stays a throwing stub — the raw loop API has no engine
// counterpart (verified against the engine types and live probes); the
// port's host run modules call `runStage`, never `agentLoop`.
//
// Type surface (used subset of pi-agent-core's dist/types.d.ts, v1.x): the
// looser structural stand-ins below exist so THIS file typechecks standalone;
// the repo's typecheck of the vendored core pins the real package d.ts via
// tsconfig.claude.json paths (see that file), so the core itself always sees
// the full pi-agent-core types.

import type { TSchema } from "../../node_modules/typebox/build/index.mjs";

/** pi-agent-core types.d.ts: StreamFn — the low-level model stream function. */
export type StreamFn = (...args: never[]) => unknown;

/** pi-agent-core types.d.ts: AgentMessage — the loop's message union. */
export type AgentMessage = { role: string; content: unknown };

/** pi-agent-core types.d.ts: AgentEvent — the loop's event union (stand-in). */
export type AgentEvent = { type: string } & Record<string, unknown>;

/** pi-agent-core agent.d.ts: AgentContext (stand-in shape). */
export type AgentContext = {
  messages: AgentMessage[];
  state: Record<string, unknown>;
  [key: string]: unknown;
};

/** pi-agent-core agent.d.ts: AgentLoopConfig (stand-in shape). */
export type AgentLoopConfig = {
  model?: unknown;
  tools?: AgentTool[];
  systemPrompt?: string;
  maxTurns?: number;
  [key: string]: unknown;
};

/** pi-agent-core types.d.ts: AgentTool (stand-in shape). */
export type AgentTool = {
  name: string;
  description: string;
  parameters: TSchema;
};

/**
 * pi-agent-core agent-loop.d.ts:
 *   export declare function agentLoop(prompts, context, config, signal, streamFn):
 *     EventStream<AgentEvent, AgentMessage[]>;
 *
 * Stub: throws if reached before the Claude stage engine lands here.
 */
export function agentLoop(
  _prompts: AgentMessage[],
  _context: AgentContext,
  _config: AgentLoopConfig,
  _signal: AbortSignal | undefined,
  _streamFn: StreamFn,
): never {
  throw new Error(
    "pi-agent-core shim: the raw agentLoop has no engine counterpart — call runStage (the engine-backed stage run)",
  );
}

// --- the engine-backed stage run -------------------------

/** A stage name (the registered agent types' bare short forms). */
export type StageName = "observer" | "builder" | "selector";

/** What the engine's turn.complete reports (already normalized). */
interface CompletionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  model: string;
}

/** One model's rates (USD per million tokens). */
export interface ModelRates {
  inputPerM: number;
  outputPerM: number;
}

/** The engine-backed runStage input: pi's StageRunInput fields the spawn
 *  path consumes (the provider-coupled ones — apiKey, loopFn, tools,
 *  sessionId, cacheRetention — are engine-owned here and dropped; tools are
 *  the AgentSpec's explicit sets; no turn cap — pi runs NO_TURN_LIMIT). */
export interface EngineStageRunInput {
  stage: StageName;
  systemPrompt: string;
  messages: AgentMessage[];
  /** Resolved model string (alias or id), or null = the session's. */
  model: string | null;
  signal: AbortSignal | undefined;
  /** Per-call output cap (the relay's synthetic max_tokens stop). */
  maxTokens: number;
  /** Per-call stall timeout (the relay's race), or null = no limit. */
  timeoutMs: number | null;
  /** The no-progress turn count (0 disables — goal-extract-style runs). */
  noProgressTurns: number;
  /** Widget event sink (null = none). */
  onEvent: ((event: { type: string } & Record<string, unknown>) => void) | null;
  /** Fired once at stage end with the accumulated (possibly partial) usage. */
  onStageEnd: ((usage: StageUsageLike) => void) | null;
  /** Dump slot path (the call-site buffer fills; the dump-ring layer persists). */
  dumpPath: string | null;
  /** Fired right after the spawn resolves and the run is registered — the
   *  run module binds its per-agent tool bodies + dump sections here. */
  onSpawn: ((agentId: string) => void) | null;
  /** Rates lookup for cost computation (null result = zeroed + logged). */
  modelRates?: (model: string) => ModelRates | null;
}

/** pi's StageUsage shape (agent-loop.ts), spelled locally. */
export interface StageUsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  elapsedMs: number;
}

/** pi's StageRunResult shape (agent-loop.ts), spelled locally, plus the
 *  abort classification pi folds into its error classes: the run-state
 *  abort reason ("signal" | "timeout" | "no-progress"), null on a clean
 *  end. A timeout reason is the skip-and-notify surface (pi's
 *  StageTimeoutError semantics). */
export interface StageRunResultLike {
  messages: AgentMessage[];
  usage: StageUsageLike;
  outputTokens: number;
  aborted: boolean;
  timedOut: boolean;
  /** The relay's abort classification (null = a clean end). */
  abortReason: string | null;
}

/** The handback phrasings that replace pi's stage-closing
 *  sentences (the platform requires background agents to end by calling
 *  SubagentHandback; everything else in the stage prompts rides pi
 *  verbatim). An anchor the drift ever breaks simply leaves pi's own
 *  closing in place — the engine's enforcer still collects the call. */
const OBSERVER_DONE =
  'When the chunk is fully covered or has nothing worth capturing, call the "SubagentHandback" tool with the single word "Done".';
const STAGE_DONE =
  'After it accepts or when you can make no further progress, call the "SubagentHandback" tool with the single word "Done".';

export function translateStageClosings(flattened: string): string {
  // Whitespace-tolerant anchors: pi's closing sentences wrap across source
  // lines inside template literals (the emitted prompt carries those line
  // breaks), and any future re-wrap of the paragraph must not silently
  // break the translation.
  return flattened
    .replace(
      /When the chunk is fully covered,\s+reply\s+with the single word Done;\s+if the chunk has nothing worth capturing,\s+skip the\s+tool and reply Done\./,
      OBSERVER_DONE,
    )
    .replace(/Stop when it accepts,\s+or when you can make no\s+further progress\./g, STAGE_DONE);
}

/** Flatten the stage's input messages to the spawn prompt: text parts
 *  joined with blank-line separators. The content is self-describing (the
 *  observer chunk carries its XML-style tags; the builder/selector views
 *  carry their own headers), and every stage sends a single user message. */
export function flattenStagePrompt(messages: readonly AgentMessage[]): string {
  return messages
    .map((m) => {
      const content = m.content as unknown;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter(
                  (b): b is { type: string; text?: string } =>
                    typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
                )
                .map((b) => b.text ?? "")
                .join("")
            : "";
      return text;
    })
    .filter((t) => t.length > 0)
    .join("\n\n");
}

/** pi's CONVERGENCE_NO_PROGRESS_TURNS-equivalents live per-run; the
 *  relay enforces them (see host/stage/runs.ts). */

/** chars/4 estimate (pi's estimateContentTokens tier). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function emptyUsage(elapsedMs: number): StageUsageLike {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, elapsedMs };
}

/** Cost from token counts × rates (zeroed + logged when rates unknown —
 *  pi-ai behaves the same when a provider omits rates). */
function computeCost(usage: CompletionUsage | null, rates: ModelRates | null, log: (m: string) => void): number {
  if (usage === null) return 0;
  if (rates === null) {
    log(`session-owl: cost unavailable for model "${usage.model}" — usage cost zeroed`);
    return 0;
  }
  return (usage.input / 1_000_000) * rates.inputPerM + (usage.output / 1_000_000) * rates.outputPerM;
}

/** The engine services the shim needs (armed by the register wiring). */
interface EngineServices {
  agentSpawn: (input: {
    subagentType: string;
    prompt: string;
    model?: string;
  }) => Promise<{ model: string; agentId?: string }>;
  log: (message: string) => void;
}

/** Read the armed services (the bridge; throws before the first arm). */
function services(): EngineServices {
  const svcs = bridgeModule.currentServices();
  const spawn = svcs.agentSpawn;
  const log = svcs.log;
  if (typeof spawn !== "function" || typeof log !== "function") {
    throw new StageRunError("stage engine services not armed (agentSpawn/log missing)");
  }
  return { agentSpawn: spawn as EngineServices["agentSpawn"], log: log as EngineServices["log"] };
}

/**
 * Run one stage pass as an engine-owned agent (the pi `runStage` shape):
 * spawn the stage's registered type with the flattened input, record the
 * run, await its turn.complete (the relay enforces abort/timeout/caps in
 * between), and map the completion to pi's StageRunResult. The run state is
 * removed in the finally; the spawn REGISTRY membership deliberately stays
 * past completion (the delivery drop and the capture skip read it there —
 * the handback arrives after turn.complete); session.end clears it.
 */
export async function runStage(input: EngineStageRunInput): Promise<StageRunResultLike> {
  const startedAt = Date.now();
  // An already-aborted signal makes zero calls (the aborted-chunk rule:
  // nothing persists, nothing spawns). The stage-end hook still fires —
  // the ledger folds the (empty) partial usage.
  if (input.signal?.aborted) {
    if (input.onStageEnd !== null) input.onStageEnd(emptyUsage(0));
    return {
      messages: [],
      usage: emptyUsage(Date.now() - startedAt),
      outputTokens: 0,
      aborted: true,
      timedOut: false,
      abortReason: "signal",
    };
  }
  const svcs = services();
  // The platform's background agents must end by calling SubagentHandback
  // (the engine injects the tool and re-prompts plain-text endings until it
  // is called); a stage agent that reports through it delivers a handback
  // prompt into the MAIN conversation (consumed by our prompt.submit drop —
  // a visible "Prompt dropped by a hook" notice per run). The stage
  // protocols deliver through their own record/mutate tools; pi's prompts
  // close with their own ending words, and the port substitutes exactly
  // those closing sentences with the handback phrasing (the phrasings are
  // pinned; every other word of the stage prompts rides pi verbatim). The
  // delivered handback prompt is dropped by the register's prompt.submit
  // hook either way (the notice is the platform's own chrome for a dropped
  // prompt — not removable).
  const prompt = translateStageClosings(flattenStagePrompt(input.messages));

  const spawned = await svcs.agentSpawn({
    subagentType: `session-owl:${input.stage}`,
    prompt,
    ...(input.model !== null ? { model: input.model } : {}),
  });
  const agentId = spawned.agentId;
  if (agentId === undefined) {
    throw new StageRunError("stage spawn resolved without an agentId");
  }
  // The widget's model-call feed (the port has no engine event stream into
  // the runs — the completion below carries the call's usage)
  if (input.onEvent !== null) input.onEvent({ type: "message_start" });

  const run = createStageRun(
    agentId,
    input.stage,
    {
      maxTokens: input.maxTokens,
      timeoutMs: input.timeoutMs,
      noProgressTurns: input.noProgressTurns,
    },
    input.onEvent === null ? null : (event) => input.onEvent?.(event as never),
  );
  // The registry record is membership-only ({stage}) — the delivery drop
  // and the capture skip read presence; the run modules append their own
  // pre-call <input> blocks (the buffer does not carry the prompt).
  bridgeModule.recordSpawn(agentId, { stage: input.stage });
  if (input.onSpawn !== null) input.onSpawn(agentId);

  // The watchdog trips the abort flag (read at the next dispatch); it never
  // resolves this gate from a timer callback — the engine's own
  // turn.complete does, so the end stays relay-classified.
  const onAbort = () => abortRun(agentId, "signal");
  input.signal?.addEventListener("abort", onAbort, { once: true });

  let usageAccum: StageUsageLike = emptyUsage(0);
  let outputTokens = 0;
  let aborted = false;
  let timedOut = false;
  let abortReason: string | null = null;
  let answer = "";
  try {
    const completion = await bridgeModule.awaitAgentCompletion(agentId);
    if (input.onEvent !== null) {
      // absent usage must be UNDEFINED, never null — the consumers treat a
      // null usage object as present-but-unreadable and throw on it.
      // totalTokens (the tracker's context counter) is derived: the
      // engine's completion carries the four counts, no total.
      const u = completion.usage;
      input.onEvent({
        type: "message_end",
        message: {
          usage:
            u === null || u === undefined
              ? undefined
              : {
                  input: u.input,
                  output: u.output,
                  cacheRead: u.cacheRead,
                  cacheWrite: u.cacheWrite,
                  cost: 0,
                  totalTokens: u.input + u.output + u.cacheRead + u.cacheWrite,
                },
          model: u?.model,
        },
      });
    }
    answer = completion.answer;
    // The deliberate-abort forgiveness: a completion WE initiated (the
    // handback-enforcer kill — the run's work was already done, plain-text
    // finish and all) is a CLEAN finish, never a discard trigger.
    const deliberate = bridgeModule.consumeDeliberateAbort(agentId);
    aborted = (completion.isAborted && !deliberate) || run.abortFlag;
    timedOut = run.timedOut;
    if (completion.reason === "error" || completion.reason === "refusal") {
      // An engine-side failure (API error, a refused turn): the pi
      // StageModelError path — propagate (typed) so the run module's caller
      // classifies skip-and-notify (the finally still tears the run down).
      throw new StageModelError(`stage engine failure (${completion.reason}): ${completion.answer.slice(0, 200)}`);
    }
    const rates = input.modelRates?.(completion.usage?.model ?? "") ?? null;
    usageAccum = {
      input: completion.usage?.input ?? 0,
      output: completion.usage?.output ?? 0,
      cacheRead: completion.usage?.cacheRead ?? 0,
      cacheWrite: completion.usage?.cacheWrite ?? 0,
      cost: computeCost(completion.usage ?? null, rates, svcs.log),
      turns: run.stepCount,
      elapsedMs: Date.now() - startedAt,
    };
    // pi's two-tier: the reported output count when positive, else chars/4
    outputTokens =
      completion.usage !== null && completion.usage !== undefined && completion.usage.output > 0
        ? completion.usage.output
        : estimateTokens(answer);
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
    // mark the fabricated stop BEFORE completion — completeStageRun merges
    // the buffer into the stage's dump archive, and the marker must ride it
    const preRun = getStageRun(agentId);
    if (preRun !== undefined && preRun.dump.fabricatedStop === null && (aborted || timedOut)) {
      markFabricatedStop(preRun, preRun.abortReason ?? "signal");
    }
    const finalRun = completeStageRun(agentId);
    abortReason = aborted ? (finalRun?.abortReason ?? "signal") : null;
    // The spawn registry KEEPS the entry past completion: the delivery drop
    // and the capture skip read membership there after turn.complete (the
    // handback arrives after the completion); session.end clears it.
    if (input.onStageEnd !== null) {
      input.onStageEnd({ ...usageAccum, elapsedMs: Date.now() - startedAt });
    }
  }

  return {
    messages: [{ role: "assistant", content: answer }],
    usage: usageAccum,
    outputTokens,
    aborted,
    timedOut,
    abortReason,
  };
}

// Relative, closure-clean collaborators (the bridge + the run-state home +
// the dump call-sites — all import-free host modules).
import * as bridgeModule from "../../host/engine-bridge.js";
import { StageModelError, StageRunError } from "../../host/runs/stage-errors.js";
import { markFabricatedStop } from "../../host/stage/dumps.js";
import { abortRun, completeStageRun, createStageRun, getStageRun } from "../../host/stage/runs.js";
