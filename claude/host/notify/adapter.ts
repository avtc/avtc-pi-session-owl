// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The shared notify adapter — the port of pi's src/notify.ts surface.
// pi wraps `ctx.ui.notify(message, level)`; the platform's equivalent is
// `$.ui.log(text)`, a dim transcript line the model never reads. Three
// mechanical differences the adapter owns once for every call site:
//
//   line  ONE CALL PER MESSAGE: the line breaks of a multi-line message
//         are replaced by " | " and empty lines dropped — the engine's
//         block draw turns an embedded newline into U+FFFD at the terminal
//         (the engine receipt keeps our real newlines intact; the
//         conversion is at draw), while one-call-per-line flooded the
//         screen with a plugin bullet per row.
//   level pi's per-level color/theming has no ui.log equivalent: the level
//         is dropped here and the text passes through byte-identical apart
//         from the delimiter join (pi's textual severity lives in the
//         message texts themselves). The cosmetic loss is recorded in the
//         port's gaps register — never compensated by rewriting.
//
// The capsule rule: the ui.log call site is authored in the register
// handler (`$.ui.log(text)` spelled literally); this adapter receives the
// capsule and never sees `$`.
export type NotifyLevel = "info" | "warning" | "error";

/** pi's notify transport, level-carrying — pi's argument order
 *  (`notify(ctx, message, level)`), shared with the run seams' StageNotify
 *  and the compaction hook's notify dep so every surface spells it alike. */
export type NotifyFn = (text: string, level: NotifyLevel) => void;

/** pi's confirm transport (title + message → boolean). */
export type ConfirmFn = (title: string, message: string) => Promise<boolean>;

/** Build the notify adapter over the ui.log capsule. One call per message:
 *  the message's lines (empty ones dropped) joined by the " | " delimiter,
 *  the level dropped (the cosmetic gap). */
export function makeNotifyAdapter(uiLog: (text: string) => void): NotifyFn {
  return (text, _level) => {
    uiLog(
      text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .join(" | "),
    );
  };
}
