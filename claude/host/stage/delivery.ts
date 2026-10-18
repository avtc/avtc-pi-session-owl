// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The prompt.submit delivery drop: a background spawn's
// report reaches the main conversation as a peer-origin prompt whose TEXT
// wraps the agent's message in `<agent-message from="<agentId>">…` — the
// main model would read it. owl's stages are engine-internal (the stage
// dump is their record), so exactly these are dropped: peer origin + a
// well-formed agent-message wrapper + a `from` id in the stage-spawn
// registry. Every other class passes (other plugins' agents, the user,
// owl's own prompts — `session.receive` stays the guard for other delivery
// classes).
//
// Import-free by construction (it sits inside the hooks closure; the spawn
// registry arrives as a parameter).

/** The wrapper's parse: `<agent-message from="ID"…>…</agent-message>` with
 *  optional extra attributes and surrounding whitespace. The from-id must
 *  be a non-empty attribute value. */
const AGENT_MESSAGE = /<agent-message\s+[^>]*from="([^"]+)"[^>]*>[\s\S]*<\/agent-message>/;

/** Decide whether a prompt.submit event is a stage agent's handback.
 *  Returns the drop reason, or null to pass the prompt through.
 *
 *  The PRODUCTION envelope carries the wrapper in `text` — live
 *  transcript rows show
 *  `prompt.submit{origin:{kind:"peer"}, text:"<agent-message…"}`; the
 *  context-array scan stays as a defensive fallback for envelope drift. */
export function shouldDropPeerMessage(e: unknown, registry: Map<string, unknown>): string | null {
  const ev = e as {
    origin?: { kind?: unknown };
    context?: readonly unknown[];
    text?: unknown;
  };
  if (ev?.origin === undefined || (ev.origin as { kind?: unknown }).kind !== "peer") return null;
  // the production shape: the wrapper IS the prompt text
  if (typeof ev.text === "string") {
    const m = AGENT_MESSAGE.exec(ev.text);
    if (m !== null) {
      const from = m[1];
      if (registry.has(from)) {
        return `session-owl: stage handback (${from})`;
      }
      return null; // a well-formed wrapper from a non-owl agent — not ours
    }
  }
  const context = ev.context;
  if (context === undefined) return null;
  for (const piece of context) {
    if (typeof piece !== "string") continue;
    const m = AGENT_MESSAGE.exec(piece);
    if (m === null) continue;
    const from = m[1];
    if (registry.has(from)) {
      return `session-owl: stage handback (${from})`;
    }
    return null; // a well-formed wrapper from a non-owl agent — not ours
  }
  return null;
}
