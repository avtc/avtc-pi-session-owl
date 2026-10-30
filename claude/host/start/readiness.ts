// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The resume readiness latch: the widget's owl line draws only when the
// system is READY to serve — the store read landed AND the details cache
// warmed. One process-global latch (the band belongs to the main
// conversation; subagent loops draw no band).

let warmPending = false;

/** Mark the warm as in flight (the band hides until it completes). */
export function markDetailsWarmPending(): void {
  warmPending = true;
}

/** Mark the warm complete (the band may draw again — the caller refreshes
 *  the ui so the line appears without waiting for the next engine render). */
export function markDetailsWarmDone(): void {
  warmPending = false;
}

/** Whether the warm still holds the owl line back. */
export function detailsWarmPending(): boolean {
  return warmPending;
}
