// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The log consumer's public name — the implementation (the translating
// backend the vendored core links against) lives in backend.ts, the
// sync-rewrite target of log.ts's avtc-pi-logger import.

export type { LogFsSurface } from "./backend.js";
export {
  _resetLogConsumerForTest,
  initLogConsumer,
  logConsumerReady,
  testBackend,
} from "./backend.js";
