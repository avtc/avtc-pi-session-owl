// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The canonical-view check — layer 2 of the rewind detection. The api form
// (`messages({as:"api"})` — the messages the next request is built from, on
// every surface) is aligned against the mirror on tool_use_id fingerprints
// with a text fallback. Last-flushed rows absent from the api form ⇒ the
// conversation was truncated (a rewind, or an orphaned fork). The rewind
// point `P*` = the deepest previously-known live-path row still present —
// the alignment junction. Because the check runs BEFORE the turn's mirror
// flush, post-rewind rows are not yet mirrored and the junction is the
// rewind point; junction regions matched only on text stay PROVISIONAL
// until the verifier pass confirms. The junction always sits at the
// window's tail (the window ends at the live tip), so deep rewinds beyond
// the 4,096-message window are fully detectable — the window never locates
// anything older; the lineage ledger owns the prefix.

/** A fingerprint: the tool ids a row emits/answers + a normalized text
 *  signature (the fallback). Rows with no tool ids and empty text carry no
 *  discriminating signal and match nothing. */
export interface Fingerprint {
  toolUseIds: string[];
  toolResultIds: string[];
  textSig: string;
}

const TEXT_CAP = 200;

/** Normalize a text block: cap FIRST (a 224 KB tool block never pays the
 *  full-string pass), then collapse whitespace, lowercase. */
export function fingerprintText(text: string): string {
  return text.slice(0, TEXT_CAP).trim().replace(/\s+/g, " ").toLowerCase();
}

/** Extract a fingerprint from content blocks (the api-message / mirrored-row
 *  content shape). Non-array content yields an empty fingerprint. */
export function fingerprintBlocks(content: unknown): Fingerprint {
  const toolUseIds: string[] = [];
  const toolResultIds: string[] = [];
  const texts: string[] = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b === null || typeof b !== "object") continue;
      const block = b as Record<string, unknown>;
      if (block.type === "tool_use" && typeof block.id === "string") toolUseIds.push(block.id);
      else if (block.type === "tool_result" && typeof block.tool_use_id === "string")
        toolResultIds.push(block.tool_use_id);
      else if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
        texts.push(fingerprintText(block.text));
      }
    }
  }
  return { toolUseIds, toolResultIds, textSig: texts.join(" | ").slice(0, TEXT_CAP) };
}

/** One known-path row to align (uuid + its fingerprint). */
export interface KnownRow {
  uuid: string;
  f: Fingerprint;
  /** The row's arrival time (mirror row timestamp, ms) — the fallback
   *  exemption axis when the boundary uuid never reached the mirror. */
  ts?: number;
}

/** The verdict: clean, or a divergence at P* with evidence. */
export type CanonicalVerdict =
  | { kind: "clean" }
  | {
      kind: "divergence";
      /** The alignment junction — the deepest known live-path row still
       *  present; null when nothing known survives. */
      P: string | null;
      provisional: boolean;
      evidence: {
        /** How the junction matched. */
        junctionMatch: "tool-id" | "text" | null;
        /** Known rows absent from the api form (the dead-tail candidate). */
        knownAbsent: number;
        /** The same rows BY UUID — the api layer nominates, the file layer
         *  adjudicates. */
        deadUuids: string[];
        /** True when every absent known row sits strictly AFTER the
         *  junction (a trailing view — the api form at a turn boundary);
         *  an interior absence before the junction is a rewound-away branch. */
        absentAfterJunction: boolean;
      };
    };

function intersects(a: readonly string[], b: readonly string[]): boolean {
  const setB = new Set(b);
  return a.some((x) => setB.has(x));
}

/** Direction-aware presence: a known row is present in the api form when its
 *  tool_use ids meet the entry's tool_use ids (the assistant side), its
 *  tool_result ids meet the entry's tool_result ids (the user side), or both
 *  sides are id-less with equal non-empty text. (A result row never matches
 *  the use entry of the same call — direction is the pairing.) */
function matches(known: Fingerprint, api: Fingerprint): boolean {
  if (intersects(known.toolUseIds, api.toolUseIds)) return true;
  if (intersects(known.toolResultIds, api.toolResultIds)) return true;
  return (
    known.toolUseIds.length === 0 &&
    known.toolResultIds.length === 0 &&
    api.toolUseIds.length === 0 &&
    api.toolResultIds.length === 0 &&
    known.textSig !== "" &&
    known.textSig === api.textSig
  );
}

/** True when the match rests on a tool id (the confident form). */
function matchedOnToolId(known: Fingerprint, api: Fingerprint): boolean {
  return intersects(known.toolUseIds, api.toolUseIds) || intersects(known.toolResultIds, api.toolResultIds);
}

