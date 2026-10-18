// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The ONE seam where platform file IO enters storage code. Everything else
// in claude/host/storage/ consumes this narrow interface, injected:
//   - tests inject the in-memory adapter (createMemoryFs below);
//   - the runtime injects the $.fs-backed adapter — authored as a data-only
//     capsule INSIDE the hooks module (the engine scanner forbids `$`/nouns
//     crossing call boundaries, so the capsule's arrow functions spell the
//     literal $.fs.* calls where the scanner can see them).
//
// Guard constants (platform limits, validated live):
//   CAP         4 MiB — the platform's hard read/write reject threshold
//   ROLL_MARGIN 3 MiB — batches that would pass this split into more files
//   PART_SLICE  2.5 MiB — snapshot part slices (character boundaries)

export const CAP = 4 * 1024 * 1024;
export const ROLL_MARGIN = 3 * 1024 * 1024;
export const PART_SLICE = Math.floor(2.5 * 1024 * 1024);

export interface FsStat {
  size: number;
}

/** The narrow storage IO surface (mirrors the platform fs semantics:
 *  write replaces whole files and creates parent directories; read throws on
 *  a missing path; list names a directory's entries). CONTRACT: listDir of a
 *  MISSING directory returns [] (never rejects) — the fresh-session truth
 *  every fold depends on; the runtime capsule must map missing to empty. */
export interface FsAdapter {
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
  stat(path: string): Promise<FsStat | null>;
}

/** UTF-8 byte length (the platform's size unit — its caps are BYTES, and
 *  CJK/emoji content inflates 3-4x over UTF-16 code units). */
export function byteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1; // the surrogate pair counts as one code point
    } else bytes += 3;
  }
  return bytes;
}

/** Slice [start, end) with the cut snapped left off a surrogate pair. */
export function sliceRangeSafe(text: string, start: number, end: number): string {
  const stop = Math.max(start, Math.min(end, text.length));
  if (stop < text.length) {
    const code = text.charCodeAt(stop - 1);
    if (code >= 0xd800 && code <= 0xdbff) return text.slice(start, stop - 1);
  }
  return text.slice(start, stop);
}

/** Slice text into parts each within the byte budget (surrogate-safe — the
 *  one shared copy the mirror's oversized rows and the snapshot's part
 *  files both consume; CJK/emoji inflates 3-4x over code units, so the byte
 *  check proportionally shrinks a slice until it fits). */
export function sliceToByteParts(text: string, budget: number): string[] {
  const parts: string[] = [];
  for (let at = 0; at < text.length; ) {
    let slice = sliceRangeSafe(text, at, at + budget);
    while (slice.length > 1 && byteLength(slice) > budget) {
      slice = sliceRangeSafe(text, at, at + Math.floor((slice.length * budget) / byteLength(slice)));
    }
    parts.push(slice);
    at += slice.length;
    if (slice.length === 0) break;
  }
  return parts.length > 0 ? parts : [""];
}

/** In-memory FsAdapter for tests (and for any future surface that prefers a
 *  scratch tree). Faithful to the platform semantics that matter to storage:
 *  write replaces, parents auto-created, read throws ENOENT on missing. */
export function createMemoryFs() {
  const files = new Map<string, string>();
  const parentOf = (path: string) => {
    const bar = path.lastIndexOf("/");
    return bar <= 0 ? "" : path.slice(0, bar);
  };
  const ensureParents = (path: string) => {
    let dir = parentOf(path);
    while (dir !== "" && !dirs.has(dir)) {
      dirs.add(dir);
      dir = parentOf(dir);
    }
  };
  const dirs = new Set<string>();
  const adapter: FsAdapter = {
    readText: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    writeText: async (path, text) => {
      ensureParents(path);
      files.set(path, text);
    },
    listDir: async (path) => {
      const prefix = path === "" ? "" : `${path}/`;
      const names = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        if (rest.length === 0) continue;
        const bar = rest.indexOf("/");
        names.add(bar === -1 ? rest : rest.slice(0, bar));
      }
      if (names.size === 0 && !dirs.has(path) && !files.has(path)) {
        // a listing of a never-touched path yields empty (the platform lists
        // an existing empty dir; storage treats both the same)
        dirs.add(path);
      }
      return [...names].sort();
    },
    stat: async (path) => {
      const text = files.get(path);
      return text === undefined ? null : { size: byteLength(text) };
    },
  };
  return {
    adapter,
    files,
    /** Test helper: the text stored at a path (undefined when absent). */
    peek: (path: string) => files.get(path),
  };
}
