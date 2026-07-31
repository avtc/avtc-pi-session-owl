// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// STUB (replaced by T14): the real compaction hook (ensure-ready gate + render +
// snapshot) lives here. T7 imports `compactionHook` so the `session_before_compact`
// hook can delegate to it; until T14 lands this returns `undefined` (Pi runs its
// native compaction summary — the `enabled=false` off-path behavior). T24 wires
// the final surface.

import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

/** STUB (T14 replaces): returns undefined → Pi native compaction. The real
 *  return type (SessionBeforeCompactResult) is inferred by the hook wiring in
 *  index.ts; the stub needs only return undefined. */
export async function compactionHook(
  _event: SessionBeforeCompactEvent,
  _ctx: ExtensionContext,
  _pi: ExtensionAPI,
): Promise<undefined> {
  // T14 implements the real ensure-ready gate + summary render + snapshot.
  return undefined;
}
