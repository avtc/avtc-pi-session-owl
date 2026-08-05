// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Session lifecycle: startup (reconstruct + seed nGoal), the mechanical
// oInitialPrompt capture (NOT the Observer; the first user
// message is captured verbatim under nGoal), shutdown (drop the widget ref),
// and the unstuck auto-continue predicate (the Selector skips these when
// pairing the last user message).

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionMessageEntry,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getMemkeeperSettings } from "./config/schema.js";
import { toStoredTimestamp } from "./format/render.js";
import { stripAnsi } from "./format/sanitize.js";
import { applyCreateNode, applyRecordObservation, applySetMeta, MUTATE_SOURCE } from "./graph/mutations.js";
import { terminateRegexWorker } from "./graph/regex-runner.js";
import { abortInFlight } from "./runtime/run-lock.js";
import { encodeObservation, type ObservationEntry } from "./store/codecs.js";
import {
  appendGraphDelta,
  appendObservation,
  getGraphStore,
  load,
  type StoreContext,
  type StoreEntry,
} from "./store/graph-store.js";
import { makeObservation, N_GOAL, O_INITIAL_PROMPT } from "./types.js";
import type { WidgetController } from "./widget/tracker.js";

// --- StoreContext adapter (pi.appendEntry + ctx.sessionManager) ------------

/**
 * Build the narrow StoreContext the GraphStore needs from the full host context.
 * `appendEntry` lives on the ExtensionAPI (`pi`, captured at activate); the
 * leaf/branch reads live on `ctx.sessionManager` (the active-branch path).
 *
 * `getBranch` returns `SessionEntry[]`; the store reads it as `StoreEntry[]` —
 * sound because the store narrows at runtime via type guards (type/id/details /
 * customType/data are structurally compatible across the entry union).
 */
export function toStoreContext(pi: ExtensionAPI, ctx: ExtensionContext): StoreContext {
  return {
    appendEntry: (customType: string, data: unknown) => pi.appendEntry(customType, data),
    getLeafId: () => ctx.sessionManager.getLeafId(),
    getBranch: (leafId) => ctx.sessionManager.getBranch(leafId ?? undefined) as unknown as StoreEntry[],
  };
}

// --- message text extraction ----------------------------------------------

/** A message whose content is text-like (the shape both user + assistant messages share). */
interface TextualMessage {
  content: string | readonly TextContent[];
}

/** Whether an AgentMessage carries textual content (user/assistant; not custom). */
function isTextualMessage(message: AgentMessage): message is AgentMessage & TextualMessage {
  return typeof message === "object" && message !== null && "content" in message;
}

/** Extract verbatim text from an AgentMessage (string content or TextContent[]). */
export function extractMessageText(message: AgentMessage): string {
  if (!isTextualMessage(message)) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  // join text parts (skip images / non-text)
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("");
}

// --- unstuck auto-continue predicate --------------------------------------

/** Exact-content phrases avtc-pi-unstuck auto-injects (NOT real user signals). */
const UNSTUCK_AUTOCONTINUE_PHRASES: ReadonlySet<string> = new Set<string>([
  "continue",
  "please continue",
  "Your response was cut off due to length. Please provide a shorter, more concise response.",
]);

/**
 * Whether an AgentMessage is an avtc-pi-unstuck auto-injected continuation
 * (exact-content match — `deliverAs` is not persisted, so content is the signal).
 * The Selector's last-user-message pairing skips these.
 */
export function isUnstuckAutoContinue(message: AgentMessage): boolean {
  return UNSTUCK_AUTOCONTINUE_PHRASES.has(extractMessageText(message));
}

// --- nGoal seed ------------------------------------------------------------

/** Seed nGoal into an empty graph (active/crit/empty summary) + persist it. */
function ensureNGoalSeeded(store: StoreContext): void {
  const graph = getGraphStore().graph;
  if (graph.nodes.has(N_GOAL)) return;
  const delta = applyCreateNode(graph, {
    id: N_GOAL,
    summary: "",
    importance: "crit",
    parentNode: null,
    state: "active",
  });
  appendGraphDelta(store, delta);
}

// --- lifecycle events ------------------------------------------------------

/** Startup: reconstruct the graph + seed nGoal on an empty graph (no oInitialPrompt).
 *  Reconstruction always runs (read-only state for a mid-session enable); the nGoal
 *  seed WRITE is gated on `enabled` so a disabled session persists nothing. */
export async function onSessionStart(
  _event: SessionStartEvent,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  widget: WidgetController,
): Promise<void> {
  widget.setCtx(ctx);
  const store = toStoreContext(pi, ctx);
  await load(store);
  // Fresh-session seed: if the graph is empty (no snapshot/deltas), nGoal must
  // exist before any observation arrives. oInitialPrompt is NOT captured here
  // (session_start carries no user message). Gated on enabled: a disabled
  // session persists no graph_delta (the seed self-heals on enable via capture).
  if (getMemkeeperSettings().enabled) ensureNGoalSeeded(store);
}

/**
 * Capture the verbatim initial user message as oInitialPrompt under nGoal
 * (mechanical, NOT the Observer). No-op once present (the signal
 * derives from the graph via hasInitialPrompt, never a persisted boolean). The
 * Observer frontier starts past this message so it is never re-observed.
 */
export function captureInitialPromptIfAbsent(ctx: ExtensionContext, pi: ExtensionAPI): void {
  const graph = getGraphStore().graph;
  if (graph.hasInitialPrompt) return;
  const store = toStoreContext(pi, ctx);
  ensureNGoalSeeded(store);

  const branch = ctx.sessionManager.getBranch(ctx.sessionManager.getLeafId() ?? undefined);
  const firstUser = branch.find(
    (entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "user",
  );
  if (firstUser === undefined) return; // no user message yet
  const text = stripAnsi(extractMessageText(firstUser.message));
  if (text.length === 0) return;

  // record oInitialPrompt under nGoal (built once via makeObservation; the
  // persisted record derives from it, omitting the cached summaryTokens).
  const obs = makeObservation({
    id: O_INITIAL_PROMPT,
    summary: text,
    importance: "crit",
    sourceEntryIds: [firstUser.id],
    timestamp: toStoredTimestamp(firstUser.timestamp),
    parentNode: N_GOAL,
  });
  applyRecordObservation(graph, { obs });

  // seed nGoal.summary from the first non-empty line
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine !== undefined && firstLine !== graph.nodes.get(N_GOAL)?.summary) {
    const metaDelta = applySetMeta(
      graph,
      { nodeId: N_GOAL, importance: null, archived: null, obsolete: null, summary: firstLine },
      MUTATE_SOURCE,
    );
    appendGraphDelta(store, metaDelta);
  }

  // persist the capture: the observation (content + provenance) as a
  // memkeeper.observation entry (coversUpToId = first user entry → frontier
  // advances past it); the record_observation is NOT a graph_delta (the store never applies mutations).
  const observationEntry: ObservationEntry = {
    coversFromId: null,
    coversUpToId: firstUser.id,
    records: [encodeObservation(obs)],
    tokenCount: obs.summaryTokens,
  };
  appendObservation(store, observationEntry);
}

/** Shutdown: abort any in-flight stage (so it stops wasting LLM tokens on a
 *  discarded session), end the widget's stage display, then drop the widget ref.
 *  Fire-and-forget — the run releases in its own `finally`. */
export function onSessionShutdown(_event: SessionShutdownEvent, widget: WidgetController): void {
  abortInFlight();
  terminateRegexWorker();
  widget.endStage();
  widget.clearCtx();
}
