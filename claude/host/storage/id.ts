// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// UUIDv4-shaped ids without node:crypto — the hooks-module closure bans node
// builtins, so the crypto module is unreachable there. These ids only need
// process-unique randomness (batch/part file names), not cryptographic
// strength: Math.random's 2^52 state space plus a monotonic counter makes
// collisions negligible for file naming within and across processes.

let counter = 0;

function hex(n: number): string {
  let out = "";
  for (let i = 0; i < n; i += 1) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

/** A UUIDv4-shaped random id (xxxxxxxx-xxxx-4xxx-Nxxx-xxxxxxxxxxxx). */
export function randomUUID(): string {
  counter += 1;
  const c = counter.toString(16).padStart(6, "0");
  const r = hex(28);
  return `${r.slice(0, 8)}-${r.slice(8, 12)}-4${r.slice(13, 16)}-8${r.slice(17, 20)}-${r.slice(20, 28)}${c}`.slice(
    0,
    36,
  );
}