/** Align the previously-known live path (tip LAST) against the api-form
 *  entries (live order) with a monotonic two-pointer + mutual lookahead.
 *  Rows carrying no discriminating signal (no tool ids, no text — image-only
 *  prompts, string content) are UNGRADEABLE and exempt: they can neither
 *  anchor a match nor count as dead. Rows at or before `exemptUpTo` (the
 *  newest observed compaction boundary) are prefix-exempt. Unmatched rows
 *  are then classified by POSITION: everything below the lowest matched row
 *  (tool-id matches preferred as the anchor) is window/summary absence —
 *  the api form windows at 4,096 entries and a compaction replaces the
 *  older prefix with a summary, neither a rewind signal — while everything
 *  above it is dead (a rewind removes tail rows, never root-side ones):
 *  matched pairs advance both sides; an api entry that matches a LATER known
 *  row skips the known rows in between (dead); a known row that matches a
 *  LATER api entry lets the api advance (new content); a mutual miss marks
 *  the known row dead and moves on. The plain extension (api adds rows past
 *  the tip) and the plain rewind (known tail dead, junction = deepest
 *  survivor) both fall out, and an orphaned fork (the engine attaching a
 *  prompt to an error branch) reports the dead rows on both sides of its
 *  live junction. */
export function alignCanonical(
  known: readonly KnownRow[],
  api: readonly Fingerprint[],
  opts: { exemptUpTo?: string; exemptUpToAt?: number } = {},
): CanonicalVerdict {
  if (known.length === 0) return { kind: "clean" };
  const exemptIdx = opts.exemptUpTo !== undefined ? known.findIndex((r) => r.uuid === opts.exemptUpTo) : -1;
  // The inert-anchor fallback: a persisted boundary uuid that never reached
  // the mirror (an un-mirrored compaction cut) must not silently exempt
  // nothing — fall back to the boundary's arrival position: rows that
  // arrived at-or-before it are prefix material, rows after stay judged.
  const exemptByAt = exemptIdx < 0 && typeof opts.exemptUpToAt === "number";
  const judgeable: number[] = [];
  for (let i = 0; i < known.length; i += 1) {
    const f = known[i].f;
    if (f.toolUseIds.length === 0 && f.toolResultIds.length === 0 && f.textSig === "") continue; // unjudgeable
    if (exemptIdx >= 0 && i <= exemptIdx) continue;
    if (exemptByAt && typeof known[i].ts === "number") {
      const upTo = opts.exemptUpToAt;
      const rowTs = known[i].ts;
      if (typeof upTo === "number" && rowTs !== undefined && rowTs <= upTo) continue;
    }
    judgeable.push(i);
  }
  if (judgeable.length === 0) return { kind: "clean" };
  const matched = new Array<boolean>(known.length).fill(false);
  for (const i of judgeable) matched[i] = false;
  const matchKind = new Array<"tool-id" | "text" | null>(known.length).fill(null);
  let junctionMatch: "tool-id" | "text" | null = null;
  let deepestMatched = -1;
  // lookahead cost guards: the no-match path is O(n*m) without them —
  // tens of seconds at the stress anchor; each row's first api scan runs
  // once, and a static key-set precheck answers the no-match case in O(1)
  const knownFirstApi = new Map<number, number>();
  const cachedApiMatchFrom = (start: number, kf: Fingerprint): number => {
    for (let i = start; i < api.length; i += 1) {
      if (matches(kf, api[i])) return i;
    }
    return -1;
  };
  const knownLaterApiOf = (k: number, from: number): number => {
    const first = knownFirstApi.get(k) ?? -2;
    if (first === -2) {
      // first scan for this row: -1 (the blow-up case) caches exactly
      const f = cachedApiMatchFrom(0, known[k].f);
      knownFirstApi.set(k, f);
      if (f === -1) return -1;
      return f >= from ? f : cachedApiMatchFrom(from, known[k].f);
    }
    if (first === -1) return -1;
    return first >= from ? first : cachedApiMatchFrom(from, known[k].f);
  };
  // static precheck (built once): every judgeable known fingerprint key —
  // an api entry intersecting none of them can match nothing, O(1), which
  // is what ends the quadratic no-match walk; entries that DO intersect
  // pay the exact scan (rare, bounded by real match counts)
  const knownKeys = new Set<string>();
  for (const i of judgeable) {
    const f = known[i].f;
    for (const id of f.toolUseIds) knownKeys.add(`u:${id}`);
    for (const id of f.toolResultIds) knownKeys.add(`r:${id}`);
    if (f.textSig !== "") knownKeys.add(`t:${f.textSig}`);
  }
  const apiIntersectsKnown = (fp2: Fingerprint): boolean => {
    if (fp2.toolUseIds.some((id) => knownKeys.has(`u:${id}`))) return true;
    if (fp2.toolResultIds.some((id) => knownKeys.has(`r:${id}`))) return true;
    return fp2.textSig !== "" && knownKeys.has(`t:${fp2.textSig}`);
  };
  // candidate lists per api entry: ONE full scan per distinct fingerprint
  // (a retyped prompt shared across a long dead tail would otherwise pay
  // the Θ(n) scan per walk step); the lookup then walks the short list
  const candidatesByEntry = new Map<number, number[]>();
  const apiLaterKnownOf = (a: number): number => {
    let candidates = candidatesByEntry.get(a);
    if (candidates === undefined) {
      if (!apiIntersectsKnown(api[a])) {
        candidates = [];
      } else {
        const list: number[] = [];
        for (const i of judgeable) {
          if (matches(known[i].f, api[a])) list.push(i);
        }
        candidates = list;
      }
      candidatesByEntry.set(a, candidates);
    }
    for (const i of candidates) {
      if (i >= judgeable[jp] && !matched[i]) return i;
    }
    return -1;
  };
  let jp = 0; // index into judgeable
  let a = 0;
  while (a < api.length && jp !== -1 && jp < judgeable.length) {
    const k = judgeable[jp];
    if (matches(known[k].f, api[a])) {
      matched[k] = true;
      matchKind[k] = matchedOnToolId(known[k].f, api[a]) ? "tool-id" : "text";
      deepestMatched = k;
      junctionMatch = matchKind[k];
      jp += 1;
      a += 1;
      continue;
    }
    const apiLaterKnown = apiLaterKnownOf(a);
    const knownLaterApi = knownLaterApiOf(k, a + 1);
    if (knownLaterApi !== -1 && (apiLaterKnown === -1 || knownLaterApi <= apiLaterKnown)) {
      a += 1; // the known row matches a later api entry — new content first
      continue;
    }
    if (apiLaterKnown !== -1) {
      // the api entry is a later judgeable known row — the ones skipped are dead
      while (jp < judgeable.length && judgeable[jp] !== apiLaterKnown) {
        jp += 1;
      }
      continue;
    }
    jp += 1; // the known row is gone from the canonical view — dead
  }
  // trailing api entries are new content (post-junction). Unmatched known
  // rows are classified by POSITION: a contiguous root-side prefix below
  // the lowest matched row is window/summary absence (the api form windows
  // at 4,096 entries and a compaction replaces the older prefix with a
  // summary — by design not a rewind signal; the ledger owns the prefix).
  // Everything unmatched ABOVE the lowest match (or with no match at all)
  // is dead: a rewind removes tail rows, never root-side ones.
  const unmatched = judgeable.filter((i) => !matched[i]);
  // the prefix anchor trusts TOOL-ID matches first (an old text collide — a
  // repeated short prompt — must not flip windowed rows into dead); a
  // text-only region (a windowed pure-chat prefix) falls back to its own
  // lowest match
  const lowestMatched =
    judgeable.find((i) => matched[i] && matchKind[i] === "tool-id") ?? judgeable.find((i) => matched[i]) ?? -1;
  const deadRows = lowestMatched === -1 ? unmatched : unmatched.filter((i) => i > lowestMatched);
  if (deadRows.length === 0) return { kind: "clean" };
  const junction = deepestMatched >= 0 ? known[deepestMatched].uuid : null;
  // tail-only absence: every unmatched row sits strictly AFTER the junction
  // (a view trailing live rows — the api form at a turn boundary); an
  // interior gap before the junction is a rewound-away branch, never lag
  const absentAfterJunction = deepestMatched >= 0 && unmatched.every((i) => i > deepestMatched);
  return {
    kind: "divergence",
    P: junction,
    provisional: deepestMatched >= 0 && junctionMatch !== "tool-id",
    evidence: {
      junctionMatch: deepestMatched >= 0 ? junctionMatch : null,
      knownAbsent: deadRows.length,
      deadUuids: deadRows.map((i) => known[i].uuid),
      absentAfterJunction,
    },
  };
}

/** The rows-form double check: the known tip absent from `messages()`'s
 *  row uuids confirms truncation (a present tip means no rewind). */
export function absentTailConfirm(apiRowUuids: readonly string[], knownTip: string | null): boolean {
  if (knownTip === null) return false;
  return !apiRowUuids.includes(knownTip);
}
