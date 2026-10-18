// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Log consumer tests: the translating backend installs at module load (before
// the vendored core's log.ts can evaluate), maps the sentinel prefix onto the
// real root at call time, and drops writes before init (best-effort). Red
// first — the module does not exist.

import { createLogger, getDefaultBackend } from "avtc-claude-logger";
import { describe, expect, test } from "vitest";
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
    initLogConsumer({ configDir: "/cfg", fs });
    const logger = createLogger("ring-probe", { baseDir: testBackend().baseDir, backend: testBackend().adapter });
    logger.error("hello ring", null);
    await new Promise((r) => setTimeout(r, 50));
    const paths = [...files.keys()];
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p.startsWith("/cfg/logs/ring-probe")).toBe(true);
      expect(p.includes("test-logs")).toBe(false);
    }
    expect(files.get(paths[0] as string)).toContain("hello ring");
  });

  test("the vendored core's logger name is preserved (avtc-pi-session-owl ring)", async () => {
    _resetLogConsumerForTest();
    const { files, fs } = memFiles();
    initLogConsumer({ configDir: "/cfg2", fs });
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
