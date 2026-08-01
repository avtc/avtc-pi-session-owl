// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { ImportanceSchema, NodeStateSchema, PageSchema } from "../src/schema.js";

// TypeBox schema objects carry `.type`/`.enum`/`.properties` at runtime; TS hides
// them behind the `TSchema`/`TUnsafe` type, so read them via a narrow cast.
const asJson = (s: unknown): Record<string, unknown> => s as Record<string, unknown>;

describe("ImportanceSchema", () => {
  it("is a string enum of the four importance levels", () => {
    expect(asJson(ImportanceSchema).type).toBe("string");
    expect(asJson(ImportanceSchema).enum).toEqual(["critical", "high", "medium", "low"]);
  });
});

describe("NodeStateSchema", () => {
  it("is a string enum of the four node states", () => {
    expect(asJson(NodeStateSchema).type).toBe("string");
    expect(asJson(NodeStateSchema).enum).toEqual(["new", "active", "archived", "obsolete"]);
  });
});

describe("PageSchema", () => {
  it("is an object with take (integer) and afterId (string|null)", () => {
    const props = asJson(PageSchema).properties as Record<string, Record<string, unknown>>;
    expect(asJson(PageSchema).type).toBe("object");
    expect(props.take?.type).toBe("integer");
    const afterId = props.afterId as { anyOf: { type: string }[] };
    expect(Array.isArray(afterId.anyOf)).toBe(true);
    const types = afterId.anyOf.map((t) => t.type).sort();
    expect(types).toEqual(["null", "string"]);
  });

  it("composes inside a tool parameter object (nested-object support)", () => {
    const toolParams = Type.Object({
      nodeId: Type.Optional(Type.String()),
      page: Type.Optional(PageSchema),
    });
    expect(asJson(toolParams).type).toBe("object");
    expect((asJson(toolParams).properties as Record<string, unknown>).page).toBeDefined();
  });
});
