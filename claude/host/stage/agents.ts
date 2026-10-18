// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The three stage agent types' specs. Platform-verified:
//   spec `name` is the BARE short form (observer/builder/selector); the
//   namespaced pair `<plugin>:<name>` is what spawn takes as subagentType
//   and what agent.offer sees;
//   `description` is required (a host check rejects the registration
//   without it);
//   `tools` is an EXPLICIT name set — the declaring agent sees only it
//   (pi parity);
//   `maxTurns` — pi sets NO cap anywhere (observer/builder/selector run
//   NO_TURN_LIMIT, bounded by per-call maxTokens + timeoutMs + the
//   no-progress stops; goal-extract is a one-shot completer), so the spec
//   carries none — the engine's own default governs;
//   `omitClaudeMd` — the stage context carries its prompt alone;
//   `background` — every spawn runs in the background.
//
// The system prompts arrive as INPUTS (the vendored prompt modules supply
// them; builder/selector prompts are settings-shaped) so this module stays
// import-free — it must sit inside the hooks closure.
import type { StageName } from "./runs.js";

/** The plugin's name as the engine namespaces it under. */
const PLUGIN_NAME = "session-owl";

/** The `subagentType` string for a stage (the namespaced `<plugin>:<name>`). */
export function stageSubagentType(stage: StageName): string {
  return `${PLUGIN_NAME}:${stage}`;
}

/** Every agent type this plugin declares (the bare short forms). */
export const STAGE_AGENT_NAMES: readonly StageName[] = ["observer", "builder", "selector"];

/** The mcp tool name as the model sees it. */
export function stageToolName(short: string): string {
  return `mcp__${PLUGIN_NAME}__${short}`;
}

/** The graph tools the Builder owns: the five mutate tools + the three read
 *  views + the try_finish convergence gate (pi's makeBuilderTools — all
 *  nine; the gate's ok-answer is how the run detects convergence). */
export const BUILDER_GRAPH_TOOLS: readonly string[] = [
  "mkdir",
  "mv",
  "merge",
  "supersede",
  "set_meta",
  "ls",
  "cat",
  "find",
  "try_finish",
];

/** The graph tools the Selector owns: its four-tool mutation subset + the
 *  read views + the try_finish convergence gate (pi's makeSelectorTools'
 *  graph set — all eight). */
export const SELECTOR_GRAPH_TOOLS: readonly string[] = [
  "mkdir",
  "mv",
  "merge",
  "set_meta",
  "ls",
  "cat",
  "find",
  "try_finish",
];

/** The engine built-ins the Selector additionally reads the live project
 *  with (pi's fs_* aliases over its own read/grep/find/ls built-ins — the
 *  Claude counterparts by name). */
export const SELECTOR_FILE_TOOLS: readonly string[] = ["Read", "Grep", "Glob", "LS"];

/** The stage-model settings slice the spec builder reads (structural — the
 *  core's SessionOwlConfig satisfies it; declared locally so no core import
 *  rides into the hooks closure). */
export interface StageModelSettings {
  defaultModel: string | null;
  defaultThinkingLevel: string | null;
  observerModel: string | null;
  observerThinkingLevel: string | null;
  builderModel: string | null;
  builderThinkingLevel: string | null;
  selectorModel: string | null;
  selectorThinkingLevel: string | null;
}

/** One agent type's spec — the subset of the engine's AgentSpec this port
 *  sets (spelled structurally; the register wiring passes it through). */
export interface StageAgentSpec {
  name: string;
  description: string;
  prompt: string;
  tools: readonly string[];
  model: string | undefined;
  effort: string | number | undefined;
  omitClaudeMd: true;
  background: true;
}

/** The spec descriptions (required by the host's registration check). */
const STAGE_DESCRIPTIONS: Record<StageName, string> = {
  observer: "session-owl's memory Observer: reads a session chunk and records observations",
  builder: "session-owl's memory Builder: restructures the observation graph",
  selector: "session-owl's memory Selector: prunes and re-parents the graph's root view",
};

