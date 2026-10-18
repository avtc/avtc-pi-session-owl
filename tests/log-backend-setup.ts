// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

/**
 * The claude-logger backend for the test process — imported FIRST by
 * tests/setup.ts so the vendored core's log.ts (which constructs its logger
 * at module load over the avtc-claude-logger default backend) evaluates
 * against an installed, disk-free backend. Without this file ahead of it,
 * the vendored log.ts import throws ("no destination") under every project
 * that loads the rewritten core.
 *
 * The in-memory adapter never touches disk; the slot files live as map keys.
 */

import { setDefaultBackend } from "avtc-claude-logger";

const files = new Map<string, string>();

function splitPath(path: string): { dir: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { dir: "", name: path } : { dir: path.slice(0, slash), name: path.slice(slash + 1) };
}

setDefaultBackend({
  adapter: {
    async read(path) {
      const text = files.get(path);
      if (text === undefined) throw new Error(`ENOENT (test memory fs): ${path}`);
      return text;
    },
    async write(path, text) {
      files.set(path, text);
    },
    async list(dir) {
      const entries: Array<{ name: string; kind: string; size: number; mtimeMs: number }> = [];
      for (const key of files.keys()) {
        const { dir: fileDir, name } = splitPath(key);
        if (fileDir === dir) {
          entries.push({ name, kind: "file", size: files.get(key)?.length ?? 0, mtimeMs: 0 });
        }
      }
      return entries;
    },
  },
  baseDir: "/test-logs",
});

/** Test seam: the files the memory backend holds (assertions on the ring). */
export function _testLogFiles(): ReadonlyMap<string, string> {
  return files;
}
