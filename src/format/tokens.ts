// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 avtc <tarasenkov@gmail.com>

// Canonical numeric/time formatting shared by the status command and widget.
// Token formatting mirrors pi's footer logic plus a billion tier.

// The canonical chars/4 token estimator lives in types.ts (the data-model
// layer needs it to freeze Observation.contentTokens); re-exported here under
// the name downstream stages expect, so there is a single implementation.
export { estimateContentTokens as estimateTokens } from "../types.js";

const THOUSAND = 1000;
const TEN_THOUSAND = 10_000;
const MILLION = 1_000_000;
const TEN_MILLION = 10_000_000;
const BILLION = 1_000_000_000;
const TEN_BILLION = 10_000_000_000;

const ONE_CENT = 0.01;
const ONE_DOLLAR = 1;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86_400;
const MS_PER_SECOND = 1000;

/** Format a token count with adaptive k/M/B suffix and one-decimal-below-10. */
export function formatTokens(n: number): string {
  if (n < THOUSAND) return String(n);
  if (n < TEN_THOUSAND) return `${(n / THOUSAND).toFixed(1)}k`;
  if (n < MILLION) return `${Math.round(n / THOUSAND)}k`;
  if (n < TEN_MILLION) return `${(n / MILLION).toFixed(1)}M`;
  if (n < BILLION) return `${Math.round(n / MILLION)}M`;
  if (n < TEN_BILLION) return `${(n / BILLION).toFixed(1)}B`;
  return `${Math.round(n / BILLION)}B`;
}

/** Format a USD cost with precision scaled to magnitude. */
export function formatCost(usd: number): string {
  if (usd < ONE_CENT) return `$${usd.toFixed(4)}`;
  if (usd < ONE_DOLLAR) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/** Format a duration in ms as HH:MM:SS, or Nd HH:MM:SS past one day. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / MS_PER_SECOND);
  const days = Math.floor(totalSeconds / SECONDS_PER_DAY);
  const hours = Math.floor((totalSeconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR);
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const pad = (value: number): string => String(value).padStart(2, "0");
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  if (days > 0) return `${days}d ${clock}`;
  return clock;
}

/** Format an integer count with thousands separators. */
export function formatCount(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(n)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}`;
}
