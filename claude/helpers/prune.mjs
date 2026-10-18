// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// The mirror-retention prune helper: the ONE true-delete path. Enumerates
// owl session directories and unlinks those past the retention window or
// whose transcript is gone — per-SESSION granularity, never per-chunk. Runs
// in a real Node process (real unlink), invoked at startup backfill on CLI
// surfaces via $.process.run.
//
// Usage:
//   node helpers/prune.mjs [--config-dir <dir>] [--days N | --follow-cleanup]
//        [--now <iso>] [--apply]
//
// Modes:
//   (none)          keep-forever (pi parity) — NO sweep runs at all; the
//                   report is {mode:"off"} with nothing enumerated
//   --days N        owl's mirrorRetentionDays: sessions older than N days
//                   (max file mtime in the dir — batches are written-new,
//                   so the newest file IS the session's last activity) are
//                   swept
//   --follow-cleanup follow-cleanupPeriodDays: the window is the HOST's
//                   own cleanupPeriodDays setting (read from
//                   <configDir>/settings.json, host default 30)
//
// In every opted-in mode the sweep-when-transcript-gone rule also runs: a
// session whose transcript no longer exists is swept regardless of age.
// The liveness ladder: the .session.json marker's transcriptPath first (a
// missing pointed-at path FALLS THROUGH to the scan — the cross-cwd ENOENT
// posture; the pointed-at dir may still hold live subagent transcripts),
// then the filename scan of <configDir>/projects/**/<sessionId>.jsonl.
// Agent-suffixed dirs (<sessionId>-<agentId>) are governed by their PARENT
// session id (the suffix is stripped; a live parent keeps every loop's
// memory, a dead one takes every loop with it).
//
// DRY-RUN by default: --apply performs the actual unlink (tests never touch
// real dirs without it). Report JSON goes to stdout — { mode, days,
// removed, sessions[], errors[] } (errors: per-dir unlink failures under
// --apply; one stubborn dir never aborts the sweep). Exit codes: 0 ok,
// 2 usage.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);
// a string flag whose value is another flag token (--config-dir --days 30)
// would silently scan a garbage root and report an empty sweep — reject it
const stringFlag = (name, def) => {
  const raw = flag(name, null);
  if (raw === null) return def;
  if (typeof raw !== "string" || raw === "undefined" || raw.startsWith("--")) {
    process.stderr.write(`${usage}--${name} needs a value that is not another flag\n`);
    process.exit(2);
  }
  return raw;
};

const usage =
  "usage: node helpers/prune.mjs [--config-dir <dir>] [--days N | --follow-cleanup] [--now <iso>] [--apply]\n";

const configDir =
  stringFlag("config-dir", null) ??
  process.env.CLAUDE_CONFIG_DIR ??
  join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".claude");

const daysRaw = flag("days", null);
let days = null;
if (daysRaw !== null) {
  days = Number(daysRaw);
  if (!Number.isFinite(days) || days <= 0) {
    process.stderr.write(`${usage}invalid --days: ${daysRaw}\n`);
    process.exit(2);
  }
}
const follow = has("follow-cleanup");
if (follow && days !== null) {
  process.stderr.write(`${usage}--days and --follow-cleanup are exclusive\n`);
  process.exit(2);
}
const nowRaw = stringFlag("now", null);
let nowMs = Date.now();
if (nowRaw !== null) {
  const t = Date.parse(nowRaw);
  if (Number.isNaN(t)) {
    process.stderr.write(`${usage}invalid --now: ${nowRaw}\n`);
    process.exit(2);
  }
  nowMs = t;
}
const apply = has("apply");

const DAY_MS = 86_400_000;

/** The host's cleanupPeriodDays (follow mode): <configDir>/settings.json.
 *  The host's default is 30; EXPLICIT 0 means the host keeps transcripts
 *  forever — follow mode then sweeps nothing (parity with the host). */
function hostCleanupDays() {
  try {
    const text = readTextOrNull(join(configDir, "settings.json"));
    if (text !== null) {
      const parsed = JSON.parse(text);
      const v = parsed?.cleanupPeriodDays;
      if (v === 0) return 0;
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    }
  } catch {
    // unreadable settings fall through to the host default
  }
  return 30;
}

function readTextOrNull(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A Claude session id is a uuid v4 — the dir-name grammar: an unsuffixed
 *  dir is exactly a uuid; an agent-suffixed dir is <uuid>-<anything>. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function splitSessionDir(name) {
  if (UUID_RE.test(name)) return { sessionId: name, agentOf: null };
  // an agent-suffixed dir is <uuid> + "-" + <sanitized agentId>: the uuid is
  // exactly 36 chars, so the prefix cut is exact (no hyphen-segment walking)
  if (name.length > 36) {
    const head = name.slice(0, 36);
    if (UUID_RE.test(head) && name[36] === "-") {
      return { sessionId: head, agentOf: head };
    }
  }
  return null; // not a session dir (foreign file/dir) — ignored
}

const MARKER = ".session.json";

/** The session's last-activity stamp: max mtime across the dir's files
 *  (per-SESSION granularity — batch files are written-new per flush, so the
 *  newest file is the last write; a dir mtime alone would miss in-place
 *  rewrites). */
function lastActivityMs(dir) {
  let newest = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      try {
        const st = statSync(join(dir, entry.name));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        // racing deletion — skip
      }
    }
  } catch {
    return 0;
  }
  return newest;
}

