// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The per-conversation storage assembly: one lazily-created {fs, dir, mirror,
// ledger} set per loop key, over the bridge's armed fs capsules. The capture
// pipeline (row cache hand-off, turn flush) and the later store-context both
// resolve their writers through this single seam, so a conversation's mirror
// and ledger instances are shared by every writer and reader in the process.
import { log } from "../../core/src/log.js";
import { currentServices } from "../engine-bridge.js";
import * as state from "../state.js";
import type { FsAdapter } from "./fs-adapter.js";
import { LedgerWriter } from "./ledger.js";
import { MirrorWriter } from "./mirror.js";

export interface SessionStorage {
  /** The conversation key (sessionId or sessionId|agentId). */
  key: string;
  /** The loop's session directory (the storage layout root). */
  dir: string;
  fs: FsAdapter;
  mirror: MirrorWriter;
  ledger: LedgerWriter;
  /** Process-unique producer id (batch naming + fold ordering). */
  producerId: string;
}

const instances = new Map<string, SessionStorage>();
let producerCounter = 0;

/** Per-process discriminator: the hooks environment carries no `process`
 *  global (the same sandbox that bans node builtins — mirrored by
 *  core-instances' Math.random base in place of node:crypto). One random
 *  base per module load keeps batch names unique ACROSS processes (the
 *  two-terminals RMW rule) without touching a Node global. */
const PROCESS_BASE = Math.random().toString(36).slice(2, 8);

/** Per-INSTANCE producer id: two storage sets never share batch names, so a
 *  released-then-recreated conversation can never overwrite its old batches
 *  (m<seq>-<producer8>.jsonl / ledger ids stay unique for the process). */
function nextProducerId(): string {
  producerCounter += 1;
  return `p${PROCESS_BASE}-${Date.now().toString(36)}-${producerCounter}`;
}

/** The storage fs over the bridge capsules (read at call time — capsules are
 *  re-armed at every hook entry; listDir maps missing to [] per contract). */
function bridgeFs(): FsAdapter {
  return {
    readText: async (path) => currentServices().fsRead(path),
    writeText: async (path, text) => currentServices().fsWrite(path, text),
    listDir: async (path) => {
      try {
        // the platform list returns FsEntry objects ({name, kind, ...}), not
        // strings — map to names (a bare string entry passes through)
        const entries = (await currentServices().fsList(path)) as Array<string | { name?: unknown }>;
        if (!Array.isArray(entries)) return [];
        return entries.map((entry) =>
          typeof entry === "string" ? entry : typeof entry.name === "string" ? entry.name : "",
        );
      } catch (err) {
        log.info(`fs listDir failed, treated as empty (${path}): ${errText(err)}`);
        return []; // missing directory = empty (the fold's fresh-session truth)
      }
    },
    stat: async (path) => {
      try {
        const st = (await currentServices().fsStat(path)) as { size?: number } | null;
        return st === null || st === undefined ? null : { size: st.size ?? 0 };
      } catch (err) {
        log.info(`fs stat failed, treated as missing (${path}): ${errText(err)}`);
        return null; // missing path = null stat
      }
    },
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Get-or-create the loop's storage set. Requires the config dir resolved
 *  (a session.start/classic.SessionStart must have armed and resolved it). */
export function getSessionStorage(key: string, sessionId: string, agentId: string | null): SessionStorage {
  let set = instances.get(key);
  if (set !== undefined) return set;
  const configDir = state.getCachedConfigDir();
  if (configDir === null) {
    throw new Error("session-owl: config dir not resolved before storage assembly");
  }
  const producer = nextProducerId();
  const dir = state.sessionDirPath(configDir, sessionId, agentId);
  set = {
    key,
    dir,
    fs: bridgeFs(),
    mirror: new MirrorWriter(bridgeFs(), dir, producer),
    ledger: new LedgerWriter(bridgeFs(), dir, producer),
    producerId: producer,
  };
  instances.set(key, set);
  return set;
}

/** Flush one assembly's still-buffered rows and records (best-effort,
 *  per-writer: one failing flush never blocks the rest). The durability
 *  seam BEFORE any release — a released writer's buffer is gone with it. */
export async function flushSessionStorage(key: string): Promise<void> {
  const set = instances.get(key);
  if (set === undefined) return;
  try {
    await set.mirror.flush();
  } catch (err) {
    log.warn(`mirror flush failed — buffered rows lost: ${errText(err)}`);
    // a failed flush is lost rows, never a failed teardown
  }
  try {
    await set.ledger.flush();
  } catch (err) {
    log.warn(`ledger flush failed — buffered records lost: ${errText(err)}`);
    // a failed flush is lost records, never a failed teardown
  }
}

/** Flush every live assembly (session.end teardown — BEFORE the release:
 *  still-buffered rows AND records are made durable instead of dropped;
 *  ms-scale, inside the session.end budget). Best-effort per assembly. */
export async function flushAllSessionStorage(): Promise<void> {
  for (const set of instances.keys()) {
    await flushSessionStorage(set);
  }
}

/** Drop one loop's storage set (in-memory teardown; files stay on disk). */
export function releaseSessionStorage(key: string): boolean {
  return instances.delete(key);
}

/** Drop every storage set (session.end teardown — pure in-memory). */
export function releaseAllSessionStorage(): void {
  instances.clear();
}

/** Test seam. */
export function _resetSessionStorage(): void {
  instances.clear();
  producerCounter = 0;
}
