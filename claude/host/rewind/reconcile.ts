// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The reconciliation orchestration — the rewind on-change handling. The
// check is
// the FIRST step of every check-point; on divergence it aborts and awaits
// in-flight runs (the run-lock), quarantines the blind window (records
// ordered after the last clean CHECK drop regardless of marker liveness),
// re-folds by marker liveness, and logs. Truth is the engine's canonical
// chain — orphaned replies are dead-marked, never repaired. CHECK records
// persist at turn-complete-class boundaries, process start, and
// divergence-verify; a recall-entry check updates the in-memory watermark
// only (its persisted boundary is the earlier CHECK — a coarser boundary
// can only widen the quarantine, never narrow it). Last resort: only when
// the api-form call fails AND no tripwire is available does the check
// skip-and-log (the accepted degrade, continuity assumption).

import { errDetail } from "../log/err-detail.js";
import { absentTailConfirm, alignCanonical, type Fingerprint, type KnownRow } from "./canonical-check.js";
import type { LineageEdge } from "./lineage.js";
import type { TruncationTripwires } from "./tripwires.js";
import { exactEdges, liveChainSet, parseTranscript, type TranscriptPass, verifyJunction } from "./verifier.js";

/** Everything the orchestration needs, injected (no $ literals here — the
 *  register wiring owns those). */
export interface CheckpointDeps {
  /** The conversation key (the main session or a subagent loop) — every
   *  layer addresses the conversation of the check-point that fired. */
  key: string;
  /** The canonical view's fingerprints (`messages({as:"api"})` mapped). */
  apiMessages: () => Promise<Fingerprint[]>;
  /** The previously-known live path (tip LAST) with fingerprints. */
  knownPath: () => KnownRow[];
  /** The current known tip (the CHECK marker at persist points). */
  knownTip: () => string | null;
  /** The transcript file's text, where readable (the verifier pass); null
   *  when unavailable — the check stays on the api form alone. */
  transcriptText?: () => Promise<string | null>;
  /** The pre-parsed transcript pass — the richer tier the wiring arms when
   *  the text route cannot serve it (an over-cap file on a CLI surface:
   *  the Node helper streams the rows + tip). PREFERRED over
   *  transcriptText; null = the tier is missing (the layer-2 verdict
   *  proceeds — never a blocked check). */
  transcriptPass?: () => Promise<TranscriptPass | null>;
  /** The per-conversation tripwires; absent = unavailable (affects degrade). */
  tripwires?: TruncationTripwires;
  /** Abort the conversation's in-flight stage runs and await their release. */
  abortAndAwaitInFlight: () => Promise<void>;
  /** The live path for a junction anchor (the mirror's edges, the lineage
   *  ledger's, or the arrival order — by edge authority). */
  liveSetFor: (p: string | null) => Promise<string[]>;
  /** Re-fold the store (quarantine + marker liveness) — the divergence
   *  move; the detected live set feeds marker liveness (the snapshot
   *  selection rule) and its order becomes the served branch. */
  refold: (
    liveSet: ReadonlySet<string>,
    liveOrder: readonly string[],
    dead: ReadonlySet<string>,
  ) => Promise<{ quarantined: number }>;
  /** Divergence notification (the caller records the dead set — the known
   *  path of FUTURE checks excludes it; a re-detected old divergence would
   *  otherwise re-fire on every clean turn). */
  onDivergence?: (p: string | null, dead: string[]) => void;
  /** The newest observed compaction-boundary row uuid (prefix-exempt in the
   *  alignment — a summarized api prefix is not a rewind). */
  compactionBoundary?: () => string | null;
  /** The compaction boundary's arrival time — the inert-anchor fallback
   *  axis when the boundary uuid never reached the mirror. */
  compactionBoundaryAt?: () => number | null;
  /** The one-shot resume boundary: a resume/clear/continuation start seeds
   *  the pre-start mirror tip; rows at-or-before it are expected
   *  re-shaped/absent in the resumed view. Cleared at the first clean
   *  verdict (full detection resumes). */
  resumeBoundary?: () => string | null;
  resumeBoundaryAt?: () => number | null;
  clearResumeBoundary?: () => void;
  /** The messages() ROWS form uuids where available — the absent-tail
   *  double check (the known tip still present there contradicts a
   *  divergence reading). */
  rowUuids?: () => Promise<string[] | null>;
  /** Append a persisted CHECK record at the given marker. */
  appendCheck: (marker: string) => void;
  /** The uuids with an EXACT lineage edge folded from a PAST verifier pass —
   *  file-proven rows. An entirely-absent known row counts dead ONLY with
   *  this proof of once-filed existence: mirror-only capture residue never
   *  carries an exact edge and must not be adjudicated (the false re-anchor
   *  class). Absent (unwired) = absence decides, as before. */
  fileProvenUuids?: () => Promise<ReadonlySet<string>>;
  /** Persist exact lineage edges from a verifier pass (supersede-capable). */
  appendEdges?: (edges: LineageEdge[], marker: string) => void;
  /** The logger line sink (the reconciliation + skip lines). */
  log: (line: string) => void;
}

