// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { _setConflictsHomeForTest, CONFLICT_PACKAGE_MARKERS, detectConflicts } from "../../src/conflicts/detect.js";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mk-conflicts-"));
  project = mkdtempSync(join(tmpdir(), "mk-conflicts-proj-"));
  _setConflictsHomeForTest(home);
});

afterAll(() => {
  _setConflictsHomeForTest(null);
});

function writeUserSettings(packages: string[]): void {
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify({ packages }), "utf8");
}

function writeProjectSettings(packages: string[]): void {
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ packages }), "utf8");
}

describe("detectConflicts", () => {
  it("matches curated conflict packages from user settings across npm/path source forms", () => {
    writeUserSettings([
      "npm:pi-tool-display", // unrelated
      "npm:pi-blackhole",
      "E:\\work\\pi\\pi-observational-memory", // local fork by path
      "npm:@cortexkit/pi-magic-context", // scoped
    ]);
    const hits = detectConflicts({ projectDir: project });
    expect(hits).toHaveLength(3);
    expect(hits.map((h) => h.entry).sort()).toEqual([
      "E:\\work\\pi\\pi-observational-memory",
      "npm:@cortexkit/pi-magic-context",
      "npm:pi-blackhole",
    ]);
    expect(hits.find((h) => h.entry === "npm:pi-blackhole")?.matched).toBe("pi-blackhole");
  });

  it("matches git: entries and project settings", () => {
    writeProjectSettings(["git:github.com/user/pi-vcc@v1", "npm:pi-tool-display"]);
    const hits = detectConflicts({ projectDir: project });
    expect(hits).toHaveLength(1);
    expect(hits[0].entry).toBe("git:github.com/user/pi-vcc@v1");
    expect(hits[0].matched).toBe("pi-vcc");
  });

  it("excludes memkeeper itself (own entry by name or under selfRoot)", () => {
    writeUserSettings(["E:\\sync\\unique\\work\\git\\pi\\avtc-pi-memkeeper", "npm:avtc-pi-memkeeper"]);
    // a foreign path that happens to live under a memkeeper-shaped selfRoot
    const hits = detectConflicts({
      projectDir: project,
      selfRoot: "E:\\sync\\unique\\work\\git\\pi\\avtc-pi-memkeeper",
    });
    expect(hits).toEqual([]);
  });

  it("dedupes the same package listed in user and project settings", () => {
    writeUserSettings(["npm:pi-smart-compact"]);
    writeProjectSettings(["npm:pi-smart-compact"]);
    expect(detectConflicts({ projectDir: project })).toHaveLength(1);
  });

  it("returns empty when settings files are missing or malformed", () => {
    expect(detectConflicts({ projectDir: project })).toEqual([]);
    writeUserSettings([]);
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(join(home, ".pi", "agent", "settings.json"), "{ not json", "utf8");
    expect(detectConflicts({ projectDir: project })).toEqual([]);
  });

  it("matches case-insensitively (Windows paths)", () => {
    writeUserSettings(["E:\\Work\\PI\\Pi-Blackhole"]);
    expect(detectConflicts({ projectDir: project })).toHaveLength(1);
  });

  it("curated list contains the researched hard conflicts", () => {
    for (const marker of [
      "pi-observational-memory",
      "pi-blackhole",
      "pi-vcc",
      "pi-mcb",
      "pi-press",
      "pi-pact",
      "pi-mega-compact",
      "pi-smart-compact",
      "billion-context-pi",
      "pi-di18n",
      "pi-magic-context",
      "pi-contemplator",
      "pi-viking-memory",
      "pi-compaction-model",
    ]) {
      expect(CONFLICT_PACKAGE_MARKERS).toContain(marker);
    }
  });
});

