// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { log } from "../../core/src/log.js";
import type { UncoveredRange } from "../../core/src/triggers.js";
import { makeEntryResolver } from "../capture/details-bridge.js";
import { groupRows } from "../capture/grouper.js";
// The start sequence: at session start (any source — startup/resume/fork/
// clear), sweep the session directory, read the transcript (≤4 MiB whole),
// re-mirror the live path by the ABSENT-CHECK (the crash-window rule: rows
// whose turn never flushed are still re-mirrored — the frontier never gates
// re-mirroring), reconstruct the store through the core multiplexer (fold +
// frontier derive from the records), seed nGoal, capture the initial prompt,
// and compute the pending backlog (coverage-union holes behind the
// frontier). A cold fork first ADOPTS the parent's segment files (mirror +
// ledger batches copied into the child's dir — the records carry over and
// the frontier derives from them).
import { getCore } from "../core-instances.js";
import { sanitize } from "../state.js";
import type { FsAdapter } from "../storage/fs-adapter.js";
import type { LedgerWriter } from "../storage/ledger.js";
import { batchNameParts, type MirrorWriter, sweepMirror } from "../storage/mirror.js";
import { SESSION_MARKER_FILENAME } from "../storage/session-marker.js";
import { prepareStoreContext, ROW_TYPE } from "../storage/store-context.js";
import { captureInitialPrompt, ensureNGoalSeeded } from "./initial-prompt.js";
import type { PendingEvaluator } from "./pending.js";
import { livePath, readTranscript, rowFromTranscript } from "./transcript-reader.js";

// --- named constants (no bare literals at call sites) ----------------------

/** Widths/padding for the order-key parts — Number.MAX_SAFE_INTEGER is 16
 *  digits; batch seqs stay under 8 digits in any realistic session. */
const TIMESTAMP_KEY_WIDTH = 16;
const SEQ_KEY_WIDTH = 8;
const NO_BATCH_SEQ = 0;

export interface BackfillOptions {
  /** The conversation key (state.conversationKey derivation). */
  key: string;
  sessionId: string;
  agentId: string | null;
  fs: FsAdapter;
  /** The transcript path (from the session marker); null = fresh session. */
  transcriptPath: string | null;
  /** Settings gate: a disabled session persists no OBSERVATIONS (nGoal seed
   *  + initial prompt skip — pi: no graph_delta); the row mirror stays warm
   *  (pi's session file always grows; owl adds nothing of its own). */
  enabled: boolean;
  /** The goal-extraction launch hook (fired exactly on a fresh capture). */
  fireGoalExtract: (verbatim: string) => void;
  /** A cold fork's parent session id (adoption source); null otherwise. */
  forkParentSessionId?: string | null;
  /** The coverage-union evaluator (injected; absent = no backlog this run). */
  computePending?: PendingEvaluator;
  /** The over-cap transcript bootstrap (injected; the register wiring runs
   *  helpers/bootstrap.mjs via $.process.run on CLI surfaces). Called BEFORE
   *  the sweep when the transcript exceeds the whole-read cap — the helper
   *  writes mirror batches into the session directory and the sweep picks
   *  them up. Absent = the ladder defers (blocked backlog, rung 4). */
  bootstrapOverCap?: (transcriptPath: string) => Promise<boolean>;
}

