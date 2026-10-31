// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _setBaseLoggerForTest } from "../../src/log.js";
import {
  _setChainRepairStampForTest,
  CHAIN_DETECT_TITLE,
  CHAIN_FAILED_TITLE,
  CHAIN_REPAIRED_TITLE,
  CLOSE_PI_BUTTON,
  chainDetectMessage,
  chainFailedMessage,
  chainRepairedMessage,
  findChainOrphans,
  repairSessionChainFile,
  runChainRepairFlow,
} from "../../src/store/chain-repair.js";
import { tempDir } from "../temp-dir.js";

// --- fixtures ---------------------------------------------------------------

interface FixtureEntry {
  type: string;
  id: string;
  parentId: string | null;
}

function fixtureLines(entries: FixtureEntry[]): string[] {
  const lines = entries.map((e) => JSON.stringify(e));
  lines.unshift(JSON.stringify({ type: "session", id: "sess-0001", version: 3 }));
  return lines;
}

/** A session file with a healthy run, then an orphan (ghost parent), then more. */
function gappedSession(): FixtureEntry[] {
  return [
    { type: "model_change", id: "aaaa0001", parentId: null },
    { type: "message", id: "aaaa0002", parentId: "aaaa0001" },
    // first gap: ghost01 never made it to the file
    { type: "message", id: "aaaa0004", parentId: "ghost001" },
    { type: "message", id: "aaaa0005", parentId: "aaaa0004" },
    // second gap: ghost02 lost as well
    { type: "message", id: "aaaa0007", parentId: "ghost002" },
    { type: "message", id: "aaaa0008", parentId: "aaaa0007" },
  ];
}

function writeSession(entries: FixtureEntry[], dir: string): string {
  const file = join(dir, "session.jsonl");
  writeFileSync(file, `${fixtureLines(entries).join("\n")}\n`);
  return file;
}

function readParentIds(file: string): Array<string | null> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith('{"type":"session"'))
    .map((l) => JSON.parse(l).parentId as string | null);
}

// --- tests ------------------------------------------------------------------

describe("findChainOrphans", () => {
  it("returns nothing for an empty session", () => {
    expect(findChainOrphans([{ type: "session", id: "sess-0001", parentId: null }])).toEqual([]);
  });

  it("returns nothing for a healthy chain", () => {
    expect(findChainOrphans(gappedSession().slice(0, 2))).toEqual([]);
  });

  it("finds every orphan, including several in one file", () => {
    const orphans = findChainOrphans(gappedSession());
    expect(orphans).toEqual([
      { entryId: "aaaa0004", brokenParentId: "ghost001" },
      { entryId: "aaaa0007", brokenParentId: "ghost002" },
    ]);
  });

  it("treats a parent pointing at the session header as an orphan", () => {
    const orphans = findChainOrphans([{ type: "message", id: "aaaa0002", parentId: "sess-0001" }]);
    expect(orphans).toEqual([{ entryId: "aaaa0002", brokenParentId: "sess-0001" }]);
  });

  it("ignores entries without an id", () => {
    expect(findChainOrphans([{ type: "message", id: "", parentId: "ghost001" }])).toEqual([]);
  });
});

