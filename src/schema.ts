// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Shared TypeBox schemas reused by every agentLoop tool stage (Observer /
// Builder / Selector) so the importance / state / pagination shapes are defined
// once and never drift (avoids jscpd dupes across every stage).

import { StringEnum } from "@earendil-works/pi-ai";
import { type TSchema, Type } from "typebox";
import { IMPORTANCE_VALUES, NODE_STATE_VALUES } from "./types.js";

/** The four importance levels, derived from the canonical IMPORTANCE_VALUES so
 *  the schema enum cannot drift from the Importance union. */
export const ImportanceSchema: TSchema = StringEnum([...IMPORTANCE_VALUES], {
  description: "How much it matters if lost, by nature — critical, high, medium, or low.",
});

/** The four node states, derived from the canonical NODE_STATE_VALUES so the
 *  schema enum cannot drift from the NodeState union. */
export const NodeStateSchema: TSchema = StringEnum([...NODE_STATE_VALUES], {
  description: "The node's state.",
});

/** Cursor pagination common to read tools (ls/find/cat). */
export const PageSchema: TSchema = Type.Object({
  take: Type.Integer({ minimum: 0, description: "Page size, default 50; 0 = all." }),
  afterId: Type.Union([Type.String(), Type.Null()], {
    description: "The last id from the previous page; omit on the first page.",
  }),
});
