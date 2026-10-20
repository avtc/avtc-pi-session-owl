// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { Type } from "typebox";
// The stage tools' registration surface: the JSON-Schema ToolSpecs mirror
// the vendored TypeBox param schemas exactly (compiled-form parity, pinned
// here against the live tool objects), the caller gate denies every caller
// that is not a live stage spawn, and the executor seam routes
// gated calls to the run-bound executors the runs install.
import { describe, expect, test } from "vitest";
import { makeBuilderTools } from "../../core/src/builder/tools.js";
import {
  type MutateContext,
  makeMergeTool,
  makeMkdirTool,
  makeMvTool,
  makeSelectorSetMetaTool,
} from "../../core/src/graph/mutate-tools.js";
import { makeReadTools, makeTryFinishTool } from "../../core/src/graph/read-tools.js";
import { ImportanceSchema } from "../../core/src/schema.js";
import type { SessionOwlGraph } from "../../core/src/types.js";
import {
  DENY_REASON,
  handleStageToolCall,
  registerStageToolExecutor,
  resetStageToolExecutors,
  STAGE_TOOL_SPECS,
  stageToolShortName,
} from "../../host/stage/tools.js";

const graph = {} as SessionOwlGraph;
const ctx: MutateContext = { policy: "source" as never, persist: () => {} };
const readTools = makeReadTools(graph);
function readParams(name: string): Record<string, unknown> {
  const t = readTools.find((x) => x.name === name);
  if (!t) throw new Error(`no read tool ${name}`);
  return t.parameters as unknown as Record<string, unknown>;
}

function spec(short: string): { name: string; inputSchema: Record<string, unknown> } {
  const s = STAGE_TOOL_SPECS.find((x) => x.name === short);
  if (!s) throw new Error(`no spec ${short}`);
  return s as unknown as { name: string; inputSchema: Record<string, unknown> };
}

describe("stage tool specs — compiled-schema parity with the vendored core", () => {
  test("mkdir mirrors makeMkdirTool's parameters", () => {
    expect(spec("mkdir").inputSchema).toEqual(makeMkdirTool(graph, ctx).parameters);
  });
  test("mv mirrors makeMvTool's parameters", () => {
    expect(spec("mv").inputSchema).toEqual(makeMvTool(graph, ctx).parameters);
  });
  test("merge mirrors makeMergeTool's parameters", () => {
    expect(spec("merge").inputSchema).toEqual(makeMergeTool(graph, ctx).parameters);
  });
  test("supersede mirrors the Builder tool's parameters", () => {
    const supersede = makeBuilderTools(graph, {} as never, {} as never).find((t) => t.name === "supersede");
    expect(spec("supersede").inputSchema).toEqual(supersede?.parameters);
  });

  test("set_meta registers the Builder's union schema (superset of the Selector's)", () => {
    // one global registration: the Builder's SET_META_PARAMS (nodeId/
    // importance/archived/summary/obsolete) covers the Selector's tighter
    // subset — per-stage validation lives in the executors
    const builderSetMeta = makeBuilderTools(graph, {} as never, {} as never).find((t) => t.name === "set_meta");
    expect(spec("set_meta").inputSchema).toEqual(builderSetMeta?.parameters);
    const selectorProps = makeSelectorSetMetaTool(graph, ctx).parameters.properties as Record<string, unknown>;
    const unionProps = spec("set_meta").inputSchema.properties as Record<string, unknown>;
    for (const key of Object.keys(selectorProps)) expect(unionProps[key]).toBeDefined();
  });
  test("ls/cat/find mirror makeReadTools' parameters", () => {
    expect(spec("ls").inputSchema).toEqual(readParams("ls"));
    expect(spec("cat").inputSchema).toEqual(readParams("cat"));
    expect(spec("find").inputSchema).toEqual(readParams("find"));
  });
  test("record_observations mirrors pi's RECORD_OBS_PARAMS (compiled)", () => {
    const piSchema = Type.Object({
      observations: Type.Array(
        Type.Object({
          summary: Type.String({
            minLength: 1,
            description: "The observation, written concisely as its essential meaning.",
          }),
          importance: ImportanceSchema,
          sourceEntryIds: Type.Array(Type.String(), {
            minItems: 1,
            description:
              "Source entry ids this observation draws on — the E=id values in this chunk. At least one; an id not present here rejects this observation.",
          }),
        }),
      ),
    });
    expect(spec("record_observations").inputSchema).toEqual(piSchema);
  });
  test("try_finish mirrors makeTryFinishTool's parameters", () => {
    expect(spec("try_finish").inputSchema).toEqual(
      makeTryFinishTool(graph, { rootViewThreshold: 1 } as never).parameters,
    );
  });
  test("every spec names its short form; the full set is the stages' union + the conditional todo_list", () => {
    expect(STAGE_TOOL_SPECS.map((s) => s.name).sort()).toEqual(
      [
        "record_observations",
        "mkdir",
        "mv",
        "merge",
        "supersede",
        "set_meta",
        "ls",
        "cat",
        "find",
        "try_finish",
        // the conditional bridge tool: registered with the stage
        // set so stage agents see it; its body binds only when the todo
        // bridge is live (unbound ⇒ the no-executor deny, never an error)
        "todo_list",
      ].sort(),
    );
    for (const s of STAGE_TOOL_SPECS) {
      expect(typeof s.description).toBe("string");
      expect((s.description as string).length).toBeGreaterThan(0);
    }
  });
});

