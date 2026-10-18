// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The browse command bodies (pi's user.ts browse arms, ported): exact pi
// semantics over the vendored read-tools — the disabled guard, the
// canonical-view check BEFORE every serve, the core pin before singleton
// reads, pi's exact output texts (only the command names swap /owl: →
// /owl-), and the render cap with the drill footer.
import { describe, expect, test, vi } from "vitest";
import { DEFAULT_CONFIG } from "../../core/src/config/schema.js";
import { makeNode, makeObservation, nowStoredTimestamp } from "../../core/src/types.js";
import type { OwlCommandDeps } from "../../host/commands/handlers.js";
import { runOwlCat, runOwlFind, runOwlFindAll, runOwlLs } from "../../host/commands/handlers.js";
import type { NotifyFn } from "../../host/notify/adapter.js";
import { rigUp, seedNode } from "../runs/helpers.js";

// ---- the deps rig -----------------------------------------------------------

interface Notified {
  level: string;
  text: string;
}

async function makeDeps(sessionId: string, seedGoal = true) {
  const rig = await rigUp(sessionId, [], seedGoal);
  const notified: Notified[] = [];
  const notify: NotifyFn = (text, level) => notified.push({ level, text });
  const checkThenServe = vi.fn(async () => {});
  const pinCore = vi.fn(async () => {});
  let enabled = true;
  const deps: OwlCommandDeps = {
    key: sessionId,
    notify,
    confirm: async () => false,
    isEnabled: () => enabled,
    getSettings: () => ({ ...DEFAULT_CONFIG, enabled }),
    checkThenServe,
    pinCore,
    getGraphStore: () => rig.core.store.getGraphStore(),
    getLeafId: () => rig.store.getLeafId(),
    getBranch: () => rig.store.getBranch(rig.store.getLeafId()) as never,
    resetGraphForRescan: () => {},
    relaunchMaintenance: () => {},
    acquireForCompaction: async () => ({
      release: () => {},
      abortController: new AbortController(),
      setStage: () => {},
    }),
    acquireOrSkipObserve: () => null,
    runReuseRebuild: async () => {},
    runObserver: async () => {},
    runBuilder: async () => {},
  };
  return { rig, deps, notified, checkThenServe, pinCore, setEnabled: (v: boolean) => (enabled = v) };
}

/** Attach an observation to a node (fixture). */
function attachObs(rig: Awaited<ReturnType<typeof rigUp>>, parentNode: string, obsId: string, summary: string): void {
  const graph = rig.core.store.getGraphStore().graph;
  graph.observations.set(
    obsId as never,
    makeObservation({
      id: obsId as never,
      summary,
      importance: "med",
      sourceEntryIds: ["e1"],
      timestamp: nowStoredTimestamp(),
      parentNode: parentNode as never,
    }),
  );
  graph.nodes.get(parentNode as never)?.observationIds.push(obsId as never);
}

// ---- the shared guards --------------------------------------------------------

describe("browse commands — guards and order", () => {
  test("disabled: every browse command replies pi's exact info notice and serves nothing", async () => {
    const { deps, notified, checkThenServe } = await makeDeps("cmd-browse-disabled");
    deps.isEnabled = () => false;
    await runOwlLs("", deps);
    await runOwlCat("n1", deps);
    await runOwlFind("q", deps);
    await runOwlFindAll("q", deps);
    expect(notified).toEqual([
      { level: "info", text: "session-owl is disabled." },
      { level: "info", text: "session-owl is disabled." },
      { level: "info", text: "session-owl is disabled." },
      { level: "info", text: "session-owl is disabled." },
    ]);
    expect(checkThenServe).not.toHaveBeenCalled();
  });

  test("the canonical-view check runs BEFORE the serve, then the core pins before singleton reads — per browse command", async () => {
    const { deps, checkThenServe, pinCore } = await makeDeps("cmd-browse-order");
    const order: string[] = [];
    checkThenServe.mockImplementation(async () => {
      order.push("check");
    });
    pinCore.mockImplementation(async () => {
      order.push("pin");
    });
    await runOwlLs("", deps);
    await runOwlCat("", deps); // usage error path: no serve, no pin needed
    await runOwlFind("", deps); // usage error path: ditto
    await runOwlFindAll("", deps); // ditto
    expect(order).toEqual(["check", "pin"]);
    expect(checkThenServe).toHaveBeenCalledWith(deps.key);
    expect(checkThenServe).toHaveBeenCalledTimes(1);
  });

  test("the check precedes the serve on every browse arm's serving path too", async () => {
    // cat/find/find-all with VALID arguments: the check fires before each
    const a = await makeDeps("cmd-browse-order-cat");
    await runOwlCat("nGoal", a.deps);
    expect(a.checkThenServe).toHaveBeenCalledTimes(1);
    const b = await makeDeps("cmd-browse-order-find");
    await runOwlFind("goal", b.deps);
    expect(b.checkThenServe).toHaveBeenCalledTimes(1);
    const c = await makeDeps("cmd-browse-order-findall");
    await runOwlFindAll("goal", c.deps);
    expect(c.checkThenServe).toHaveBeenCalledTimes(1);
  });
});

