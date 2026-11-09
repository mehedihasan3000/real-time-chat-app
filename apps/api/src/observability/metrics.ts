/**
 * Operational metrics v0 (P1-12, OPS-011).
 *
 * In-memory counters + duration summaries with no content labels.
 * Labels are limited to `component`, `method`, and `statusClass` — never
 * user IDs, message content, tokens, or per-resource IDs (no
 * high-cardinality labels). The snapshot is the operator-only metrics
 * surface (`GET /api/v1/metrics`); production aggregation/retention
 * (raw 30d / aggregates 90d) is P6-06.
 */
export interface DurationBucket {
  count: number;
  sumMs: number;
  minMs: number | null;
  maxMs: number | null;
}

export interface MetricsSnapshot {
  counters: Record<string, number>;
  durations: Record<string, DurationBucket>;
}

function counterKey(name: string, tags: Record<string, string>): string {
  const suffix = Object.keys(tags)
    .sort()
    .map((k) => `${k}=${tags[k]}`)
    .join(",");
  return suffix ? `${name}{${suffix}}` : name;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly durations = new Map<string, DurationBucket>();

  inc(name: string, tags: Record<string, string> = {}): void {
    const key = counterKey(name, tags);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  observeDuration(name: string, durationMs: number, tags: Record<string, string> = {}): void {
    const key = counterKey(name, tags);
    const bucket = this.durations.get(key) ?? {
      count: 0,
      sumMs: 0,
      minMs: null,
      maxMs: null,
    };
    bucket.count += 1;
    bucket.sumMs += durationMs;
    bucket.minMs = bucket.minMs === null ? durationMs : Math.min(bucket.minMs, durationMs);
    bucket.maxMs = bucket.maxMs === null ? durationMs : Math.max(bucket.maxMs, durationMs);
    this.durations.set(key, bucket);
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      durations: Object.fromEntries(this.durations),
    };
  }

  reset(): void {
    this.counters.clear();
    this.durations.clear();
  }
}

/** Status class label (no exact status or path leaks). */
export function statusClass(status: number): string {
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "other";
}