describe("caller gate — live stage runs only", () => {
  // the gate predicate mirrors the wiring: live = a stage run in the map
  const live = new Set(["ag-live"]);
  const isLive = (id: string) => live.has(id);

  test("a caller that is not a live stage spawn is denied with the pinned reason", async () => {
    resetStageToolExecutors();
    const r = await handleStageToolCall(
      { tool: "mcp__session-owl__record_observations", agentId: "main-or-other" },
      isLive,
    );
    expect(r).toEqual({ deny: DENY_REASON });
    const noAgent = await handleStageToolCall({ tool: "mcp__session-owl__mkdir" }, isLive);
    expect(noAgent).toEqual({ deny: DENY_REASON });
  });

  test("a live stage spawn with no executor installed is denied (no silent success)", async () => {
    resetStageToolExecutors();
    const r = await handleStageToolCall({ tool: "mcp__session-owl__mkdir", agentId: "ag-live" }, isLive);
    expect(r).toEqual({ deny: 'session-owl: stage tool "mkdir" has no executor installed (stage runs not wired)' });
  });

  test("a gated call routes to the executor with the event", async () => {
    resetStageToolExecutors();
    const seen: unknown[] = [];
    registerStageToolExecutor("mkdir", async (e) => {
      seen.push(e);
      return { result: { ok: true } };
    });
    const r = await handleStageToolCall({ tool: "mcp__session-owl__mkdir", agentId: "ag-live" }, isLive);
    expect(r).toEqual({ result: { ok: true } });
    expect(seen).toHaveLength(1);
  });

  test("a non-stage tool passes through as null (not owl's call)", async () => {
    const r = await handleStageToolCall({ tool: "Bash", agentId: "ag-live" }, isLive);
    expect(r).toBeNull();
  });

  test("the executor's deny is passed through verbatim (validation refusal)", async () => {
    resetStageToolExecutors();
    registerStageToolExecutor("mv", async () => ({ deny: "mv: cycle detected" }));
    const r = await handleStageToolCall({ tool: "mcp__session-owl__mv", agentId: "ag-live" }, isLive);
    expect(r).toEqual({ deny: "mv: cycle detected" });
  });

  test("a COMPLETED run's agentId no longer passes the gate (liveness, not membership)", async () => {
    resetStageToolExecutors();
    registerStageToolExecutor("mkdir", async () => ({ result: { ok: true } }));
    live.delete("ag-live"); // the run completed — membership may persist, liveness does not
    const r = await handleStageToolCall({ tool: "mcp__session-owl__mkdir", agentId: "ag-live" }, isLive);
    expect(r).toEqual({ deny: DENY_REASON });
  });
});

describe("name mapping", () => {
  test("short names map to and from the mcp form", () => {
    expect(stageToolShortName("mcp__session-owl__record_observations")).toBe("record_observations");
    expect(stageToolShortName("Bash")).toBeNull();
    expect(stageToolShortName("mcp__other__mkdir")).toBeNull();
  });
});

describe("stage tool specs — register-time deferral (2.1.293, t33)", () => {
  test("every stage tool spec pins isDeferred:true (schema behind ToolSearch — cache-stable)", () => {
    for (const spec of STAGE_TOOL_SPECS) {
      expect(spec.isDeferred).toBe(true);
    }
  });
});
