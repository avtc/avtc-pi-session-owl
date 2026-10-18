// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { toStoredTimestamp } from "../../core/src/format/render.js";
import { stripAnsi } from "../../core/src/format/sanitize.js";
import { applyCreateNode, applyRecordObservation } from "../../core/src/graph/mutations.js";
import { encodeObservation } from "../../core/src/store/codecs.js";
import type { StoreContext } from "../../core/src/store/graph-store.js";
import { makeObservation, N_GOAL, O_INITIAL_PROMPT } from "../../core/src/types.js";
// The mechanical initial-prompt capture, reimplemented against the port's
// rows: the first live-path user entry becomes oInitialPrompt under nGoal
// (NOT the Observer — the frontier starts past it), persisted as an
// observation record + a record_observation delta so replay re-executes the
// capture. Idempotent via the graph's hasInitialPrompt signal. On a fresh
// capture the goal-extract LAUNCH HOOK fires (fire-and-forget).
import type { CoreHandle } from "../core-instances.js";

/** Extract the visible text of a user entry (string content or text blocks). */
function userText(entry: SessionEntry): string {
  const message = (entry as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // pi's extractMessageText joins text parts with "" (no separator)
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: string }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("");
}

/** Seed nGoal on an empty graph (the fresh-session root; idempotent). */
export function ensureNGoalSeeded(handle: CoreHandle, ctx: StoreContext): void {
  const graph = handle.store.getGraphStore().graph;
  if (graph.nodes.has(N_GOAL)) return;
  const delta = applyCreateNode(graph, {
    id: N_GOAL,
    summary: "",
    importance: "crit",
    parentNode: null,
    state: "active",
  });
  handle.store.appendGraphDelta(ctx, delta);
}

/**
 * Capture the verbatim initial user entry as oInitialPrompt under nGoal.
 * Returns the captured text (the caller fires goal extraction), or null on a
 * no-op (already captured, or no user entry on the branch yet).
 */
export function captureInitialPrompt(
  handle: CoreHandle,
  ctx: StoreContext,
  entries: readonly SessionEntry[],
  fireGoalExtract: (verbatim: string) => void,
): string | null {
  const store = handle.store;
  const graph = store.getGraphStore().graph;
  if (graph.hasInitialPrompt) return null;
  ensureNGoalSeeded(handle, ctx);
  const firstUser = entries.find(
    (e) => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user",
  );
  if (firstUser === undefined) return null;
  // pi parity: stripAnsi(extractMessageText(...)) — no trim (a whitespace
  // prompt still counts; the gate is emptiness of the STRIPPED text)
  const text = stripAnsi(userText(firstUser));
  if (text.length === 0) return null;

  // verbatim-source size hint from the details renderer (cached for recall)
  const counts = handle.details.computeDetailsAndCache(O_INITIAL_PROMPT, [firstUser.id], (ids) => {
    const byId = new Map(entries.map((e) => [e.id, e]));
    return ids.map((id) => byId.get(id)).filter((e) => e !== undefined);
  });
  const timestamp = toStoredTimestamp(firstUser.timestamp);
  const obs = makeObservation({
    id: O_INITIAL_PROMPT,
    summary: text,
    importance: "crit",
    sourceEntryIds: [firstUser.id],
    timestamp,
    parentNode: N_GOAL,
    detailsLines: counts?.lines,
    detailsTokens: counts?.tokens,
  });
  applyRecordObservation(graph, { obs });
  // persist both halves: the delta (replay re-executes the link) and the
  // observation record (indexes the content; frontier advances past it)
  handle.store.appendGraphDelta(ctx, { type: "record_observation", obs: { ...obs } });
  handle.store.appendObservation(ctx, {
    coversFromId: null,
    coversUpToId: firstUser.id,
    records: [encodeObservation(obs)],
    tokenCount: obs.detailsTokens ?? 0,
  });
  fireGoalExtract(text);
  return text;
}
