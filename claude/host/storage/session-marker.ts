// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The co-located session marker: {sessionId, transcriptPath} inside the
// session directory, re-written at every session.start (benign double-write
// by design), swept away with the directory by the same prune pass. Kept in
// its own module (no core imports) so the host binding can share the
// filename constant without pulling the storage closure. The WRITE itself
// is a whole-file replace the host binding inlines ($.fs has no append).

export const SESSION_MARKER_FILENAME = ".session.json";

export interface SessionMarker {
  sessionId: string;
  transcriptPath: string | null;
}
