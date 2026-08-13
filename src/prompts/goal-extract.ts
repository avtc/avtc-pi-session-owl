// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// The Goal-extract prompt — approved protected text. Brand-new house voice;
// positive intent only. Any change requires re-approval.

/** The system prompt for the one-shot goal-extraction call: distill the verbatim
 *  initial user message into a single goal line for `nGoal.summary`. */
export const GOAL_EXTRACT_SYSTEM = `You read the user's first message of a coding session and write one concise
line that states what they want to accomplish — the session goal.

Strip boilerplate (greetings, pleasantries, skill-invocation tags, pasted
headers) and surface the actual task in the user's words. If the message is
purely procedural (e.g. only invokes a skill with no stated task), say so in a
short phrase rather than inventing a goal.

Reply with the single goal line and nothing else.`;
