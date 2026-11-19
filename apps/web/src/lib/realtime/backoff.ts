import { RECONNECT_BACKOFF_SCHEDULE_MS, RECONNECT_JITTER_RATIO } from "@chat/contracts";

/**
 * Bounded reconnect backoff calculation (`NFR-REL-003`, `DEC-010`, `DEC-021`):
 * `1 / 2 / 4 / 8 / 16 / 30 s` cap with symmetric `±20%` jitter.
 */
export interface ReconnectBackoffOptions {
  scheduleMs?: readonly number[];
  jitterRatio?: number;
  random?: () => number;
}

export function computeReconnectDelayMs(
  attempt: number,
  options: ReconnectBackoffOptions = {},
): number {
  const schedule =
    options.scheduleMs && options.scheduleMs.length > 0
      ? options.scheduleMs
      : RECONNECT_BACKOFF_SCHEDULE_MS;
  const jitterRatio = Math.max(0, Math.min(0.5, options.jitterRatio ?? RECONNECT_JITTER_RATIO));
  const normalizedAttempt = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0;
  const index = Math.min(normalizedAttempt, schedule.length - 1);
  const baseMs = schedule[index] ?? 30_000;

  const rawRandom = options.random ? options.random() : Math.random();
  const unitRandom = Number.isFinite(rawRandom) ? Math.min(1, Math.max(0, rawRandom)) : 0.5;
  const jitterFactor = 1 + (unitRandom * 2 - 1) * jitterRatio;

  return Math.max(1, Math.round(baseMs * jitterFactor));
}