// ---- /owl-ls ------------------------------------------------------------------

describe("/owl-ls", () => {
  test("no arg: non-obsolete roots, ordered; empty graph answers pi's exact empty notice", async () => {
    const empty = await makeDeps("cmd-ls-empty", false);
    await runOwlLs("", empty.deps);
    expect(empty.notified).toEqual([{ level: "info", text: "No memory yet." }]);

    const { rig, deps, notified } = await makeDeps("cmd-ls-roots");
    seedNode(rig, "nA", "active", "alpha root");
    seedNode(rig, "nB", "new", "fresh root");
    seedNode(rig, "nDead", "obsolete", "gone");
    await runOwlLs("", deps);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.level).toBe("info");
    // non-obsolete roots render with the shared node-line format: the
    // id-prefix + summary both appear, the obsolete one does not
    expect(notified[0]?.text).toContain("nA");
    expect(notified[0]?.text).toContain("alpha root");
    expect(notified[0]?.text).toContain("nB");
    expect(notified[0]?.text).not.toContain("nDead");
  });

  test("with a node id: the parent header + its direct children indented", async () => {
    const { rig, deps, notified } = await makeDeps("cmd-ls-children");
    seedNode(rig, "nParent", "active", "parent node");
    seedNode(rig, "nChild", "active", "child node");
    const graph = rig.core.store.getGraphStore().graph;
    (graph.nodes.get("nChild" as never) as unknown as { parentNode: string }).parentNode = "nParent";
    (graph.nodes.get("nParent" as never) as unknown as { childNodeIds: string[] }).childNodeIds.push("nChild");
    attachObs(rig, "nParent", "oP1", "parent observation");
    await runOwlLs("nParent", deps);
    expect(notified).toHaveLength(1);
    const lines = notified[0]?.text.split("\n") ?? [];
    expect(lines[0]).toContain("parent node");
    expect(lines.some((l) => l.includes("child node"))).toBe(true);
    expect(lines.some((l) => l.includes("parent observation"))).toBe(true);
  });

  test("unknown node id: pi's exact error notice", async () => {
    const { deps, notified } = await makeDeps("cmd-ls-unknown");
    await runOwlLs("nMissing", deps);
    expect(notified).toEqual([{ level: "error", text: "No node 'nMissing'." }]);
  });

  test("the cap truncates with pi's drill footer (kebab names)", async () => {
    const { rig, deps, notified } = await makeDeps("cmd-ls-cap");
    deps.getSettings = () => ({ ...DEFAULT_CONFIG, commandResultCap: 2 });
    seedNode(rig, "n1", "active", "one");
    seedNode(rig, "n2", "active", "two");
    seedNode(rig, "n3", "active", "three");
    seedNode(rig, "n4", "active", "four");
    await runOwlLs("", deps);
    const text = notified[0]?.text ?? "";
    const lines = text.split("\n");
    expect(lines).toHaveLength(3);
    // nGoal (the rig seed) + 4 seeded roots, cap 2 ⇒ 3 dropped
    expect(lines[2]).toBe("… +3 more — drill with /owl-ls <id> or narrow with /owl-find");
  });
});

