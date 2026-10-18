// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Process-level runtime state: config-dir resolution, the per-conversation
// registry, the idempotent registrar's bookkeeping, and the session.end
// teardown body. All functions here are DATA-ONLY: engine calls live as
// literal `$.noun.method(...)` spellings inside the hooks module's handler
// bodies (the scanner forbids `$` and nouns crossing call boundaries); this
// module computes paths/specs/decisions from data the handlers pass in.
//
// Registry shape: Map<"sessionId|agentId", ConversationState>. Entries are
// lazily bootstrapped at the first event carrying a key
// (classic.SessionStart for the main loop; session.append{agentId} for a
// subagent loop). The session DIRECTORY is created at first write, not at
// registry entry.
//
// ConversationState:
//   key         "sessionId" or "sessionId|agentId" (the getCore key)
//   sessionId   the owning session
//   agentId     the subagent loop's id, or null for the main loop
//   createdAt   registry entry time (ms)
//   dispose     per-conversation teardown callbacks (run-lock abort,
//               regex worker termination, resolver clears)

import { log } from "../core/src/log.js";
import { awaitStageToolSpec } from "./compaction/budget-free.js";
import * as bridge from "./engine-bridge.js";
import { owlRecallToolSpec } from "./recall/spec.js";
import { stageLaunchedToolSpec } from "./stage/launch.js";
import { STAGE_TOOL_SPECS } from "./stage/tools.js";
import { SESSION_MARKER_FILENAME } from "./storage/session-marker.js";
import { pruneMeasures } from "./triggers/context.js";
import { pruneIdleLocks } from "./triggers/run-locks.js";

/** A conversation's state. */
export interface ConversationState {
  key: string;
  sessionId: string;
  agentId: string | null;
  createdAt: number;
  dispose: Array<() => void | Promise<void>>;
}

export const registry = new Map<string, ConversationState>();

/** The last backfill's over-cap bootstrap block: the manual command
 *  /owl-status documents while the history backlog stays unmirrored (the
 *  ladder's rung 2 hint; null = nothing blocked). */
let bootstrapBlockedCommand: string | null = null;

export function setBootstrapBlockedCommand(command: string | null): void {
  bootstrapBlockedCommand = command;
}

export function getBootstrapBlockedCommand(): string | null {
  return bootstrapBlockedCommand;
}

/** True while the history backlog is blocked: the owl PAUSES (dormant, the
 *  conflict-pause semantics — no capture, no observation, no stages; row
 *  mirroring keeps running so the post-bootstrap mirror is whole). */
export function isBootstrapBlocked(): boolean {
  return bootstrapBlockedCommand !== null;
}

let currentSessionId: string | null = null;
let configDirCache: string | null = null;
/** The engine's session model (the /config model row's value), read once at
 *  session start — the goal extractor's fallback when defaultModel is unset
 *  (pi's own resolution order: defaultModel, then the session model). */
let sessionModel: string | null = null;
let toolsRegistered = false;
/** Whether the start gate already handed out the owl_recall spec (it hands
 *  it out only when enabled) — the mid-session enable path consults this so
 *  an enable off→on cycle never re-registers the tool. */
let recallToolRegistered = false;
let commandsRegistered = false;
let stageToolsRegistered = false;
let agentsRegistered = false;

// ---- config dir --------------------------------------------------------------

/** Compute the owl data root from env values (the handler read them literally). */
export function resolveConfigDir(cfgValue: string | null, homeValue: string | null): string {
  if (configDirCache !== null) return configDirCache;
  const base =
    cfgValue && cfgValue.length > 0 ? cfgValue : homeValue && homeValue.length > 0 ? `${homeValue}/.claude` : null;
  if (base === null) throw new Error("session-owl: cannot resolve config dir (no CLAUDE_CONFIG_DIR, no HOME)");
  configDirCache = base.replace(/\\/g, "/").replace(/\/+$/, "");
  return configDirCache;
}

/** The cached dir (or null before the first resolution). */
export function getCachedConfigDir(): string | null {
  return configDirCache;
}

// ---- session dirs + marker (path math only; IO is the handler's) ---------------

