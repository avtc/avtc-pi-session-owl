// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Scratch bench (manual, real store copy): the owl_recall query path on a
// resumed session — the cold details-cache render (first query after a
// process start) vs the warm cache, against the 10s hook budget.
// Opt-in everywhere: point SESSION_OWL_BENCH_DIR at a store copy.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { FsAdapter } from "../../host/storage/fs-adapter.js";

const COPY_DIR = process.env.SESSION_OWL_BENCH_DIR ?? "";

function nodeAdapter(): FsAdapter {
  return {
    readText: async (p: string) => readFileSync(p, "utf8"),
    writeText: async () => {
      throw new Error("bench is read-only");
    },
    listDir: async (p: string) => readdirSync(p) as unknown as string[],
    stat: async () => null,
  };
}

describe("owl_recall cold-cache bench (scratch)", () => {
  test.skipIf(!existsSync(COPY_DIR))(
    "cold vs warm details render + regex over the healed store",
    async () => {
      const fs = nodeAdapter();
      const { LedgerWriter } = await import("../../host/storage/ledger.js");
      const { MirrorWriter, sweepMirror } = await import("../../host/storage/mirror.js");
      const { prepareStoreContext } = await import("../../host/storage/store-context.js");
      const ledger = new LedgerWriter(fs, COPY_DIR, "bench");
      const mirror = new MirrorWriter(fs, COPY_DIR, "bench");
      const sweep = await sweepMirror(fs, COPY_DIR);
      mirror.adoptRows(sweep.rows);
      const prepared = await prepareStoreContext(fs, COPY_DIR, ledger, mirror);
      const graphStore = await import("../../core/src/store/graph-store.js");
      await graphStore.load(prepared.ctx);
      const store = graphStore.getGraphStore();
      const graph = store.graph;
      console.log(`[bench] graph: ${graph.nodes.size} nodes, ${graph.observations.size} observations`);
      expect(graph.observations.size).toBeGreaterThan(1000);

      // the production resolver wiring (the mirror-backed entry index —
      // ClaudeRow payloads in arrival order, exactly mirrorRowsOf(backfill))
      const { makeEntryResolver } = await import("../../host/capture/details-bridge.js");
      const claudeRows = () => {
        const out: unknown[] = [];
        for (const uuid of mirror.arrivalOrder()) {
          const row = mirror.rowByUuid(uuid)?.row;
          if (row !== undefined) out.push(row);
        }
        return out as never[];
      };
      const resolver = makeEntryResolver({ rows: claudeRows, version: () => mirror.rowVersion() });
      (graphStore.getGraphStore() as { resolveEntries: unknown }).resolveEntries = resolver;

      // ---- COLD: render every observation's verbatim details (the resumed
      // process's first query pays exactly this before any regex runs)
      const { renderDetails } = await import("../../core/src/format/details.js");
      const t0 = Date.now();
      let rendered = 0;
      let chars = 0;
      for (const obs of graph.observations.values()) {
        const r = renderDetails(obs.id, [...obs.sourceEntryIds], resolver);
        if (r !== null) {
          rendered += 1;
          chars += r.text.length;
        }
      }
      const coldMs = Date.now() - t0;
      console.log(`[bench] COLD full render: ${rendered} obs, ${(chars / 1e6).toFixed(1)}MB text, ${coldMs}ms`);

      // ---- WARM: same walk again (cache hit)
      const t1 = Date.now();
      for (const obs of graph.observations.values()) {
        renderDetails(obs.id, [...obs.sourceEntryIds], resolver);
      }
      console.log(`[bench] WARM full render: ${Date.now() - t1}ms`);

      // ---- the regexes themselves over the rendered corpus
      const { searchableText } = await import("../../core/src/graph/result-budget.js");
      const texts: string[] = [];
      for (const node of graph.nodes.values()) {
        texts.push(node.summary);
        for (const obsId of node.observationIds) {
          const obs = graph.observations.get(obsId);
          if (obs === undefined) continue;
          const d = renderDetails(obs.id, [...obs.sourceEntryIds], resolver);
          texts.push(searchableText(obs.summary, d === null ? obs.summary : d.text));
        }
      }
      console.log(`[bench] corpus: ${texts.length} texts`);
      for (const q of [
        "nvidia driver version|driver 5[0-9][0-9]|nvidia-smi",
        "driver version|nvidia-smi|5[0-9]{2}\\.[0-9]+",
      ]) {
        const re = new RegExp(q);
        const s0 = Date.now();
        let hits = 0;
        for (const t of texts) if (re.test(t)) hits += 1;
        console.log(`[bench] regex "${q.slice(0, 34)}…": ${hits} hits in ${Date.now() - s0}ms`);
      }
      expect(coldMs).toBeGreaterThan(0);
    },
    600_000,
  );
});
