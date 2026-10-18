// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The claude-host project's second setup file (after the shared pi one):
// registers the file-boundary singleton reset as an afterAll, so a spec
// that forgets its own teardown still cannot leak state into the next
// file. Seeder files ALSO reset locally — the boundary here is the
// safety net, not the only line.
import { afterAll } from "vitest";
import { resetClaudeHostSingletons } from "./host-teardown.js";

afterAll(async () => {
  await resetClaudeHostSingletons();
});