/** Resolve the stage's model from the chain (pi's `resolveStageModel`'s
 *  settings tier): stage setting → default → undefined (the session's). */
export function stageModelFromSettings(settings: StageModelSettings, stage: StageName): string | undefined {
  const perStage: Record<StageName, string | null> = {
    observer: settings.observerModel,
    builder: settings.builderModel,
    selector: settings.selectorModel,
  };
  return perStage[stage] ?? settings.defaultModel ?? undefined;
}

/** Map a thinking level to the engine's effort. "off" and
 *  "minimal" omit the field (the engine's default); the levels pass through;
 *  null (inherit) omits too — the session's effort then governs.  */
export function effortFromThinking(level: string | null): string | undefined {
  if (level === null || level === "off" || level === "minimal") return undefined;
  return level;
}

/** The stage's effort from the chain: stage level → default → undefined. */
export function stageEffortFromSettings(settings: StageModelSettings, stage: StageName): string | undefined {
  const perStage: Record<StageName, string | null> = {
    observer: settings.observerThinkingLevel,
    builder: settings.builderThinkingLevel,
    selector: settings.selectorThinkingLevel,
  };
  return effortFromThinking(perStage[stage] ?? settings.defaultThinkingLevel);
}

/** The exact tool set a stage's agent type sees (mcp-prefixed graph tools;
 *  the Observer's single record tool; the Selector's engine file reads). */
/** The engine's built-in report tool every background agent delivers
 *  through. AgentSpec.tools is EXHAUSTIVE — a call to anything not on the
 *  list is refused — so the handback itself must ride every stage's list
 *  or ask-mode sessions deny it. */
export const HANDBACK_TOOL = "SubagentHandback";

export function agentSpecTools(stage: StageName): readonly string[] {
  if (stage === "observer") return [stageToolName("record_observations"), HANDBACK_TOOL];
  const graph = stage === "builder" ? BUILDER_GRAPH_TOOLS : SELECTOR_GRAPH_TOOLS;
  const tools = graph.map(stageToolName);
  if (stage === "selector") {
    tools.push(...SELECTOR_FILE_TOOLS);
    // the conditional bridge tool rides the spec (AgentSpec.tools is
    // exhaustive — a call to anything else is refused); its body binds only
    // when the todo bridge is live, else the no-executor deny answers
    tools.push(stageToolName("todo_list"));
  }
  tools.push(HANDBACK_TOOL);
  return tools;
}

/** The settings slice with nothing set — every stage inherits the session's
 *  model/effort (the fallback default; the settings wiring passes the
 *  live slice later). */
export function noStageModelSettings(): StageModelSettings {
  return {
    defaultModel: null,
    defaultThinkingLevel: null,
    observerModel: null,
    observerThinkingLevel: null,
    builderModel: null,
    builderThinkingLevel: null,
    selectorModel: null,
    selectorThinkingLevel: null,
  };
}

/** Build the three specs. The prompts are the vendored stage system prompts
 *  (verbatim — pi parity); the settings slice resolves model/effort. */
export function stageAgentSpecs(input: {
  observerPrompt: string;
  builderPrompt: string;
  selectorPrompt: string;
  settings: StageModelSettings;
}): StageAgentSpec[] {
  const prompts: Record<StageName, string> = {
    observer: input.observerPrompt,
    builder: input.builderPrompt,
    selector: input.selectorPrompt,
  };
  return STAGE_AGENT_NAMES.map((stage) => ({
    name: stage,
    description: STAGE_DESCRIPTIONS[stage],
    prompt: prompts[stage],
    tools: agentSpecTools(stage),
    model: stageModelFromSettings(input.settings, stage),
    effort: stageEffortFromSettings(input.settings, stage),
    omitClaudeMd: true as const,
    background: true as const,
  }));
}