describe("repairSessionChainFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir("owl-chain-repair");
    _setChainRepairStampForTest("20261031-120000");
  });

  afterEach(() => {
    _setChainRepairStampForTest(null);
    _setBaseLoggerForTest(null);
  });

  it("stitches every orphan to the previous file-order entry, byte-length preserved", () => {
    const file = writeSession(gappedSession(), dir);
    const sizeBefore = readFileSync(file).length;
    const result = repairSessionChainFile(file);
    expect(result).toMatchObject({ ok: true, stitched: 2, alreadyClean: false });
    expect(readParentIds(file)).toEqual([
      null,
      "aaaa0001",
      "aaaa0002", // aaaa0004 re-parented onto the previous entry
      "aaaa0004",
      "aaaa0005", // aaaa0007 re-parented onto the previous entry
      "aaaa0007",
    ]);
    expect(readFileSync(file).length).toBe(sizeBefore);
  });

  it("writes a backup next to the file and prunes older ones (keeps the newest)", () => {
    const file = writeSession(gappedSession(), dir);
    const oldBackup = `${file}.owlbak-20260101-000000`;
    writeFileSync(oldBackup, "old");
    const backup = `${file}.owlbak-20261031-120000`;
    repairSessionChainFile(file);
    expect(existsSync(backup)).toBe(true);
    expect(existsSync(oldBackup)).toBe(false);
  });

  it("keeps the backup verbatim (the pre-repair file, ghosts included)", () => {
    const file = writeSession(gappedSession(), dir);
    repairSessionChainFile(file);
    const backup = `${file}.owlbak-20261031-120000`;
    expect(readParentIds(backup)[2]).toBe("ghost001");
  });

  it("reports alreadyClean when a concurrent process already repaired the file", () => {
    const file = writeSession(gappedSession(), dir);
    repairSessionChainFile(file);
    const again = repairSessionChainFile(file);
    expect(again).toMatchObject({ ok: true, stitched: 0, alreadyClean: true });
  });

  it("fails without touching the file when a parent id length mismatches", () => {
    const entries: FixtureEntry[] = [
      { type: "message", id: "aaaa0001", parentId: null },
      { type: "message", id: "aaaa0002", parentId: "shortgHOST" }, // 10 chars vs 8
      { type: "message", id: "aaaa0003", parentId: "aaaa0002" },
    ];
    const file = writeSession(entries, dir);
    const before = readFileSync(file, "utf8");
    const result = repairSessionChainFile(file);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("length mismatch");
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("fails when the backup cannot be written (disk full analog)", () => {
    const file = writeSession(gappedSession(), dir);
    const backup = `${file}.owlbak-20261031-120000`;
    mkdirSync(backup); // a directory where the backup file should land
    const result = repairSessionChainFile(file);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("backup failed");
  });

  it("fails on a missing session file", () => {
    const result = repairSessionChainFile(join(dir, "absent.jsonl"));
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe("runChainRepairFlow", () => {
  let dir: string;
  let sink: ReturnType<typeof makeSink>;

  beforeEach(() => {
    dir = tempDir("owl-chain-flow");
    _setChainRepairStampForTest("20261031-120000");
    sink = makeSink();
    _setBaseLoggerForTest(sink);
  });

  afterEach(() => {
    _setChainRepairStampForTest(null);
    _setBaseLoggerForTest(null);
  });

  function makeSink() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }

  interface FlowDeps {
    hasUI: boolean;
    confirmResult?: boolean;
    selectDismissed?: boolean;
    file?: string | undefined;
  }

  function makeFlowCtx(
    entries: FixtureEntry[],
    deps: FlowDeps,
  ): {
    ctx: ExtensionContext;
    shutdown: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
  } {
    const shutdown = vi.fn();
    const confirm = vi.fn(async () => deps.confirmResult ?? true);
    const select = vi.fn(async () => (deps.selectDismissed ? undefined : CLOSE_PI_BUTTON));
    const notify = vi.fn();
    const ctx = {
      hasUI: deps.hasUI,
      ui: { confirm, select, notify },
      shutdown,
      sessionManager: {
        getSessionId: () => "01a02596-de2e-707b-8016-1df74d3f13ce",
        getEntries: () => [
          ...fixtureLines(entries)
            .slice(1)
            .map((l) => JSON.parse(l)),
        ],
        getSessionFile: () => deps.file,
      },
    } as unknown as ExtensionContext;
    return { ctx, shutdown, confirm, select, notify };
  }

  it("is a no-op without orphans (no dialogs, no file io)", async () => {
    const entries = gappedSession().slice(0, 2);
    const { ctx, confirm, select } = makeFlowCtx(entries, { hasUI: true });
    const outcome = await runChainRepairFlow(ctx);
    expect(outcome).toBe("no-issue");
    expect(confirm).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(sink.error).not.toHaveBeenCalled();
  });

  it("asks for consent first and repairs on Yes (dialog + Close pi + shutdown)", async () => {
    const file = writeSession(gappedSession(), dir);
    const { ctx, confirm, select, shutdown } = makeFlowCtx(gappedSession(), { hasUI: true, confirmResult: true, file });
    const outcome = await runChainRepairFlow(ctx);
    expect(outcome).toBe("repaired");
    expect(confirm).toHaveBeenCalledWith(
      CHAIN_DETECT_TITLE,
      "Found 2 broken parent link(s). Yes — session file will be backup-ed and repaired then pi will be closed so you would need to restart. No — stay in the session; session-owl memory cannot work correctly until file is repaired.",
    );
    expect(select).toHaveBeenCalledWith(
      `${CHAIN_REPAIRED_TITLE}\nSession file repaired: 2 broken parent link(s) stitched. Backup at: ${file}.owlbak-20261031-120000. Restart pi to continue.`,
      [CLOSE_PI_BUTTON],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(readParentIds(file)[2]).toBe("aaaa0002"); // the file was repaired
  });

  it("shuts down even when the repaired dialog is dismissed (Esc/timeout)", async () => {
    const file = writeSession(gappedSession(), dir);
    const { ctx, shutdown } = makeFlowCtx(gappedSession(), { hasUI: true, selectDismissed: true, file });
    const outcome = await runChainRepairFlow(ctx);
    expect(outcome).toBe("repaired");
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("stays in the session on No (no repair, no shutdown)", async () => {
    const file = writeSession(gappedSession(), dir);
    const { ctx, shutdown, select } = makeFlowCtx(gappedSession(), { hasUI: true, confirmResult: false, file });
    const outcome = await runChainRepairFlow(ctx);
    expect(outcome).toBe("declined");
    expect(select).not.toHaveBeenCalled();
    expect(shutdown).not.toHaveBeenCalled();
    expect(readParentIds(file)[2]).toBe("ghost001"); // untouched
    expect(sink.info).toHaveBeenCalledWith("chain-repair: user declined repair");
  });

  it("shows the failure dialog and stays in the session when repair fails", async () => {
    const file = writeSession(gappedSession(), dir);
    mkdirSync(`${file}.owlbak-20261031-120000`); // force a backup failure
    const { ctx, confirm, shutdown, select } = makeFlowCtx(gappedSession(), { hasUI: true, file });
    const outcome = await runChainRepairFlow(ctx);
    expect(outcome).toBe("failed");
    expect(shutdown).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    const failureTitle = confirm.mock.calls[1]?.[0];
    const failureMessage = confirm.mock.calls[1]?.[1];
    expect(failureTitle).toBe(CHAIN_FAILED_TITLE);
    expect(failureMessage).toContain("Found 2 broken parent link(s), repair failed (");
    expect(failureMessage).toContain("session-owl cannot work correctly until the file is repaired.");
    expect(sink.error).toHaveBeenCalledWith(expect.stringContaining("chain-repair: failed — "), undefined);
  });

  it("auto-repairs without dialogs in headless mode: notify(error) + shutdown", async () => {
    const file = writeSession(gappedSession(), dir);
    const { ctx, confirm, select, notify, shutdown } = makeFlowCtx(gappedSession(), { hasUI: false, file });
    const outcome = await runChainRepairFlow(ctx);
    expect(outcome).toBe("repaired");
    expect(confirm).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      `${CHAIN_REPAIRED_TITLE}\nSession file repaired: 2 broken parent link(s) stitched. Backup at: ${file}.owlbak-20261031-120000. Restart pi to continue.`,
      "error",
    );
  });

  it("headless repair failure: log.error only, stays running", async () => {
    const file = writeSession(gappedSession(), dir);
    mkdirSync(`${file}.owlbak-20261031-120000`);
    const { ctx, shutdown, notify } = makeFlowCtx(gappedSession(), { hasUI: false, file });
    const outcome = await runChainRepairFlow(ctx);
    expect(outcome).toBe("failed");
    expect(shutdown).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(sink.error).toHaveBeenCalledWith(expect.stringContaining("chain-repair: failed — "), undefined);
  });

  it("headless: a file repaired concurrently by another process is a no-issue", async () => {
    const file = writeSession(gappedSession(), dir);
    repairSessionChainFile(file); // the other process heals it first
    const { ctx, shutdown, notify } = makeFlowCtx(gappedSession(), { hasUI: false, file });
    const outcome = await runChainRepairFlow(ctx);
    expect(outcome).toBe("no-issue");
    expect(shutdown).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("chain-repair texts", () => {
  it("pins the failure message shape", () => {
    expect(chainFailedMessage(3, "boom")).toBe(
      "Found 3 broken parent link(s), repair failed (boom). session-owl cannot work correctly until the file is repaired.",
    );
    expect(chainRepairedMessage(3, "/tmp/x")).toBe(
      "Session file repaired: 3 broken parent link(s) stitched. Backup at: /tmp/x. Restart pi to continue.",
    );
    expect(chainDetectMessage(3)).toBe(
      "Found 3 broken parent link(s). Yes — session file will be backup-ed and repaired then pi will be closed so you would need to restart. No — stay in the session; session-owl memory cannot work correctly until file is repaired.",
    );
    expect(CLOSE_PI_BUTTON).toBe("Close pi");
    expect(CHAIN_DETECT_TITLE).toBe("🦉 session-owl — broken session chain detected");
    expect(CHAIN_REPAIRED_TITLE).toBe("🦉 session-owl — session file repaired");
    expect(CHAIN_FAILED_TITLE).toBe("🦉 session-owl — session file repair failed");
  });
});
