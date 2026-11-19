import {
  MESSAGE_SEND_LIMIT_PER_DAY,
  MESSAGE_SEND_LIMIT_PER_HOUR,
  MESSAGE_SEND_LIMIT_PER_MINUTE,
} from "@chat/contracts";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export type MessageRateLimitCheck =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; limitScope: "minute" | "hour" | "day" };

export interface MessageRateLimiterOptions {
  maxPerMinute?: number;
  maxPerHour?: number;
  maxPerDay?: number;
}

/**
 * Per-process sliding-window rate limiter for outbound message sends
 * (DEC-016 §5.2, FR-SEC-019, DEC-014 single-instance topology).
 *
 * Enforces 30/minute, 300/hour, and 1,000/day per authenticated user. Stores
 * only numeric epoch timestamps keyed by `userId`.
 */
export class MessageRateLimiter {
  private readonly maxPerMinute: number;
  private readonly maxPerHour: number;
  private readonly maxPerDay: number;
  private readonly eventsByUser = new Map<string, number[]>();

  constructor(options: MessageRateLimiterOptions = {}) {
    this.maxPerMinute = options.maxPerMinute ?? MESSAGE_SEND_LIMIT_PER_MINUTE;
    this.maxPerHour = options.maxPerHour ?? MESSAGE_SEND_LIMIT_PER_HOUR;
    this.maxPerDay = options.maxPerDay ?? MESSAGE_SEND_LIMIT_PER_DAY;
  }

  consume(userId: string, now = new Date()): MessageRateLimitCheck {
    const nowMs = now.getTime();
    const dayCutoff = nowMs - DAY_MS;
    const hourCutoff = nowMs - HOUR_MS;
    const minuteCutoff = nowMs - MINUTE_MS;

    const recentDay = (this.eventsByUser.get(userId) ?? []).filter((ts) => ts > dayCutoff);
    const recentHour = recentDay.filter((ts) => ts > hourCutoff);
    const recentMinute = recentHour.filter((ts) => ts > minuteCutoff);

    if (recentMinute.length >= this.maxPerMinute) {
      const oldestInMinute = recentMinute[0] ?? nowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestInMinute + MINUTE_MS - nowMs) / 1000));
      this.eventsByUser.set(userId, recentDay);
      return { allowed: false, retryAfterSeconds, limitScope: "minute" };
    }

    if (recentHour.length >= this.maxPerHour) {
      const oldestInHour = recentHour[0] ?? nowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestInHour + HOUR_MS - nowMs) / 1000));
      this.eventsByUser.set(userId, recentDay);
      return { allowed: false, retryAfterSeconds, limitScope: "hour" };
    }

    if (recentDay.length >= this.maxPerDay) {
      const oldestInDay = recentDay[0] ?? nowMs;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestInDay + DAY_MS - nowMs) / 1000));
      this.eventsByUser.set(userId, recentDay);
      return { allowed: false, retryAfterSeconds, limitScope: "day" };
    }

    recentDay.push(nowMs);
    this.eventsByUser.set(userId, recentDay);
    return { allowed: true };
  }
}
