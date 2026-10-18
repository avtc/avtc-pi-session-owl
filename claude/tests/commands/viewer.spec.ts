// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The command-output viewer pane: eligibility, the content store, the
// element tree, and the routing switch (eligible output opens the pane;
// everything else stays on the notify transport).

import { beforeEach, describe, expect, test } from "vitest";
import {
  buildViewerTree,
  clearViewerContent,
  getViewerContent,
  OUTPUT_PANE_VIEWER,
  routeOutput,
  setViewerContent,
  VIEWER_PANE_ID,
  wantsViewer,
} from "../../host/commands/viewer.js";

beforeEach(() => {
  clearViewerContent();
});

describe("command-output viewer pane", () => {
  test("the switch ships enabled and the pane id is namespaced", () => {
    expect(OUTPUT_PANE_VIEWER).toBe(true);
    expect(VIEWER_PANE_ID).toBe("session-owl-output");
  });

  test("eligibility: every non-empty routed listing takes the pane — one root is still a browse surface", () => {
    expect(wantsViewer("one root line")).toBe(true);
    expect(wantsViewer("a".repeat(181))).toBe(true);
    expect(wantsViewer("line 1\nline 2")).toBe(true);
    expect(wantsViewer("")).toBe(false);
  });

  test("the content store round-trips what the open capsule sets", () => {
    setViewerContent("owl-ls — roots", "n1 root\nn2 child");
    expect(getViewerContent()).toEqual({ title: "owl-ls — roots", text: "n1 root\nn2 child" });
  });

  test("the tree draws one Text per line (empty lines as a space) inside one Box", () => {
    setViewerContent("t", "alpha\n\nbeta");
    const made: ["Box" | "Text", Record<string, unknown>][] = [];
    const els = {
      Box: (props: Record<string, unknown>) => {
        made.push(["Box", props]);
        return { box: props };
      },
      Text: (props: Record<string, unknown>) => {
        made.push(["Text", props]);
        return { text: props };
      },
    };
    const tree = buildViewerTree(els) as { box: { children: unknown[] } };
    const texts = made.filter(([k]) => k === "Text").map(([, p]) => p.children as unknown);
    expect(texts).toEqual(["alpha", " ", "beta"]);
    expect(made.some(([k]) => k === "Box")).toBe(true);
    expect(tree.box.children).toHaveLength(3);
  });

  test("the empty pane draws a placeholder line", () => {
    clearViewerContent();
    const els = {
      Box: (props: Record<string, unknown>) => ({ box: props }),
      Text: (props: Record<string, unknown>) => ({ text: props }),
    };
    const tree = buildViewerTree(els) as { text: { children: unknown } };
    expect(tree.text.children).toContain("Nothing to show.");
  });

  test("routing: routed text opens the viewer even when it is one line; empty text notifies", () => {
    const opened: string[] = [];
    const notified: string[] = [];
    const deps = {
      notify: (text: string) => notified.push(text),
      openViewer: (title: string, text: string) => opened.push(`${title}::${text}`),
    };
    routeOutput(deps, "roots", "n1 root\nn2 child");
    routeOutput(deps, "roots", "📁 nGoal · crit · single root");
    expect(opened).toEqual(["roots::n1 root\nn2 child", "roots::📁 nGoal · crit · single root"]);
    expect(notified).toEqual([]);
    routeOutput(deps, "roots", "");
    expect(notified).toEqual([""]);
    expect(opened).toHaveLength(2);
  });

  test("routing: the switch off, or no viewer wired, keeps everything on notify", () => {
    const opened: string[] = [];
    const notified: string[] = [];
    const deps = {
      notify: (text: string) => notified.push(text),
      openViewer: (title: string, text: string) => opened.push(`${title}::${text}`),
    };
    routeOutput(deps, "roots", "n1\nn2", false);
    expect(opened).toEqual([]);
    expect(notified).toEqual(["n1\nn2"]);
    notified.length = 0;
    const bare = { notify: deps.notify };
    routeOutput(bare, "roots", "n1\nn2");
    expect(opened).toEqual([]);
    expect(notified).toEqual(["n1\nn2"]);
  });
});