export type CheckpointVerdict =
  | { kind: "clean"; via: "api" | "tripwire" | "file" | "lag" }
  | {
      kind: "divergence";
      /** The alignment junction — the anchor of the live path; null when
       *  nothing known survives. */
      P: string | null;
      provisional: boolean;
      /** Known rows absent from the canonical view (the dead tail). */
      deadRows: number;
      /** Records dropped by the blind-window quarantine at the re-fold. */
      quarantined: number;
      /** The rows-form double check confirmed the absent tail (true when
       *  the rows form is unavailable — the api form carries the verdict). */
      tailConfirmed: boolean;
      /** The transcript pass confirmed the junction (exact edges appended). */
      verified: boolean;
    }
  | { kind: "skipped"; reason: string };

/** The in-memory clean watermark per key (the recall-entry boundary). */
const cleanWatermark = new Map<string, string | null>();

/** Run one layered check-point. `persist` = a CHECK-appending point (turn
 *  boundary, process start); a recall entry passes persist:false — its
 *  watermark update never narrows the persisted quarantine boundary. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Record the file's exact edges at a CLEAN persist boundary — the
 *  provenance snapshot that later tells a once-filed row (a rewrite removed
 *  it → dead) from mirror-only capture residue (never filed → never dead).
 *  Divergence paths append their pass's edges inline; a clean path has none
 *  in hand, so it resolves the pass here (same tier ladder — a missing tier
 *  records nothing, never a failure). */
async function recordCleanProvenance(deps: CheckpointDeps, marker: string | null): Promise<void> {
  if (deps.appendEdges === undefined) return;
  try {
    let pass: TranscriptPass | null = null;
    if (deps.transcriptPass !== undefined) {
      pass = await deps.transcriptPass().catch((err: unknown) => {
        deps.log(`session-owl: rewind adjudication read failed — degraded: ${errDetail(err)}`);
        return null;
      });
    } else if (deps.transcriptText !== undefined) {
      const text = await deps.transcriptText().catch((err: unknown) => {
        deps.log(`session-owl: rewind adjudication read failed — degraded: ${errDetail(err)}`);
        return null;
      });
      if (text !== null) pass = parseTranscript(text);
    }
    if (pass !== null && pass.kind === "ok" && pass.rows.length > 0) {
      deps.appendEdges(exactEdges(pass.rows), pass.tip ?? marker ?? "seed");
      if (pass.rewound) {
        // the engine stamped a rewind marker but the chain math found no
        // damage — observability only (the marker corroborates, never
        // substitutes: parallel results can sit off-chain yet alive)
        deps.log("session-owl: rewind check — last-prompt marker rewound:true; chain intact, no dead rows");
      }
    }
  } catch (err) {
    // the provenance tier is best-effort: a failed snapshot records
    // nothing — but the failure itself is said, with its stack
    deps.log(`session-owl: rewind provenance snapshot failed (tier skipped): ${errDetail(err)}`);
  }
}

