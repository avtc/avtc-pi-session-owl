// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// session-owl-subagent-support — the stage spawner companion.
//
// Claude Code tags every tool call an agent makes with the plugin whose
// code spawned it, and then re-entry-skips that plugin's own tool.call
// hooks for those calls — session-owl's spawned stage agents could not
// reliably reach their memory tools. This companion exists to be a
// DIFFERENT spawner: session-owl's orchestration calls the `launch` tool
// here from its ambient code, the hook below returns at once, and an
// ambient timer (fired after the hook's frame closed, so the spawn's
// origin roots HERE, never at the requester) spawns the agent and reports
// the handle back through session-owl's `stage_launched` callback tool.
//
// Stateless by design: no storage, no configuration, nothing to own. The
// stage agent types are registered by session-owl itself; only the spawn
// is routed through here.

async function onSessionStart($, e, next) {
  try {
    await $.tool.register({
      name: "launch",
      description: "Spawn a session-owl stage agent and report its handle back.",
      inputSchema: {
        type: "object",
        required: ["launchId", "subagentType", "prompt"],
        properties: {
          launchId: {
            type: "string",
            description: "The launch id the requester parks its wait under.",
          },
          subagentType: {
            type: "string",
            description: "The namespaced agent type to spawn (session-owl:observe and kin).",
          },
          prompt: {
            type: "string",
            description: "The agent's prompt.",
          },
          model: {
            type: "string",
            description: "An explicit model for the agent, when the requester pins one.",
          },
        },
      },
    });
  } catch (err) {
    // a failed registration surfaces as a refused launch on the caller's
    // side (its broker degrades to the direct spawn) — and the reason is
    // said here too, through the engine's transport first, never silent
    const detail = err instanceof Error ? err.stack || err.message : String(err);
    const text = `session-owl-subagent-support: launch tool registration failed: ${detail}`;
    try {
      $.ui.log(text);
    } catch {
      try {
        console.error(text);
      } catch {
        // no console in this sandbox
      }
    }
  }
  return next(e);
}

async function onToolCall($, e, next) {
  if (e && e.tool === "mcp__session-owl-subagent-support__launch") {
    const launchId = typeof e.launchId === "string" ? e.launchId : "";
    const subagentType = typeof e.subagentType === "string" ? e.subagentType : "";
    const prompt = typeof e.prompt === "string" ? e.prompt : "";
    const model = typeof e.model === "string" ? e.model : undefined;
    // the capsules: closures spelling the engine calls literally, FIRED
    // from the ambient timer below — never inside this hook's frame (a
    // frame-open spawn keeps the requester in the origin chain; probed:
    // only the after-return ambient spawn roots the origin here)
    const spawnCapsule = () =>
      $.agent.spawn({
        subagentType,
        prompt,
        ...(model !== undefined ? { model } : {}),
        background: true,
      });
    const reportCapsule = (payload) => $.tool.call({ tool: "mcp__session-owl__stage_launched", launchId, ...payload });
    // Never a silent failure: a failed spawn reports launchError back
    // through the SAME handshake (the requester rejects the parked launch
    // with this reason and logs it); a failed report says itself on the
    // console if one exists (this companion has no logger of its own).
    // The engine's own transport first: $.ui.log writes a dim transcript
    // row the USER sees (the engine's debug log carries it either way) —
    // the console is only the final fallback for a sandbox without one.
    const sayError = (prefix, err) => {
      const detail = err instanceof Error ? err.stack || err.message : String(err);
      const text = `session-owl-subagent-support: ${prefix}: ${detail}`;
      try {
        $.ui.log(text);
        return;
      } catch {
        // the engine transport refused — fall through
      }
      try {
        console.error(text);
      } catch {
        // no console in this sandbox — nothing exists to say it with
      }
    };
    setTimeout(() => {
      spawnCapsule()
        .then((handle) => {
          const hasId = handle != null && typeof handle.agentId === "string" && handle.agentId.length > 0;
          const payload = hasId
            ? {
                spawnAgentId: handle.agentId,
                spawnModel: typeof handle.model === "string" ? handle.model : "",
              }
            : {
                // an id-less resolve is a spawn failure: report it as one so
                // the requester falls back at once (never a silent timeout);
                // a permission deny (auto mode) resolves rather than rejects,
                // and the raw shape names it
                launchError: `spawn resolved without an agentId: ${JSON.stringify(handle) ?? String(handle)}`,
              };
          return reportCapsule(payload).catch((err) => sayError("stage_launched report failed", err));
        })
        .catch((err) => {
          sayError("stage agent spawn failed", err);
          reportCapsule({ launchError: err instanceof Error ? err.stack || err.message : String(err) }).catch(
            (reportErr) => sayError("launchError report failed", reportErr),
          );
        });
    }, 30);
    return { result: "launching" };
  }
  return next(e);
}

export function register(on) {
  on("session.start", onSessionStart);
  on("tool.call", onToolCall);
}