/** The marker's transcriptPath (authoritative) or null. */
function markerTranscript(dir) {
  const text = readTextOrNull(join(dir, MARKER));
  if (text === null) return null;
  try {
    const m = JSON.parse(text);
    return typeof m?.transcriptPath === "string" ? m.transcriptPath : null;
  } catch {
    return null;
  }
}

/** Index every <sessionId>.jsonl basename under projects/ (the filename
 *  scan fallback — the marker path is authoritative, this covers marker-less
 *  and agent dirs). */
function scanProjectTranscripts() {
  const found = new Set();
  const root = join(configDir, "projects");
  const walk = (dir, depth) => {
    if (depth > 4) return; // projects/<encoded-cwd>/<sessionId>/[subagents]/file
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith(".jsonl")) found.add(e.name);
    }
  };
  walk(root, 0);
  return found;
}

/** Liveness of a session: its transcript still exists on disk. The marker
 *  path resolving = live; a MISSING pointed-at path is a HINT gone stale
 *  (the cross-cwd resume ENOENT) — fall through to the scan, and consult
 *  the pointed-at dir for live subagent transcripts (the host prunes
 *  depth-1 main files but keeps subagents). */
function transcriptExists(sessionId, markerPath, scanned) {
  if (markerPath !== null) {
    if (existsSync(markerPath)) return true;
    if (subagentsLive(markerPath, sessionId)) return true;
  }
  return scanned.has(`${sessionId}.jsonl`); // fallback: the filename scan
}

/** Any transcript still lives in the SESSION's subagents dir (the captured
 *  layout: projects/<proj>/<sessionId>/subagents/agent-<hash>.jsonl — the
 *  host prunes depth-1 main files only, subagent transcripts outlive them,
 *  and a live parent keeps every loop's memory). */
function subagentsLive(transcriptPath, sessionId) {
  const cut = Math.max(transcriptPath.lastIndexOf("/"), transcriptPath.lastIndexOf("\\"));
  if (cut <= 0) return false;
  try {
    return readdirSync(join(transcriptPath.slice(0, cut), sessionId, "subagents")).some((n) => n.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

// ---- the sweep ----------------------------------------------------------------------

const sessionsRoot = join(configDir, "session-owl", "sessions");
const report = { mode: "off", days: null, removed: 0, sessions: [], errors: [] };

if (days !== null || follow) {
  report.mode = follow ? "follow" : "days";
  report.days = follow ? hostCleanupDays() : days;
  if (report.days === 0) {
    // the host keeps forever (explicit cleanupPeriodDays 0) — follow mode
    // sweeps nothing; same posture as the keep-forever default
    process.stdout.write(`${JSON.stringify(report)}
`);
    process.exit(0);
  }

  let dirNames = [];
  try {
    dirNames = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    dirNames = []; // no sessions root — a clean no-op
  }

  const scanned = scanProjectTranscripts();
  // parent liveness cache (agent dirs share it): id -> boolean
  const parentLive = new Map();

  const isParentLive = (parentId) => {
    if (parentLive.has(parentId)) return parentLive.get(parentId);
    // the parent's OWN dir marker first (it enumerates anyway), then the scan
    const parentDir = join(sessionsRoot, parentId);
    const marker = existsSync(parentDir) ? markerTranscript(parentDir) : null;
    const live = transcriptExists(parentId, marker, scanned);
    parentLive.set(parentId, live);
    return live;
  };

  for (const name of dirNames) {
    const parsed = splitSessionDir(name);
    if (parsed === null) continue;
    const dir = join(sessionsRoot, name);
    const ageDays = (nowMs - lastActivityMs(dir)) / DAY_MS;
    let verdict = "keep";

    if (parsed.agentOf !== null) {
      // agent-suffixed: the PARENT governs — a live parent keeps every
      // loop's memory (age cannot sweep it); a dead parent takes it now
      verdict = isParentLive(parsed.agentOf) ? "keep" : "transcript-gone";
    } else {
      const marker = markerTranscript(dir);
      if (!transcriptExists(parsed.sessionId, marker, scanned)) {
        verdict = "transcript-gone";
      } else if (ageDays > report.days) {
        verdict = "expired";
      }
    }

    report.sessions.push({
      dir: name,
      sessionId: parsed.agentOf ?? parsed.sessionId,
      agentOf: parsed.agentOf,
      ageDays: Math.round(ageDays * 10) / 10,
      verdict,
    });
  }

  if (apply) {
    for (const s of report.sessions) {
      if (s.verdict === "keep") continue;
      try {
        rmSync(join(sessionsRoot, s.dir), { recursive: true, force: true });
        report.removed += 1;
      } catch (err) {
        // one stubborn dir never aborts the sweep — recorded, the rest proceed
        report.errors.push({ dir: s.dir, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
}

process.stdout.write(`${JSON.stringify(report)}\n`);