// ---- /owl-cat -----------------------------------------------------------------

describe("/owl-cat", () => {
  test("missing arg: pi's exact usage error", async () => {
    const { deps, notified } = await makeDeps("cmd-cat-usage");
    await runOwlCat("   ", deps);
    expect(notified).toEqual([{ level: "error", text: "Usage: /owl-cat <id> — give a node id or an observation id." }]);
  });

  test("unknown id: pi's exact error naming the id", async () => {
    const { deps, notified } = await makeDeps("cmd-cat-unknown");
    await runOwlCat("nope", deps);
    expect(notified).toEqual([{ level: "error", text: "No node or observation with id 'nope'." }]);
  });

  test("a node id: its header + its observations' content (the vendored renderCatUnit)", async () => {
    const { deps, notified, rig } = await makeDeps("cmd-cat-node");
    const graph = rig.core.store.getGraphStore().graph;
    graph.nodes.set(
      "nX" as never,
      makeNode({
        id: "nX" as never,
        summary: "the x node",
        importance: "high",
        parentNode: null,
        state: "active",
        createdAt: nowStoredTimestamp(),
      }) as never,
    );
    attachObs(rig, "nX", "oX", "the observation summary");
    await runOwlCat("nX", deps);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.level).toBe("info");
    expect(notified[0]?.text).toContain("the x node");
  });

  test("an observation id: its full text", async () => {
    const { deps, notified, rig } = await makeDeps("cmd-cat-obs");
    const graph = rig.core.store.getGraphStore().graph;
    graph.nodes.set(
      "nY" as never,
      makeNode({
        id: "nY" as never,
        summary: "y node",
        importance: "med",
        parentNode: null,
        state: "active",
        createdAt: nowStoredTimestamp(),
      }) as never,
    );
    attachObs(rig, "nY", "oY", "y observation");
    await runOwlCat("oY", deps);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.text).toContain("y observation");
  });
});

// ---- /owl-find + /owl-find-all --------------------------------------------------

describe("/owl-find + /owl-find-all", () => {
  test("missing arg: pi's exact usage error (kebab name)", async () => {
    const { deps, notified } = await makeDeps("cmd-find-usage");
    await runOwlFind("", deps);
    expect(notified).toEqual([
      {
        level: "error",
        text: "Usage: /owl-find <query> — give a JS regex to search node summaries and observation content.",
      },
    ]);
  });

  test("invalid regex: the vendored compile error verbatim", async () => {
    const { deps, notified } = await makeDeps("cmd-find-badregex");
    await runOwlFind("(unclosed", deps);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.level).toBe("error");
    expect(notified[0]?.text).toContain("(unclosed");
  });

  test("no matches: pi's exact empty notice", async () => {
    const { deps, notified } = await makeDeps("cmd-find-none");
    await runOwlFind("zzz-no-such-thing", deps);
    expect(notified).toEqual([{ level: "info", text: "No matches." }]);
  });

  test("find-all sees the obsolete node find hides (separate rigs, exact texts)", async () => {
    const a = await makeDeps("cmd-find-scope-a");
    seedNode(a.rig, "nAlive", "active", "needle here");
    seedNode(a.rig, "nGone", "obsolete", "needle buried");
    await runOwlFind("needle", a.deps);
    expect(a.notified[0]?.text).toContain("nAlive");
    expect(a.notified[0]?.text).not.toContain("nGone");

    const b = await makeDeps("cmd-find-scope-b");
    seedNode(b.rig, "nAlive2", "active", "needle here");
    seedNode(b.rig, "nGone2", "obsolete", "needle buried");
    await runOwlFindAll("needle", b.deps);
    expect(b.notified[0]?.text).toContain("nAlive2");
    expect(b.notified[0]?.text).toContain("nGone2");
  });

  test("a match renders with the node id and summary", async () => {
    const { rig, deps, notified } = await makeDeps("cmd-find-hit");
    seedNode(rig, "nHit", "active", "the haystack node");
    await runOwlFind("haystack", deps);
    expect(notified[0]?.text).toContain("nHit");
    expect(notified[0]?.text).toContain("the haystack node");
  });
});
