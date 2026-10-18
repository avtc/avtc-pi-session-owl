// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared fs doubles for the storage suites: a write that fails N times, and
// a write that parks once until the test releases it (deterministic
// mid-flush interleaving — no timing races).
import type { FsAdapter } from "../../host/storage/fs-adapter.js";

export function makeFlakyWrite(fs: FsAdapter, failures: number): FsAdapter {
  let left = failures;
  return {
    readText: fs.readText,
    listDir: fs.listDir,
    stat: fs.stat,
    writeText: async (path: string, text: string) => {
      if (left > 0) {
        left -= 1;
        throw new Error("disk full");
      }
      return fs.writeText(path, text);
    },
  };
}

export function makeParkedWrite(fs: FsAdapter): { fs: FsAdapter; release: () => void } {
  let releaseFn: (() => void) | null = null;
  let parked = false;
  const parkedFs: FsAdapter = {
    readText: fs.readText,
    listDir: fs.listDir,
    stat: fs.stat,
    writeText: (path: string, text: string) => {
      if (parked) return fs.writeText(path, text); // later writes pass through
      parked = true;
      return new Promise<void>((resolve) => {
        releaseFn = () => resolve(fs.writeText(path, text).then(() => undefined));
      });
    },
  };
  return {
    fs: parkedFs,
    release: () => {
      const fn = releaseFn as unknown as (() => void) | null;
      fn?.();
    },
  };
}
