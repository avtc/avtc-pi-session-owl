// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { describe, expect, test, vi } from "vitest";
import { log } from "../../core/src/log.js";
import { installUnhandledRejectionLogging } from "../../host/log/unhandled.js";

describe("installUnhandledRejectionLogging (the process-level net)", () => {
  test("installs on a real process object and routes a synthetic rejection into the file log with its stack", async () => {
    const warned: string[] = [];
    const warnSpy = vi.spyOn(log, "warn").mockImplementation((t: string) => warned.push(t));
    const handlers: Array<(reason: unknown) => void> = [];
    const realProcess = process;
    const savedGlobal = (globalThis as { process?: unknown }).process;
    (globalThis as { process?: unknown }).process = {
      on: (_name: string, fn: (reason: unknown) => void) => {
        handlers.push(fn);
        return realProcess;
      },
    };
    try {
      installUnhandledRejectionLogging();
      expect(handlers.length).toBe(1);
      const boom = new Error("net caught the slip");
      handlers[0](boom);
      expect(warned.length).toBe(1);
      expect(warned[0].startsWith("unhandled rejection (process net): ")).toBe(true);
      expect(warned[0]).toContain("net caught the slip");
      expect(warned[0]).toContain("at "); // the stack survived into the log
    } finally {
      (globalThis as { process?: unknown }).process = savedGlobal;
      warnSpy.mockRestore();
    }
  });

  test("a sandbox WITHOUT a process.on is a no-op (never throws at module load)", () => {
    const savedGlobal = (globalThis as { process?: unknown }).process;
    (globalThis as { process?: unknown }).process = { no_on_here: true };
    try {
      expect(() => installUnhandledRejectionLogging()).not.toThrow();
    } finally {
      (globalThis as { process?: unknown }).process = savedGlobal;
    }
  });

  test("a missing process global entirely is a no-op (never throws at module load)", () => {
    const savedGlobal = (globalThis as { process?: unknown }).process;
    delete (globalThis as { process?: unknown }).process;
    try {
      expect(() => installUnhandledRejectionLogging()).not.toThrow();
    } finally {
      (globalThis as { process?: unknown }).process = savedGlobal;
    }
  });
});
