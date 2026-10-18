// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>
//
// Shared smoke-gate kit: the offline mock Anthropic endpoint, the committed-
// types snapshot/restore, and the async claude spawn. Both live gates (the
// load/fire smoke and the inertness smoke) run on it.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The offline mock endpoint: fixed "ok" answers, plain JSON or SSE. */
export async function startMockServer() {
  const server = (await import("node:http")).createServer((req, res) => {
    if (req.method === "HEAD" || req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (req.method !== "POST" || !req.url.includes("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let stream = false;
      try {
        stream = JSON.parse(body).stream === true;
      } catch {
        stream = false;
      }
      const msg = {
        id: "msg_mock_smoke",
        type: "message",
        role: "assistant",
        model: "mock-model",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(msg));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      sse("message_start", { type: "message_start", message: msg });
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
      sse("content_block_stop", { type: "content_block_stop", index: 0 });
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      });
      sse("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/** The sequenced mock: call 1 forces ONE tool_use of `toolName` with
 *  `input`, every later call answers plain "ok" — the serve-round-trip
 *  smoke (a plugin tool called end-to-end in a real `claude -p` session). */
export async function startSequencedMock(toolName, input, toolUseId = "tu_smoke_tool") {
  let call = 0;
  const server = (await import("node:http")).createServer((req, res) => {
    if (req.method === "HEAD" || req.url.includes("count_tokens")) {
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (req.method !== "POST" || !req.url.includes("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let stream = false;
      try {
        stream = JSON.parse(body).stream === true;
      } catch {
        stream = false;
      }
      call += 1;
      const toolUse = call === 1;
      const content = toolUse
        ? [{ type: "tool_use", id: toolUseId, name: toolName, input }]
        : [{ type: "text", text: "ok" }];
      const msg = {
        id: `msg_mock_seq_${call}`,
        type: "message",
        role: "assistant",
        model: "mock-model",
        content,
        stop_reason: toolUse ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      };
      if (!stream) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(msg));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const sse = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      sse("message_start", { type: "message_start", message: msg });
      content.forEach((block, index) => {
        if (block.type === "text") {
          sse("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
          sse("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: block.text },
          });
        } else {
          sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
          });
          const json = JSON.stringify(block.input);
          const half = Math.ceil(json.length / 2);
          sse("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: json.slice(0, half) },
          });
          sse("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: json.slice(half) },
          });
        }
        sse("content_block_stop", { type: "content_block_stop", index });
      });
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: toolUse ? "tool_use" : "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      });
      sse("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/**
 * Snapshot the committed generated types and return a restore fn. The engine
 * rewrites .claude-plugin/types at every plugin load — the gates must not
 * mutate the committed artifacts (restores any engine change afterward).
 */
export function typesGuard(pluginDir) {
  const typesDir = join(pluginDir, ".claude-plugin", "types");
  const snapshot = new Map();
  for (const group of existsSync(typesDir) ? readdirSync(typesDir, { withFileTypes: true }) : []) {
    if (!group.isDirectory()) continue;
    for (const entry of readdirSync(join(typesDir, group.name), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".d.ts")) {
        const p = join(typesDir, group.name, entry.name);
        snapshot.set(p, readFileSync(p, "utf8"));
      }
    }
  }
  return () => {
    for (const [p, snap] of snapshot) {
      try {
        if (readFileSync(p, "utf8") === snap) continue;
      } catch {
        // engine-deleted — write the snapshot back below
      }
      try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, snap);
        process.stdout.write(`[smoke-kit] restored committed types: reverted engine change of ${p}\n`);
      } catch {
        // best effort
      }
    }
    for (const group of existsSync(typesDir) ? readdirSync(typesDir, { withFileTypes: true }) : []) {
      if (!group.isDirectory()) continue;
      for (const entry of readdirSync(join(typesDir, group.name), { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
        const p = join(typesDir, group.name, entry.name);
        if (!snapshot.has(p)) rmSync(p, { force: true });
      }
    }
  };
}

/**
 * Async claude -p spawn (the mock server shares this event loop — a sync
 * spawn would starve it). Returns { status, stdout, stderr }.
 */
export function runClaude(args, { env, cwd, timeoutMs = 60_000 }) {
  return new Promise((resolveRun) => {
    const child = spawn("claude", args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill();
      resolveRun({ status: null, stdout, stderr });
    }, timeoutMs);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
  });
}
