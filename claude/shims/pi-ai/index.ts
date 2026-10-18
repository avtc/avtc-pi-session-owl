// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Local shim for @earendil-works/pi-ai inside the packaged plugin. The
// vendored core's only pi-ai VALUE import is StringEnum (src/schema.ts);
// everything else is type-only and erases at load. Signature copied from
// pi-ai's dist/utils/typebox-helpers.d.ts (v1.x), implemented typebox-
// natively exactly as pi-ai's own dist does. typebox is imported by relative
// path into the plugin's installed tree — the engine's hooks environment has
// no Node package resolution, only relative own-file imports.
import { type TUnsafe, Type } from "../../node_modules/typebox/build/index.mjs";

/**
 * Creates a string enum schema compatible with Google's API and other
 * providers that don't support anyOf/const patterns.
 *
 * @example
 * const OperationSchema = StringEnum(["add", "subtract"], {
 *   description: "The operation to perform"
 * });
 */
export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: {
    description?: string;
    default?: T[number];
  },
): TUnsafe<T[number]> {
  return Type.Unsafe({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}