export interface BackfillResult {
  /** The Observer frontier after reconstruction (records are its storage). */
  frontier: string | null;
  /** Coverage-union holes behind the frontier (the repairable backlog). */
  pending: UncoveredRange[];
  /** Transcript rows re-mirrored this start (the closed crash windows). */
  remirrored: number;
  /** The transcript exceeded the whole-read cap (bootstrap ladder next). */
  tooLarge: boolean;
  /** The over-cap history is NOT mirrored (helper absent/failed/deferred):
   *  the backlog stays blocked — /owl-status documents the manual command. */
  bootstrapBlocked: boolean;
  /** nGoal seeded / oInitialPrompt captured this run (enabled-gated writes). */
  initialPromptCaptured: boolean;
  /** A cold fork adopted the parent's segments. */
  adoptedFromParent: boolean;
  /** The prepared store context the core was built over (the rewind
   *  checkpoint's refold target — the SAME object the ctxFactory holds). */
  prepared: Awaited<ReturnType<typeof prepareStoreContext>>;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** List a directory (missing = empty, the fresh-session truth). */
async function listDir(fs: FsAdapter, dir: string): Promise<string[]> {
  try {
    return await fs.listDir(dir);
  } catch (err) {
    log.info(`backfill listDir failed, treated as empty (${dir}): ${errText(err)}`);
    return [];
  }
}

/** Copy every owl segment file from the parent's session dir into the
 *  child's (adoption: records + mirrored rows carry over verbatim — the
 *  fold then sees them as the child's own). */
async function adoptParentSegments(fs: FsAdapter, parentDir: string, childDir: string): Promise<number> {
  const names = await listDir(fs, parentDir);
  let copied = 0;
  for (const name of names) {
    if (name === SESSION_MARKER_FILENAME) continue;
    try {
      const text = await fs.readText(`${parentDir}/${name}`);
      await fs.writeText(`${childDir}/${name}`, text);
      copied += 1;
    } catch (err) {
      log.info(`backfill adoption: parent segment skipped (${name}): ${errText(err)}`);
      // an unreadable parent segment is skipped — adoption is best-effort,
      // the absent-check re-mirror still guarantees the rows
    }
  }
  return copied;
}

/**
 * The start sequence. `mirror`/`ledger` are the conversation's live writers
 * (the storage assembly's instances — appends after this start flow into
 * the same writers).
 */
export async function runBackfill(
  mirror: MirrorWriter,
  ledger: LedgerWriter,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const fs = opts.fs;
  const dir = mirror.directory;

  // 1. transcript read (the fidelity source; null/absent = fresh session)
  const transcript = await readTranscript(fs, opts.transcriptPath ?? "/nonexistent.jsonl");

  // 2. fork adoption: a copied transcript's tip still names the PARENT
  //    session — when it differs from this session's id, adopt the parent's
  //    segments (explicit option wins; the evidence rule otherwise)
  const forkParent =
    opts.forkParentSessionId !== null && opts.forkParentSessionId !== undefined
      ? opts.forkParentSessionId
      : transcript.tooLarge
        ? null
        : tipParentOf(transcript.tip, opts.sessionId);
  let adopted = false;
  if (forkParent !== null) {
    // the tip-derived parent id is transcript-controlled: percent-encode the
    // unsafe chars (the same rule the session-dir layout sanitizes with)
    const parentDir = `${dirRootOf(dir)}/${sanitize(forkParent)}`;
    const copied = await adoptParentSegments(fs, parentDir, dir);
    adopted = copied > 0;
  }

  // 1b. the over-cap bootstrap (the ladder's automatic rung): the helper
  //     streams the transcript and writes mirror batches BEFORE the sweep
  //     picks them up; a failure defers (the readable backlog still observes,
  //     the rest stays pending — rung 4 semantics, /owl-status documents
  //     the manual command)
  let bootstrapBlocked = false;
  if (transcript.tooLarge && opts.transcriptPath !== null) {
    const ran = opts.bootstrapOverCap !== undefined ? await opts.bootstrapOverCap(opts.transcriptPath) : false;
    bootstrapBlocked = !ran;
  }

  // sweep the mirror + adopt its rows into the live writer's index (the
  // ladder case still reconstructs from the segments — rung 4 observes the
  // readable backlog; only the transcript re-mirror waits for the ladder)
  const sweep = await sweepMirror(fs, dir);
  mirror.adoptRows(sweep.rows);

  let remirrored = 0;
  if (!transcript.tooLarge) {
    const live = livePath(transcript.rows, transcript.tip?.leafUuid ?? null);
    // the transcript's full row set (by uuid) — the parent resolver walks a
    // live row's file parent THROUGH the rows the mirror never carries
    // (system/attachment chrome, dead forks) onto the nearest live ancestor;
    // a raw file parent would chain into a row the mirror lacks and every
    // chain walk would truncate exactly there
    const rowsByUuid = new Map(transcript.rows.map((r) => [r.uuid, r]));
    const resolveParent = (uuid: string): string | null => {
      let cur: string | null = uuid;
      for (let hops = 0; hops < 4096 && cur !== null; hops += 1) {
        if (liveSet.has(cur)) return cur; // live itself — the direct parent
        const row = rowsByUuid.get(cur);
        if (row === undefined) return cur; // past the file's knowledge
        if (row.parentUuid === null) return null;
        cur = row.parentUuid; // chrome/dead — resolve through it
      }
      return cur;
    };
    const liveSet = new Set(live.map((r) => r.uuid));
    // re-mirror by the absent-check (the crash-window rule): every live
    // row whose uuid is absent from the mirror is written NOW — regardless
    // of where the frontier sits
    for (const tr of live) {
      if (mirror.rowByUuid(tr.uuid) !== undefined) continue;
      const parentUuid = tr.parentUuid === null ? null : resolveParent(tr.parentUuid);
      mirror.bufferRow({ uuid: tr.uuid, parentUuid, row: rowFromTranscript(tr) });
      remirrored += 1;
    }
    if (remirrored > 0) await mirror.flush();
  }

  // 2b. the load-path row order: file enumeration is producer-hash order,
  //     not conversation order (same-seq batches from different processes
  //     tie and the directory listing decides) — re-sequence the index by
  //     the fold's own total order (timestamp, producer, seq) before any
  //     consumer reads it. The key comes from the row content at this
  //     shape-aware call site; storage stays opaque to the row shape.
  //     File-less rows (re-mirrored, not yet flushed) key on their
  //     timestamp with empty producer/seq; a missing timestamp sorts last.
  {
    const keyCache = new Map<string, string>();
    const keyOf = (uuid: string): string => {
      const hit = keyCache.get(uuid);
      if (hit !== undefined) return hit;
      const row = mirror.rowByUuid(uuid)?.row as { timestamp?: unknown } | undefined;
      const tsRaw = row?.timestamp;
      const parsed = typeof tsRaw === "string" ? Date.parse(tsRaw) : Number.NaN;
      const tsKey = Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : parsed;
      const file = sweep.uuidFile.get(uuid);
      const parts = file === undefined ? null : batchNameParts(file);
      const key = `${String(tsKey).padStart(TIMESTAMP_KEY_WIDTH, "0")}|${parts?.producer ?? ""}|${String(
        parts?.seq ?? NO_BATCH_SEQ,
      ).padStart(SEQ_KEY_WIDTH, "0")}`;
      keyCache.set(uuid, key);
      return key;
    };
    mirror.reorderBy(keyOf);
  }

  // 3. reconstruct through the core multiplexer: fold + load + frontier
  // prepareStoreContext folds + resolves as its last construction step —
  // no redundant second fold here
  const prepared = await prepareStoreContext(fs, dir, ledger, mirror);
  const handle = await getCore(opts.key, {
    ctxFactory: () => prepared.ctx,
    resolverFactory: () => makeEntryResolver({ rows: () => mirrorRowsOf(mirror), version: () => mirror.rowVersion() }),
  });

  // 4. seed + initial prompt (enabled-gated: a disabled session persists
  //    nothing; the graph still reconstructs read-only)
  let initialPromptCaptured = false;
  if (opts.enabled) {
    const ctx = prepared.ctx;
    ensureNGoalSeeded(handle, ctx);
    const entries = groupRows(mirrorRowsOf(mirror));
    const captured = captureInitialPrompt(handle, ctx, entries, opts.fireGoalExtract);
    initialPromptCaptured = captured !== null;
    if (initialPromptCaptured) await ledger.flush();
  }

  // 5. pending backlog: coverage-union holes behind the derived frontier
  //    (evaluator injected — the vendored triggers module sits outside the
  //    hooks closure until the bare-specifier gap resolves)
  const store = handle.store;
  const frontier = store.getGraphStore().observerFrontier;
  const pending =
    opts.computePending !== undefined ? opts.computePending(branchSessionEntries(prepared, mirror), frontier) : [];

  return {
    frontier,
    pending,
    remirrored,
    tooLarge: transcript.tooLarge,
    bootstrapBlocked,
    initialPromptCaptured,
    adoptedFromParent: adopted,
    prepared,
  };
}

/** The store branch as pi's session-entry view: ROW markers expand through
 *  the grouper (user/assistant/toolResult entries), records stay interleaved
 *  at their marker positions — the exact shape computeUncoveredRanges
 *  anchors and covers over (the raw store entries carry no user messages,
 *  so the anchor would find nothing and the backlog would read empty).
 *
 * INVARIANT: entry ids on this view are GROUP-START row uuids — a record
 * citing a mid-group row uuid (e.g. a tool_use row inside an assistant
 * response) does not resolve here: its interval is skipped and a frontier
 * at it reads as everything-observed (empty backlog). Writers MUST cite
 * entry-view ids (group starts); pinned by the mid-group-cite test. */
function branchSessionEntries(
  prepared: Awaited<ReturnType<typeof prepareStoreContext>>,
  mirror: MirrorWriter,
): Parameters<PendingEvaluator>[0] {
  const branch = prepared.ctx.getBranch(prepared.ctx.getLeafId());
  const out: unknown[] = [];
  let rowRun: import("../capture/grouper.js").ClaudeRow[] = [];
  const flushRun = () => {
    if (rowRun.length > 0) {
      out.push(...groupRows(rowRun));
      rowRun = [];
    }
  };
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === ROW_TYPE) {
      const uuid = (entry.data as { uuid?: unknown }).uuid;
      const row = typeof uuid === "string" ? mirror.rowByUuid(uuid)?.row : undefined;
      if (row !== undefined) rowRun.push(row as import("../capture/grouper.js").ClaudeRow);
    } else {
      flushRun();
      out.push(entry);
    }
  }
  flushRun();
  return out as unknown as Parameters<PendingEvaluator>[0];
}

/** The fork-evidence rule: a tip naming ANOTHER session means the
 *  transcript was copied from it (cold fork / branch) — that session's
 *  segments are the adoption source. */
function tipParentOf(tip: { sessionId?: string } | null, ownId: string): string | null {
  const sid = tip?.sessionId;
  return typeof sid === "string" && sid !== ownId ? sid : null;
}

function dirRootOf(dir: string): string {
  const bar = dir.lastIndexOf("/");
  return bar <= 0 ? dir : dir.slice(0, bar);
}

/** The mirror's rows as capture rows, arrival order (the resolver index). */
function mirrorRowsOf(mirror: MirrorWriter): import("../capture/grouper.js").ClaudeRow[] {
  const out: import("../capture/grouper.js").ClaudeRow[] = [];
  for (const uuid of mirror.arrivalOrder()) {
    const row = mirror.rowByUuid(uuid)?.row;
    if (row !== undefined) out.push(row as import("../capture/grouper.js").ClaudeRow);
  }
  return out;
}