describe("detectConflicts: generic override-shape scan", () => {
  function writeNpmPackage(name: string, files: Record<string, string>): void {
    const root = join(home, ".pi", "agent", "npm", "node_modules", ...name.split("/"));
    for (const [rel, content] of Object.entries(files)) {
      const file = join(root, rel);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, content, "utf8");
    }
  }

  it("flags an unknown package whose handler returns an override (return-object form)", () => {
    writeNpmPackage("pi-future-compact", {
      "dist/index.js":
        'export default (pi) => { pi.on("session_before_compact", async (e) => { const s = await build(); return { summary: s }; }); };',
    });
    writeUserSettings(["npm:pi-future-compact"]);
    const hits = detectConflicts({ projectDir: project });
    expect(hits).toEqual([{ entry: "npm:pi-future-compact", matched: "session_before_compact" }]);
  });

  it("flags the arrow-object cancel form (minified bundles)", () => {
    writeNpmPackage("pi-canceler", { "dist/index.js": 'pi.on("session_before_compact",()=>({cancel:!0}));' });
    writeUserSettings(["npm:pi-canceler"]);
    expect(detectConflicts({ projectDir: project })).toHaveLength(1);
  });

  it("strips npm version specs when resolving the install dir", () => {
    writeNpmPackage("pi-versioned", {
      "index.js": 'pi.on("session_before_compact", () => ({ cancel: true }));',
    });
    writeUserSettings(["npm:pi-versioned@1.2.3"]);
    expect(detectConflicts({ projectDir: project })).toHaveLength(1);
  });

  it("does not flag passive hook listeners (no override return)", () => {
    writeNpmPackage("pi-bell", {
      "dist/index.js": 'pi.on("session_before_compact", async (_event, ctx) => { ring(ctx); });',
    });
    writeUserSettings(["npm:pi-bell"]);
    expect(detectConflicts({ projectDir: project })).toEqual([]);
  });

  it("exempts the avtc-pi-* suite namespace from the generic scan", () => {
    writeNpmPackage("avtc-pi-hypothetical", {
      "index.js": 'pi.on("session_before_compact", () => ({ cancel: true }));',
    });
    writeUserSettings(["npm:avtc-pi-hypothetical"]);
    expect(detectConflicts({ projectDir: project })).toEqual([]);
  });

  it("does not flag clean packages or .d.ts-only mentions", () => {
    writeNpmPackage("pi-clean", { "dist/index.js": "export default (pi) => {};" });
    writeNpmPackage("pi-types-only", {
      "dist/plugin.d.ts": 'on(event: "session_before_compact", h: Handler): void;',
    });
    writeUserSettings(["npm:pi-clean", "npm:pi-types-only"]);
    expect(detectConflicts({ projectDir: project })).toEqual([]);
  });

  it("scans bare-path entries (local checkouts)", () => {
    const foreign = join(home, "checkouts", "my-renamed-compact");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(
      join(foreign, "main.cjs"),
      'pi.on("session_before_compact", (e) => { return { summary: e.x }; });',
      "utf8",
    );
    writeUserSettings([foreign]);
    const hits = detectConflicts({ projectDir: project });
    expect(hits).toHaveLength(1);
    expect(hits[0].matched).toBe("session_before_compact");
  });

  it("skips node_modules subdirs, oversized files, and deeper-than-2 levels", () => {
    writeNpmPackage("pi-deep", {
      "node_modules/dep/index.js": 'pi.on("session_before_compact", () => ({ cancel: true }));',
      "a/b/c/deep.js": 'pi.on("session_before_compact", () => ({ cancel: true }));',
      "big.js": `${"//".repeat(3 * 1024 * 1024)} pi.on("session_before_compact", () => ({ cancel: true }));`,
    });
    writeUserSettings(["npm:pi-deep"]);
    expect(detectConflicts({ projectDir: project })).toEqual([]);
  });

  it("scans the legacy user extensions dir; suite dirs skipped there too", () => {
    const extDir = join(home, ".pi", "agent", "extensions");
    const foreign = join(extDir, "manual-copy-compact");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "index.mjs"), 'pi.on("session_before_compact", () => ({ cancel: true }));', "utf8");
    const suite = join(extDir, "avtc-pi-hypothetical");
    mkdirSync(suite, { recursive: true });
    writeFileSync(join(suite, "index.js"), 'pi.on("session_before_compact", () => ({ cancel: true }));', "utf8");
    const selfDir = join(extDir, "avtc-pi-memkeeper");
    mkdirSync(selfDir, { recursive: true });
    writeFileSync(join(selfDir, "index.js"), 'pi.on("session_before_compact", () => ({ cancel: true }));', "utf8");
    const hits = detectConflicts({ projectDir: project });
    expect(hits).toHaveLength(1);
    expect(hits[0].entry).toContain("manual-copy-compact");
  });

  it("does not rescan curated-list hits with the generic pass", () => {
    writeNpmPackage("pi-blackhole", { "dist/index.js": 'pi.on("session_before_compact", () => ({ cancel: true }));' });
    writeUserSettings(["npm:pi-blackhole"]);
    const hits = detectConflicts({ projectDir: project });
    expect(hits).toEqual([{ entry: "npm:pi-blackhole", matched: "pi-blackhole" }]);
  });
});