export async function runCheckpoint(deps: CheckpointDeps, opts: { persist: boolean }): Promise<CheckpointVerdict> {
  let api: Fingerprint[] | null = null;
  try {
    api = await deps.apiMessages();
  } catch (err) {
    deps.log(`rewind check: api view unreadable — tripwire path decides: ${errText(err)}`);
    api = null;
  }

  if (api !== null) {
    // The one-shot resume boundary is consumed ONLY by a check that knows
    // rows of ours: the process-start check runs before the sweep (empty
    // known-set) and its clean verdict validates nothing — clearing there
    // would disarm the only shield the real first check ever receives.
    const clearOneShot = deps.knownPath().length > 0 ? deps.clearResumeBoundary : undefined;
    const resumeUuid = deps.resumeBoundary?.() ?? null;
    const boundary = resumeUuid ?? deps.compactionBoundary?.() ?? null;
    const boundaryAt =
      resumeUuid !== null ? (deps.resumeBoundaryAt?.() ?? null) : (deps.compactionBoundaryAt?.() ?? null);
    const verdict = alignCanonical(
      deps.knownPath(),
      api,
      boundary !== null ? { exemptUpTo: boundary, exemptUpToAt: boundaryAt ?? undefined } : {},
    );
    if (verdict.kind === "clean") {
      deps.tripwires?.markCheckedClean(deps.key);
      const tip = deps.knownTip();
      cleanWatermark.set(deps.key, tip);
      // a persist point with nothing known yet appends nothing: the "seed"
      // marker is never live, so its CHECK would be inert — the first turn's
      // flush CHECK is the first meaningful boundary
      if (opts.persist && tip !== null) deps.appendCheck(tip);
      if (opts.persist) await recordCleanProvenance(deps, tip);
      clearOneShot?.(); // the one-shot: the resumed view is validated
      return { kind: "clean", via: "api" };
    }
    // divergence — verify where the transcript is readable, then reconcile
    // The WATERMARK LAG TEST first (cheap, no IO): every known row the api
    // view still carries sits at-or-after the last CLEAN check's watermark
    // ⇒ the absent tail is strictly rows that arrived AFTER that check —
    // no view (api or file, both can trail live rows at a turn boundary)
    // has ever been asked to carry them. Adjudicating them dead fired a
    // false rewind every turn; they re-adjudicate at the next check once
    // the views catch up. A real rewind kills CHECKED rows (junction below
    // the watermark) and still fires. The junction P is the deepest known
    // row STILL PRESENT — a text-matched (provisional) junction is still a
    // presence fact, so it defers too (a provisional guard here once let
    // an unflushed tail adjudicate dead on the file view).
    const prevWatermark = cleanWatermark.get(deps.key) ?? null;
    const knownOrder = deps.knownPath().map((r) => r.uuid);
    const wmIdx = prevWatermark !== null ? knownOrder.indexOf(prevWatermark) : -1;
    if (prevWatermark !== null && verdict.evidence.absentAfterJunction) {
      const pIdx = verdict.P !== null ? knownOrder.indexOf(verdict.P) : -1;
      // every ABSENT row must also sit strictly AFTER the watermark: a
      // restore-fork keeps the file's rows (present, off the live chain)
      // while the api view drops the abandoned branch — rows a past CHECK
      // verified carried are not "fresh tail", whatever the junction index
      // says (the fork's junction is the re-send, which arrives after them)
      const absentAfterWatermark =
        wmIdx >= 0 && verdict.evidence.deadUuids.every((uuid) => knownOrder.indexOf(uuid) > wmIdx);
      if (wmIdx >= 0 && pIdx >= wmIdx && absentAfterWatermark) {
        deps.tripwires?.markCheckedClean(deps.key);
        cleanWatermark.set(deps.key, deps.knownTip());
        // NOT a persist point: the fresh tail has not been verified by any
        // view — the CHECK lands when a view actually carries these rows
        clearOneShot?.(); // the one-shot: a lag-clean still validates the resumed view
        if (opts.persist) await recordCleanProvenance(deps, deps.knownTip());
        return { kind: "clean", via: "lag" };
      }
    }
    // The FIRST-TURN lag: no watermark (nothing ever clean-checked — the
    // session started with an empty transcript) and the api view matched
    // NOTHING of ours — both views simply never carried the fresh turn yet
    // (the request builds before the rows exist; the file flushes late).
    // Adjudicating them dead fired a 6-dead-rows false rewind on every
    // fresh session's first boundary, aborting the in-flight observer. A
    // real rewind rewrites the file and the NEXT boundary's view carries
    // the rewound branch — its junction sits at/below this tip, so the
    // watermark set here adjudicates it then (one turn late at worst, the
    // cost of never false-rewinding turn one).
    if (prevWatermark === null && verdict.P === null) {
      deps.tripwires?.markCheckedClean(deps.key);
      cleanWatermark.set(deps.key, deps.knownTip());
      clearOneShot?.(); // the one-shot: a first-turn lag also validates the resumed view
      if (opts.persist) await recordCleanProvenance(deps, deps.knownTip());
      return { kind: "clean", via: "lag" };
    }
    let p = verdict.P;
    let provisional = verdict.provisional;
    let verified = false;
    let pass: TranscriptPass | null = null;
    if (deps.appendEdges !== undefined) {
      // the tier resolution order: the pre-parsed pass (the helper route)
      // outranks the raw-text route; both missing = the tier is absent
      if (deps.transcriptPass !== undefined) {
        pass = await deps.transcriptPass().catch((err: unknown) => {
          deps.log(`session-owl: rewind adjudication read failed — degraded: ${errDetail(err)}`);
          return null;
        });
      } else if (deps.transcriptText !== undefined) {
        const text = await deps.transcriptText().catch((err: unknown) => {
          deps.log(`session-owl: rewind adjudication read failed — degraded: ${errDetail(err)}`);
          return null;
        });
        if (text !== null) pass = parseTranscript(text);
      }
      if (pass !== null && pass.kind === "ok") {
        deps.appendEdges(exactEdges(pass.rows), pass.tip ?? p ?? "seed");
        verified = true;
        // The file tier's dead set (below) adjudicates the api-nominated
        // rows: PRESENT-but-off-chain = the restore-fork class (the engine
        // keeps every row; the abandoned branch drops off the live chain);
        // ABSENT-with-once-filed-proof = a rewrite removed it. Interior
        // off-chain rows the api view still carries (the engine's
        // parallel-tool shape parents each tool_result at its own tool_use)
        // are never nominated and stay live — a healthy transcript
        // legitimately carries them.
        if (p !== null) {
          const junction = verifyJunction(pass.rows, p);
          if (junction.present) {
            provisional = false; // the file confirms the junction row
          } else {
            // a text false-match: re-anchor on the file's live chain — the
            // deepest known row on the tip's parent chain
            p = deepestKnownOnFileChain(pass.rows, pass.tip, deps.knownPath());
            provisional = p !== null;
          }
        }
      }
    }
    // the rows-form double check: a still-present known tip contradicts the
    // api-form reading (a low-density junction region can text-collide)
    let tailConfirmed = true;
    if (deps.rowUuids !== undefined) {
      const rowUuids = await deps.rowUuids().catch((err: unknown) => {
        deps.log(`session-owl: rewind adjudication read failed — degraded: ${errDetail(err)}`);
        return null;
      });
      if (rowUuids !== null) tailConfirmed = absentTailConfirm(rowUuids, deps.knownTip());
    }
    // The DEAD set's authority: the FILE's live chain when the pass exists
    // (a rewound file drops known rows off the live chain — present-but-
    // off-chain is the restore-fork signature; an absent row dies only when
    // a past pass PROVED the file carried it). Without a pass the
    // ledger/mirror live set decides (the best available evidence). The api
    // layer NOMINATES (its absent rows) — off-chain rows a view still
    // carries (parallel tool_results) are never nominated and never die.
    const passEvidence = pass !== null && pass.kind === "ok" ? liveChainSet(pass.rows, pass.tip) : null;
    const passPresent = pass !== null && pass.kind === "ok" ? new Set(pass.rows.map((r) => r.uuid)) : null;
    if (passEvidence !== null && passPresent !== null) {
      // VIEW COHERENCE — the gate that keeps a drifted view from killing.
      // Only a COHERENT view may adjudicate its off-chain absences as the
      // abandoned branch; the scoping detail rides the filter below.
      const knownForCoherence = deps.knownPath();
      // A known row ON the file's live chain yet ABSENT from the api view
      // means the view drifted — BUT only when the row is one a past check
      // already saw carried (at or before the clean watermark). Rows AFTER
      // the watermark are the just-finished turn's own material (the api
      // form reflects the last built request — the reply is not in any
      // request yet): they trail by design at EVERY turn boundary and name
      // nothing. A previously-carried row the view now drops (a resumed
      // session's re-rendered history, a stale request) is real drift — the
      // chain wins wholesale and the view's absences adjudicate nothing.
      const driftedAbsent = knownForCoherence.filter(
        (r, i) => passEvidence.has(r.uuid) && verdict.evidence.deadUuids.includes(r.uuid) && !(wmIdx >= 0 && i > wmIdx),
      );
      if (driftedAbsent.length > 0) {
        deps.log(
          `session-owl: rewind check — the api view drifted from the file's own chain ` +
            `(${driftedAbsent.length} previously-carried absence(s) name on-chain rows — resume re-render or stale request) ` +
            "— adjudicated ZERO dead rows; the chain wins, no re-fold",
        );
        deps.tripwires?.markCheckedClean(deps.key);
        const knownTipNow = deps.knownTip();
        cleanWatermark.set(deps.key, knownTipNow);
        if (opts.persist && knownTipNow !== null) deps.appendCheck(knownTipNow);
        return { kind: "clean", via: "file" };
      }
    }
    const liveList = await deps.liveSetFor(p);
    const liveSet = new Set(liveList);
    // The nomination set: the alignment's dead rows PLUS the known rows the
    // alignment cannot see — signal-less fingerprints (string-content rows,
    // image-only prompts) can neither match nor die in the view walk, and a
    // rewind that removes them must still be caught by the file tier. The
    // same exemption boundary masks both (rows at-or-before the one-shot
    // resume / compaction cut stay exempt).
    const knownRowsNow = deps.knownPath();
    const knownOrderNow = knownRowsNow.map((r) => r.uuid);
    const exemptIdxNow = boundary !== null ? knownOrderNow.indexOf(boundary) : -1;
    const nominees = [...verdict.evidence.deadUuids];
    for (let i = 0; i < knownRowsNow.length; i += 1) {
      const uuid = knownOrderNow[i];
      if (nominees.includes(uuid)) continue;
      if (exemptIdxNow >= 0 && i <= exemptIdxNow) continue;
      const f = knownRowsNow[i].f;
      if (f.toolUseIds.length === 0 && f.toolResultIds.length === 0 && f.textSig === "") {
        nominees.push(uuid);
      }
    }
    let dead: string[];
    if (passEvidence !== null && passPresent !== null) {
      let proven: ReadonlySet<string> | null = null;
      if (deps.fileProvenUuids !== undefined) {
        try {
          proven = await deps.fileProvenUuids();
        } catch (err) {
          deps.log(`session-owl: rewind provenance read failed (tier skipped): ${errDetail(err)}`);
          proven = null;
        }
      }
      dead = nominees.filter((uuid) => {
        if (passPresent.has(uuid)) {
          // the row is in the file: dead exactly when it sits OFF the live
          // chain (the fork class — direct file evidence, no provenance
          // needed: presence itself proves it was once filed)
          return !passEvidence.has(uuid);
        }
        // entirely absent from the file: dead only with once-filed proof —
        // mirror-only capture residue was never filed and must not be
        // adjudicated (the false re-anchor class); a failed provenance read
        // denies the verdict; an unwired tier keeps plain off-set semantics
        if (deps.fileProvenUuids === undefined) return !passEvidence.has(uuid);
        return proven?.has(uuid) ?? false;
      });
    } else {
      dead = nominees.filter((uuid) => !liveSet.has(uuid));
    }
    // ZERO dead rows = the live set holds every known row: the api layer's
    // absence reading was view shape, not damage (a 0-dead verdict has
    // adjudicated records into quarantine before). A real rewind always
    // drops rows from the live set — with
    // nothing dead there is nothing to abort, re-fold, or quarantine.
    if (dead.length === 0) {
      deps.log(
        `session-owl: rewind check — divergence at ${p ?? "unknown"} adjudicated ZERO dead rows (view shape, not a rewind); no re-fold`,
      );
      deps.tripwires?.markCheckedClean(deps.key);
      cleanWatermark.set(deps.key, deps.knownTip());
      deps.appendCheck(p ?? deps.knownTip() ?? "seed");
      clearOneShot?.();
      return { kind: "clean", via: "file" };
    }
    await deps.abortAndAwaitInFlight();
    const { quarantined } = await deps.refold(liveSet, liveList, new Set(dead));
    deps.onDivergence?.(p, dead);
    const markerNote = pass !== null && pass.kind === "ok" && pass.rewound ? ", marker rewound:true" : "";
    deps.log(
      `session-owl: rewind detected — conversation ${deps.key} re-anchored at ${p ?? "unknown"} ` +
        `(${dead.length} dead rows, ${quarantined} records quarantined, verified ${verified}${markerNote}` +
        `${tailConfirmed ? "" : ", rows-form contradicted"})`,
    );
    // divergence-verify is a persist point: the fresh CHECK rides the junction
    deps.appendCheck(p ?? deps.knownTip() ?? "seed");
    deps.tripwires?.markCheckedClean(deps.key);
    cleanWatermark.set(deps.key, p);
    return {
      kind: "divergence",
      P: p,
      provisional,
      deadRows: verdict.evidence.knownAbsent,
      quarantined,
      verified,
      tailConfirmed,
    };
  }

  // the api form is unavailable — the tripwire tier decides the degrade
  if (deps.tripwires !== undefined) {
    const t = deps.tripwires.evaluate(deps.key);
    if (!t.suspected) {
      const tip = deps.knownTip();
      cleanWatermark.set(deps.key, tip);
      if (opts.persist && tip !== null) deps.appendCheck(tip);
      if (opts.persist) await recordCleanProvenance(deps, tip);
      return { kind: "clean", via: "tripwire" };
    }
    const reason = "api form unavailable, truncation tripwire suspected";
    deps.log(`session-owl: rewind check skipped — ${reason} (${deps.key})`);
    return { kind: "skipped", reason };
  }
  const reason = "api form unavailable, no tripwires";
  deps.log(`session-owl: rewind check skipped — ${reason} (${deps.key})`);
  return { kind: "skipped", reason };
}

/** The in-memory clean watermark (the recall-entry boundary) — test seam. */
export function _cleanWatermark(key: string): string | null {
  return cleanWatermark.get(key) ?? null;
}

/** Release every watermark (session end — the maps never leak across
 *  sessions). */
export function clearWatermarks(): void {
  cleanWatermark.clear();
}

/** Re-anchor a false text junction on the file's live chain: the deepest
 *  known-path row found walking the tip's parentUuid chain to the root. */
function deepestKnownOnFileChain(
  rows: ReadonlyArray<{ uuid: string; parentUuid: string | null }>,
  tip: string | null,
  known: readonly KnownRow[],
): string | null {
  if (tip === null) return null;
  const byUuid = new Map(rows.map((r) => [r.uuid, r]));
  const knownSet = new Set(known.map((r) => r.uuid));
  let cursor: string | null = tip;
  while (cursor !== null) {
    if (knownSet.has(cursor)) return cursor;
    cursor = byUuid.get(cursor)?.parentUuid ?? null;
  }
  return null;
}
