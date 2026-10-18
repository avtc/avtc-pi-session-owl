// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Branch/fork lineage copy: the engine copies the transcript of a /branch or
// /fork under a NEW session id (the first row carries forkedFrom.sessionId),
// but it never copies owl's derived state. This helper copies the origin's
// session directory verbatim for the new id BEFORE any storage assembly
// touches the target — observations, checkpoints and watermarks survive the
// branch instead of being rebuilt from scratch. Red first.
import { describe, expect, test } from "vitest";
import { copyBranchLineageStore, type LineageIo } from "../../host/start/branch-copy.js";

/** An in-memory FsEntry-ish directory + text store. */
function memIo(files: Record<string, string>, opts?: { listThrows?: string }) {
  const store = new Map(Object.entries(files));
  const io: LineageIo & { written: string[] } = {
    read: async (p) => {
      const text = store.get(p);
      if (text === undefined) throw new Error(`ENOENT: ${p}`);
      return text;
    },
    list: async (dir) => {
      if (opts?.listThrows !== undefined && dir === opts.listThrows) throw new Error("ENOENT dir");
      const entries: { name: string; kind: string }[] = [];
      for (const k of store.keys()) {
        if (!k.startsWith(`${dir}/`)) continue;
        const rest = k.slice(dir.length + 1).split("/");
        if (rest.length === 1 && !entries.some((e) => e.name === rest[0])) {
          entries.push({ name: rest[0], kind: "file" });
        }
      }
      return entries;
    },
    write: async (p, t) => {
      io.written.push(p);
      store.set(p, t);
    },
    written: [],
  };
  return { io, store };
}

const ORIGIN_DIR = "/cfg/session-owl/sessions/sess-origin";
const TARGET_DIR = "/cfg/session-owl/sessions/sess-branch";

function transcript(): string {
  const first = JSON.stringify({
    kind: "user",
    sessionId: "sess-branch",
    forkedFrom: { sessionId: "sess-origin" },
  });
  return `${first}\n{"kind":"assistant"}\n`;
}

describe("branch lineage copy — the owl state travels with the copied transcript", () => {
  test("copies every state file except .session.json and logs the copy", async () => {
    const { io, store } = memIo({
      "/cfg/projects/p/sess-branch.jsonl": transcript(),
      [`${ORIGIN_DIR}/ledger-a.jsonl`]: "L1",
      [`${ORIGIN_DIR}/m1-abc.jsonl`]: "M",
      [`${ORIGIN_DIR}/mirror-tail-abc.json`]: "{}",
      [`${ORIGIN_DIR}/timeline-t.jsonl`]: "T",
      [`${ORIGIN_DIR}/.session.json`]: '{"sessionId":"sess-origin"}',
      [`${TARGET_DIR}/.session.json`]: '{"sessionId":"sess-branch"}', // marker-only target = fresh
    });
    const logs: string[] = [];
    const res = await copyBranchLineageStore({
      sessionId: "sess-branch",
      transcriptPath: "/cfg/projects/p/sess-branch.jsonl",
      targetDir: TARGET_DIR,
      originDirPathFor: (id) => `/cfg/session-owl/sessions/${id}`,
      io,
      log: (line) => logs.push(line),
    });
    expect(res.status).toBe("copied");
    expect(res.originSessionId).toBe("sess-origin");
    expect(res.files.sort()).toEqual(
      ["ledger-a.jsonl", "m1-abc.jsonl", "mirror-tail-abc.json", "timeline-t.jsonl"].sort(),
    );
    // the immutable bytes travel
    expect(store.get(`${TARGET_DIR}/ledger-a.jsonl`)).toBe("L1");
    expect(store.get(`${TARGET_DIR}/mirror-tail-abc.json`)).toBe("{}");
    // the marker is the CALLER's job (the envelope facts are not the origin's)
    expect(store.get(`${TARGET_DIR}/.session.json`)).toBe('{"sessionId":"sess-branch"}');
    // never copied
    expect(io.written).not.toContain(`${TARGET_DIR}/.session.json`);
    expect(io.written.some((p) => p.endsWith("sess-origin/.session.json"))).toBe(false);
    expect(logs.join("\n")).toContain("branch store copy:");
    expect(logs.join("\n")).toContain("origin=sess-origin");
  });

  test("a populated target is never touched (a second start must not double-copy)", async () => {
    const { io } = memIo({
      "/cfg/projects/p/sess-branch.jsonl": transcript(),
      [`${ORIGIN_DIR}/ledger-a.jsonl`]: "L1",
      [`${TARGET_DIR}/own-ledger.jsonl`]: "mine",
    });
    const res = await copyBranchLineageStore({
      sessionId: "sess-branch",
      transcriptPath: "/cfg/projects/p/sess-branch.jsonl",
      targetDir: TARGET_DIR,
      originDirPathFor: (id) => `/cfg/session-owl/sessions/${id}`,
      io,
      log: () => {},
    });
    expect(res.status).toBe("target-populated");
    expect(io.written).toEqual([]);
  });

  test("no forkedFrom in the transcript → nothing happens", async () => {
    const { io } = memIo({
      "/cfg/projects/p/sess-branch.jsonl": '{"sessionId":"sess-branch"}\n',
      [`${ORIGIN_DIR}/ledger-a.jsonl`]: "L1",
    });
    const res = await copyBranchLineageStore({
      sessionId: "sess-branch",
      transcriptPath: "/cfg/projects/p/sess-branch.jsonl",
      targetDir: TARGET_DIR,
      originDirPathFor: (id) => `/cfg/session-owl/sessions/${id}`,
      io,
      log: () => {},
    });
    expect(res.status).toBe("no-forked-from");
    expect(io.written).toEqual([]);
  });

  test("a missing origin directory skips cleanly (the rebuild path stays the degrade)", async () => {
    const { io } = memIo({
      "/cfg/projects/p/sess-branch.jsonl": transcript(),
    });
    const res = await copyBranchLineageStore({
      sessionId: "sess-branch",
      transcriptPath: "/cfg/projects/p/sess-branch.jsonl",
      targetDir: TARGET_DIR,
      originDirPathFor: () => "/cfg/session-owl/sessions/sess-gone",
      io,
      log: () => {},
    });
    expect(res.status).toBe("origin-missing");
    expect(io.written).toEqual([]);
  });

  test("a transcript read failure never throws out of the helper (the hook must survive)", async () => {
    const { io } = memIo({});
    const res = await copyBranchLineageStore({
      sessionId: "sess-branch",
      transcriptPath: "/cfg/projects/p/absent.jsonl",
      targetDir: TARGET_DIR,
      originDirPathFor: (id) => `/cfg/session-owl/sessions/${id}`,
      io,
      log: () => {},
    });
    expect(res.status).toBe("no-source");
    expect(io.written).toEqual([]);
  });
});
