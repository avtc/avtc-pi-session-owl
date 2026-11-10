// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Log consumer tests: the translating backend installs at module load (before
// the vendored core's log.ts can evaluate), maps the sentinel prefix onto the
// real root at call time, and drops writes before init (best-effort). Red
// first — the module does not exist.

import { createLogger, getDefaultBackend } from "avtc-claude-logger";
import { describe, expect, test, vi } from "vitest";
import { _resetLogConsumerForTest, initLogConsumer, logConsumerReady, testBackend } from "../../host/log/consumer.js";

function memFiles() {
  const files = new Map<string, string>();
  const fs = {
    read: async (p: string) => {
      const t = files.get(p);
      if (t === undefined) throw new Error(`ENOENT: ${p}`);
      return t;
    },
    write: async (p: string, c: string) => void files.set(p, c),
    list: async (dir: string) => {
      const out: Array<{ name: string; kind: string; size: number; mtimeMs: number }> = [];
      for (const key of files.keys()) {
        const slash = key.lastIndexOf("/");
        if (key.slice(0, slash) === dir) {
          out.push({ name: key.slice(slash + 1), kind: "file", size: files.get(key)?.length ?? 0, mtimeMs: 1 });
        }
      }
      return out;
    },
  };
  return { files, fs };
}

describe("the translating backend", () => {
  test("installs at module load (a default backend exists immediately)", () => {
    expect(getDefaultBackend()).not.toBeNull();
  });

  test("before init: writes drop (no crash, no files anywhere)", async () => {
    _resetLogConsumerForTest();
    const { files } = memFiles();
    // A logger created over the default backend pre-init: best-effort drop.
    const logger = createLogger("pre-init-probe", { baseDir: testBackend().baseDir, backend: testBackend().adapter });
    logger.info("should drop");
    await new Promise((r) => setTimeout(r, 20));
    expect(logConsumerReady()).toBe(false);
    expect(files.size).toBe(0);
  });

  test("after init: files land under the real root, not the sentinel", async () => {
    _resetLogConsumerForTest();
    const { files, fs } = memFiles();
    initLogConsumer({ configDir: "/cfg", fs, schedule: null });
    const logger = createLogger("ring-probe", { baseDir: testBackend().baseDir, backend: testBackend().adapter });
    logger.error("hello ring", null);
    // the consumer flushes on a timer — wait for this logger's file instead
    // of racing a fixed sleep (a loaded event loop writes it late; and a
    // late flush from a prior test's logger must not fail this one's paths)
    const ringPaths = await vi.waitFor(() => {
      const ring = [...files.keys()].filter((p) => p.startsWith("/cfg/logs/ring-probe"));
      expect(ring.length).toBeGreaterThan(0);
      return ring;
    });
    for (const p of ringPaths) {
      expect(p.startsWith("/cfg/logs/ring-probe")).toBe(true);
      expect(p.includes("test-logs")).toBe(false);
    }
    expect(files.get(ringPaths[0] as string)).toContain("hello ring");
  });

  test("the vendored core's logger name is preserved (avtc-pi-session-owl ring)", async () => {
    _resetLogConsumerForTest();
    const { files, fs } = memFiles();
    initLogConsumer({ configDir: "/cfg2", fs, schedule: null });
    const logger = createLogger("avtc-pi-session-owl", {
      baseDir: testBackend().baseDir,
      backend: testBackend().adapter,
    });
    logger.warn("named probe");
    await new Promise((r) => setTimeout(r, 50));
    const paths = [...files.keys()];
    expect(paths.some((p) => p.startsWith("/cfg2/logs/avtc-pi-session-owl"))).toBe(true);
  });
});

describe("the window schedule and stat seams", () => {
  test("init forwards the timer authority — lines batch until the window's callback fires", async () => {
    _resetLogConsumerForTest();
    const { files, fs } = memFiles();
    // a holder array: the callback assigns it; TS can't narrow through a
    // closure back to the local
    const armed: Array<{ ms: number; fn: () => void }> = [];
    initLogConsumer({
      configDir: "/cfgW",
      fs,
      schedule: (ms, fn) => {
        armed.push({ ms, fn });
        return null;
      },
    });
    const logger = createLogger("win-probe", { baseDir: testBackend().baseDir, backend: testBackend().adapter });
    logger.info("coalesce");
    await new Promise((r) => setTimeout(r, 40));
    // inside the window: the line is queued, not written
    expect([...files.keys()].some((p) => p.startsWith("/cfgW/logs/win-probe"))).toBe(false);
    expect(armed).toHaveLength(1);
    expect(armed[0]?.ms).toBe(100); // the default agglomeration window
    armed[0]?.fn(); // the seam's "timer" lands
    const ring = await vi.waitFor(() => {
      const hits = [...files.keys()].filter((p) => p.startsWith("/cfgW/logs/win-probe"));
      expect(hits.length).toBeGreaterThan(0);
      return hits;
    });
    expect(files.get(ring[0] as string)).toContain("coalesce");
  });

  test("stat: passed through when the surface carries it; a missing stat surface rejects (retention off)", async () => {
    _resetLogConsumerForTest();
    const { fs } = memFiles();
    const withStat = {
      ...fs,
      stat: async (_p: string) => ({ mtimeMs: 42, size: 7 }),
    };
    initLogConsumer({ configDir: "/cfgS", fs: withStat, schedule: null });
    await expect(testBackend().adapter.stat?.("/probe")).resolves.toEqual({ mtimeMs: 42, size: 7 });
    // fresh consumer on a surface WITHOUT stat — the library turns retention
    // off the moment its authority throws; the adapter must reject, never lie
    _resetLogConsumerForTest();
    initLogConsumer({ configDir: "/cfgS2", fs, schedule: null });
    await expect(testBackend().adapter.stat?.("/probe")).rejects.toThrow();
  });
});
