// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Package entry point for pi (keeps the startup display name clean).
// Re-exports the real factory + named exports from src/.

export * from "./src/index.js";
export { default } from "./src/index.js";