export function sanitize(segment: string): string {
  // percent-encode (not underscore-collapse): two distinct ids must never
  // map to the same directory ("a|b" vs "a_b")
  let clean = segment.replace(/[^a-zA-Z0-9._-]/g, (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
  if (clean === "." || clean === "..") clean = "_";
  return clean.length > 0 ? clean : "_";
}

export function sessionOwlRoot(configDirValue: string): string {
  return `${configDirValue.replace(/\/+$/, "")}/session-owl`;
}

export function sessionDirPath(configDirValue: string, sessionId: string, agentId: string | null = null): string {
  const suffix = agentId ? `-${sanitize(agentId)}` : "";
  return `${sessionOwlRoot(configDirValue)}/sessions/${sanitize(sessionId)}${suffix}`;
}

/** The marker path for a session (requires the config dir resolved). */
export function sessionMarkerPath(sessionId: string): string {
  if (configDirCache === null) throw new Error("session-owl: config dir not resolved yet");
  return `${sessionDirPath(configDirCache, sessionId, null)}/${SESSION_MARKER_FILENAME}`;
}

/** The marker JSON: facts from the hook envelope — never derived from cwd. */
export function sessionMarkerJson(sessionId: string, transcriptPath: string | undefined): string {
  return JSON.stringify({ sessionId, transcriptPath });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read-side tolerant parse: absent/corrupt -> null (the envelope re-records). */
export function parseSessionMarker(text: string): { sessionId: string; transcriptPath?: string } | null {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.sessionId === "string") return parsed;
    return null;
  } catch (err) {
    log.info(`session marker parse failed — treated as absent: ${errText(err)}`);
    return null;
  }
}

// ---- conversation registry -----------------------------------------------------

export function conversationKey(sessionId: string, agentId: string | null): string {
  return agentId ? `${sessionId}|${agentId}` : sessionId;
}

/**
 * Get-or-create the conversation's state. Called from the first event that
 * carries the key. Returns the (possibly existing) ConversationState.
 */
export function ensureConversation(sessionId: string, agentId: string | null = null): ConversationState {
  const key = conversationKey(sessionId, agentId);
  let state: ConversationState | undefined = registry.get(key);
  if (!state) {
    state = { key, sessionId, agentId, createdAt: Date.now(), dispose: [] };
    registry.set(key, state);
  }
  return state;
}

/** The enable live-predicate (settings wiring installs the real reader). */
let owlEnabled = true;

/** The ignoreConflicts live-predicate — the deliberate-co-run escape the
 *  conflict pause reads (a settings reload flips it mid-session). */
let owlIgnoreConflicts = false;

/** The subagentMode live-cache — how owl treats agent-scoped loops
 *  ("inherited" | "disabled" | "on-compaction"). The settings wiring
 *  installs the real reader; the capture + compaction gates read it
 *  live (a settings reload flips it mid-session). */
let owlSubagentMode: "inherited" | "disabled" | "on-compaction" = "on-compaction";

export function setOwlEnabled(value: boolean): void {
  owlEnabled = value;
}

export function isOwlEnabled(): boolean {
  return owlEnabled;
}

export function setOwlIgnoreConflicts(value: boolean): void {
  owlIgnoreConflicts = value;
}

export function isOwlIgnoreConflicts(): boolean {
  return owlIgnoreConflicts;
}

export function setOwlSubagentMode(value: "inherited" | "disabled" | "on-compaction"): void {
  owlSubagentMode = value;
}

/** The live subagent treatment; "disabled" = collect nothing for foreign
 *  subagent loops (no mirror, no stages, native compaction). */
export function getOwlSubagentMode(): "inherited" | "disabled" | "on-compaction" {
  return owlSubagentMode;
}

/** True when a FOREIGN subagent loop (not owl's own stage run) must be left
 *  entirely alone — the honest "disabled": nothing collected, nothing
 *  compacted by owl. Callers gate the spawn-registry check themselves. */
export function subagentsFullyDisabled(): boolean {
  return owlSubagentMode === "disabled";
}

/** The session id of the loop currently being observed. */
export function setCurrentSession(sessionId: string): void {
  currentSessionId = sessionId;
}

export function getSessionModel(): string | null {
  return sessionModel;
}

/** Record the engine's session model (the start sequence's config read).
 *  Only a CONCRETE identifier/alias sticks: while the session runs the engine's
 *  default model the /config row (and a step's selection) carries its human
 *  label ("Default (recommended)"), and a label forwarded to `$.model.complete`
 *  comes back as 404 model_not_found. Model values never contain whitespace —
 *  labels do — so the label records as null: the goal one-shot skips until the
 *  turn.step refresh stores the engine-resolved id. */
export function setSessionModel(model: string | null): void {
  sessionModel = model !== null && model.length > 0 && !/\s/.test(model) ? model : null;
}

export function getCurrentSession(): string | null {
  return currentSessionId;
}

let currentTranscriptPath: string | null = null;

/** The live session's transcript file path (classic session start supplies
 *  it; the rewind checkpoint's verifier layer reads it). */
export function setCurrentTranscriptPath(path: string | null): void {
  currentTranscriptPath = path;
}

export function getCurrentTranscriptPath(): string | null {
  return currentTranscriptPath;
}

// ---- idempotent registrar bookkeeping --------------------------------------------

// owl_recall's real spec (pi-verbatim description + schema — the recall
// module's import-free literals, drift-pinned by the recall spec suite) and
// the launch callback the subagent companion reports stage spawns through
const TOOL_SPECS = [owlRecallToolSpec(), stageLaunchedToolSpec(), awaitStageToolSpec()];

// Command names are kebab-case (the engine allows letters, digits, `_` and
// `-` only — no colons); the pi names map owl:STATUS -> owl-status etc. The
// descriptions are pi's own (registerUserCommands + registerStatusCommand +
// the settings pane's `Configure <title>`), with the kebab name swapped
// into the usage strings — the commands suite drift-gates this table
// against the dispatcher's OWL_COMMANDS (names must match exactly).
export const COMMAND_SPECS = [
  {
    name: "owl-ls",
    description: "List memory — roots, or a node's children. Usage: /owl-ls [nodeId]",
  },
  {
    name: "owl-cat",
    description: "Show a node's full observations, or one observation's full text. Usage: /owl-cat <id>",
  },
  {
    name: "owl-find",
    description: "Search memory by regex (non-obsolete). Usage: /owl-find <query>",
  },
  {
    name: "owl-find-all",
    description: "Search memory by regex (incl. obsolete/superseded). Usage: /owl-find-all <query>",
  },
  {
    name: "owl-rescan",
    description:
      "Discard the memory graph and re-observe the session from the start. --reuse-observations rebuilds from collected observations.",
  },
  {
    name: "owl-reobserve-0-obs-chunks",
    description:
      "Re-observe session ranges that were skipped with zero observations (repair after a degraded model run). Usage: /owl-reobserve-0-obs-chunks",
  },
  {
    name: "owl-status",
    description: "Show memory stats and per-phase token/cost usage. Usage: /owl-status",
  },
  { name: "owl-settings", description: "Configure SessionOwl Settings" },
];

/**
 * Registration bookkeeping: the handler spells the literal $.tool.register /
 * $.command.register calls over these specs. Each list is handed out ONCE;
 * the second start (either event) re-registers nothing. A {compact}
 * SessionStart takes no action beyond registration.
 */
export function pendingToolSpecs(): Record<string, unknown>[] {
  if (toolsRegistered) return [];
  toolsRegistered = true;
  // The registration gate: a session starting disabled never gets the
  // recall tool (an absent tool costs nothing; a mid-session enable
  // registers it then via the recall module's once-per-process path)
  if (!isOwlEnabled()) return [];
  recallToolRegistered = true;
  return TOOL_SPECS;
}

/** Did the start gate already register owl_recall? (The mid-session enable
 *  path's coordination seam — a second $.tool.register would be a
 *  duplicate registration the engine treats as an error.) */
export function wasRecallToolRegistered(): boolean {
  return recallToolRegistered;
}

// ---- registration-gate reopens --------------------------------------------------
//
// pending* consume their gate at READ (idempotence: one service per process).
// The engine can refuse a whole source's registration — the startup
// classic.SessionStart fires before the session binds, so $.tool.register is
// unavailable there while the later session.start serves fine. A failed
// source must not burn the gate for the bound source that follows, and the
// refusal must not abort the caller's remaining bootstrap work. Only a queue
// that served NOTHING reopens (a partially served queue stays consumed — a
// retry would re-serve specs the engine already took, which it treats as an
// error); the read-once disabled latch is untouched (an empty gate raises no
// failure, so it never reopens).

export function reopenToolRegistrationGate(): void {
  toolsRegistered = false;
  recallToolRegistered = false;
}

export function reopenStageToolRegistrationGate(): void {
  stageToolsRegistered = false;
}

export function reopenCommandRegistrationGate(): void {
  commandsRegistered = false;
}

export function reopenAgentRegistrationGate(): void {
  agentsRegistered = false;
}

export function pendingCommandSpecs(): Record<string, unknown>[] {
  if (commandsRegistered) return [];
  commandsRegistered = true;
  return COMMAND_SPECS;
}

/** Stage-tool specs (the stage engine's registration surface) — handed out
 *  once per process, same rule as the tools above. */
export function pendingStageToolSpecs(): Record<string, unknown>[] {
  if (stageToolsRegistered) return [];
  stageToolsRegistered = true;
  return STAGE_TOOL_SPECS as unknown as Record<string, unknown>[];
}

/** Stage agent specs — computed by the caller (settings-shaped), consumed
 *  once per process. */
export function pendingAgentSpecs<T>(specs: T[]): T[] {
  if (agentsRegistered) return [];
  agentsRegistered = true;
  return specs;
}

// ---- session.end teardown ---------------------------------------------------------

/**
 * The session.end body: within the 1.5 s budget — signal-abort in-flight
 * stage runs, terminate per-key regex workers, clear resolvers and caches.
 * Pure in-memory teardown: no persistence writes, no deferred work, no
 * engine calls (nothing to call out for here).
 */
export async function sessionEndBody(): Promise<void> {
  for (const state of registry.values()) {
    for (const dispose of state.dispose) {
      try {
        await dispose();
      } catch (err) {
        log.warn(`session-end dispose callback failed: ${errText(err)}`);
        // teardown is best-effort; one failing callback must not block the rest
      }
    }
  }
  registry.clear();
  currentSessionId = null;
  // the trigger layer's per-conversation maps go with the sessions
  pruneMeasures();
  pruneIdleLocks();
}

/** Test seam: clear module state (mirrors the pi suite's setup resets). */
export function _resetForTest(): void {
  registry.clear();
  currentSessionId = null;
  configDirCache = null;
  toolsRegistered = false;
  recallToolRegistered = false;
  commandsRegistered = false;
  stageToolsRegistered = false;
  agentsRegistered = false;
  bridge.clearRouting();
  owlEnabled = true;
  owlIgnoreConflicts = false;
  owlSubagentMode = "on-compaction";
  currentTranscriptPath = null;
}
