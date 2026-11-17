import {
  CONVERSATION_CREATE_LIMIT_PER_DAY,
  CONVERSATION_CREATE_LIMIT_PER_HOUR,
} from "@chat/contracts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type RateLimitCheck =
  { allowed: true } | { allowed: false; retryAfterSeconds: number; limitScope: "hour" | "day" };

export interface ConversationRateLimiterOptions {
  maxPerHour?: number;
  maxPerDay?: number;
}

/**
 * Per-process sliding-window rate limiter for conversation creation
 * (DEC-016 §5.2, FR-SEC-019, DEC-014 single-instance topology).
 *
 * Enforces 10/hour and 50/day per authenticated user. Stores only numeric
 * epoch timestamps keyed by `userId` (no message/peer content).
 */
export class ConversationRateLimiter {
  private readonly maxPerHour: number;
  private readonly maxPerDay: number;
  private readonly eventsByUser = new Map<string, number[]>();

  constructor(options: ConversationRateLimiterOptions = {}) {
    this.maxPerHour = options.maxPerHour ?? CONVERSATION_CREATE_LIMIT_PER_HOUR;
    this.maxPerDay = options.maxPerDay ?? CONVERSATION_CREATE_LIMIT_PER_DAY;
  }

  consume(userId: string, now = new Date()): RateLimitCheck {
    const nowMs = now.getTime();
    const dayCutoff = nowMs - DAY_MS;
    const hourCutoff = nowMs - HOUR_MS;

    const recentDay = (this.eventsByUser.get(userId) ?? []).filter((ts) => ts > dayCutoff);
    const recentHour = recentDay.filter((ts) => ts > hourCutoff);

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
