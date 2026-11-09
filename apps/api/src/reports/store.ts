import {
  APPEAL_WINDOW_DAYS,
  REPORTS_PER_DAY,
  REPORT_DEDUPE_HOURS,
  reportExpiresAt,
  type AppealRecord,
  type AuditEntry,
  type ReportRecord,
  type ReportCreateInput,
} from "@chat/contracts";

/**
 * Report store v0 (P1-18, DEC-008 §4 + DEC-015 §3).
 *
 * - 10 reports/day per reporter; 24h duplicate suppression (409).
 * - Reporter identity is known internally; views never expose it to the
 *   reported user (route redaction enforces this).
 * - `expiresAt` is 90 days after final disposition (TTL, DEC-015).
 * - Production backing is the Mongo `reports`/`moderation_appeals`
 *   collections (P1-04: dedupe/status/TTL indexes).
 */
export type ReportCreateResult =
  | { ok: true; record: ReportRecord }
  | { ok: false; code: "RATE_LIMITED" | "DUPLICATE" | "SELF" };

export interface ReportStore {
  create(reporterUserId: string, input: ReportCreateInput, now?: Date): Promise<ReportCreateResult>;
  getById(reportId: string): Promise<ReportRecord | null>;
  listOwn(reporterUserId: string, limit: number): Promise<ReportRecord[]>;
  queue(limit: number): Promise<ReportRecord[]>;
  appeal(reportId: string, appellantUserId: string, now?: Date): Promise<"OK" | "NOT_FOUND" | "NO_DISPOSITION" | "WINDOW" | "MULTIPLE">;
  dispose(reportId: string, disposition: "warning" | "suspension_7d" | "suspension_30d" | "ban", now?: Date): Promise<"OK" | "NOT_FOUND">;
  audit: AuditEntry[];
  appeals: AppealRecord[];
}

let counter = 0;

export class MemoryReportStore implements ReportStore {
  private readonly reports = new Map<string, ReportRecord>();
  audit: AuditEntry[] = [];
  appeals: AppealRecord[] = [];

  async create(reporterUserId: string, input: ReportCreateInput, now = new Date()): Promise<ReportCreateResult> {
    if (reporterUserId === input.reportedUserId) return { ok: false, code: "SELF" };
    const dayStart = now.getTime() - 24 * 60 * 60 * 1000;
    const mine = [...this.reports.values()].filter(
      (r) => r.reporterUserId === reporterUserId && new Date(r.createdAt).getTime() >= dayStart,
    );
    if (mine.length >= REPORTS_PER_DAY) return { ok: false, code: "RATE_LIMITED" };
    const dedupeCutoff = dayStart;
    const duplicate = [...this.reports.values()].find(
      (r) =>
        r.reporterUserId === reporterUserId &&
        r.reportedUserId === input.reportedUserId &&
        new Date(r.createdAt).getTime() >= dedupeCutoff,
    );
    if (duplicate) return { ok: false, code: "DUPLICATE" };
    counter += 1;
    const record: ReportRecord = {
      reportId: `rep_${counter}`,
      reporterUserId,
      reportedUserId: input.reportedUserId,
      reason: input.reason,
      references: [...input.references],
      excerpts: [...input.excerpts],
      excerptConsent: input.excerptConsent,
      status: "open",
      disposition: null,
      dispositionedAt: null,
      // TTL starts only at final disposition (DEC-015); open reports never expire.
      expiresAt: "",
      createdAt: now.toISOString(),
      appealCount: 0,
    };
    this.reports.set(record.reportId, record);
    this.audit.push({
      action: "report.created",
      actorUserId: reporterUserId,
      targetReportId: record.reportId,
      at: now.toISOString(),
    });
    return { ok: true, record };
  }

  async getById(reportId: string): Promise<ReportRecord | null> {
    return this.reports.get(reportId) ?? null;
  }

  async listOwn(reporterUserId: string, limit: number): Promise<ReportRecord[]> {
    return [...this.reports.values()]
      .filter((r) => r.reporterUserId === reporterUserId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async queue(limit: number): Promise<ReportRecord[]> {
    return [...this.reports.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  async appeal(reportId: string, appellantUserId: string, now = new Date()): Promise<"OK" | "NOT_FOUND" | "NO_DISPOSITION" | "WINDOW" | "MULTIPLE"> {
    const record = this.reports.get(reportId);
    if (!record) return "NOT_FOUND";
    if (record.reportedUserId !== appellantUserId) return "NOT_FOUND";
    if (record.status === "open" || !record.dispositionedAt) return "NO_DISPOSITION";
    if (record.appealCount > 0) return "MULTIPLE";
    const elapsed = now.getTime() - new Date(record.dispositionedAt).getTime();
    if (elapsed > APPEAL_WINDOW_DAYS * 24 * 60 * 60 * 1000) return "WINDOW";
    void appellantUserId;
    record.status = "appealed";
    record.appealCount += 1;
    record.expiresAt = reportExpiresAt(new Date(record.dispositionedAt));
    this.appeals.push({ reportId, appellantUserId, createdAt: now.toISOString() });
    this.audit.push({ action: "report.appealed", actorUserId: appellantUserId, targetReportId: reportId, at: now.toISOString() });
    return "OK";
  }

  async dispose(
    reportId: string,
    disposition: "warning" | "suspension_7d" | "suspension_30d" | "ban",
    now = new Date(),
  ): Promise<"OK" | "NOT_FOUND"> {
    const record = this.reports.get(reportId);
    if (!record) return "NOT_FOUND";
    record.status = "dispositioned";
    record.disposition = disposition;
    record.dispositionedAt = now.toISOString();
    record.expiresAt = reportExpiresAt(now);
    this.audit.push({ action: `report.disposed:${disposition}`, actorUserId: "operator", targetReportId: reportId, at: now.toISOString() });
    return "OK";
  }
}

/** Reporter-facing view: never includes reporter-identity of others. */
export function reporterView(record: ReportRecord): Record<string, unknown> {
  return {
    reportId: record.reportId,
    reportedUserId: record.reportedUserId,
    reason: record.reason,
    status: record.status,
    disposition: record.disposition,
    excerptConsent: record.excerptConsent,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  };
}

/** Reported-user view: only the action taken — no reporter identity/content. */
export function reportedView(record: ReportRecord): Record<string, unknown> {
  return {
    reportId: record.reportId,
    status: record.status,
    disposition: record.disposition,
    expiresAt: record.expiresAt,
  };
}

/** Operator view (restricted): includes excerpts + reporter identity. */
export function operatorView(record: ReportRecord): Record<string, unknown> {
  return {
    reportId: record.reportId,
    reporterUserId: record.reporterUserId,
    reportedUserId: record.reportedUserId,
    reason: record.reason,
    references: record.references,
    excerpts: record.excerpts,
    excerptConsent: record.excerptConsent,
    status: record.status,
    disposition: record.disposition,
    expiresAt: record.expiresAt,
    appealCount: record.appealCount,
  };
}

export { REPORT_DEDUPE_HOURS };
