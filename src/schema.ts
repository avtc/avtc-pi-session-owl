// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared TypeBox schemas reused by every agentLoop tool stage (Observer /
// Builder / Selector) so the importance / state / pagination shapes are defined
// once and never drift (avoids jscpd dupes across every stage).

import { StringEnum } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";

/** The four importance levels (critical/high/medium/low). */
export const ImportanceSchema: TSchema = StringEnum(["critical", "high", "medium", "low"], {
  description: "How load-bearing this item is by nature — critical, high, medium, or low.",
});

/** The four node states (new/active/archived/obsolete). */
export const NodeStateSchema: TSchema = StringEnum(["new", "active", "archived", "obsolete"], {
  description: "The node's state.",
});

/** Cursor pagination common to read tools (ls/find/cat). */
export const PageSchema: TSchema = Type.Object({
  take: Type.Integer({ description: "Page size; 0 = all." }),
  afterId: Type.Union([Type.String(), Type.Null()], {
    description: "Last id of the previous page; null from the start.",
  }),
});
