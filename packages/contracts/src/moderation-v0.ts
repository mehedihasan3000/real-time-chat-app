/**
 * Blocking/reporting/moderation contracts v0 (P1-18, DEC-008).
 *
 * Silent bilateral blocking, consented report excerpts, operator-only
 * dispositions, one appeal, 90-day report retention, no plaintext scanning.
 * Provisional under Release-gated DEC-023/DEC-026.
 */
import type { ValidationResult } from "./v0.js";

export const BLOCK_MAX = 50;
export const REPORTS_PER_DAY = 10;
export const REPORT_DEDUPE_HOURS = 24;
export const REPORT_REFERENCES_MAX = 5;
export const REPORT_EXCERPTS_MAX = 5;
export const EXCERPT_CODEPOINT_MAX = 2000;
export const APPEAL_WINDOW_DAYS = 7;
export const REPORT_TTL_DAYS = 90;

export const REPORT_REASONS = ["spam", "harassment", "impersonation", "illegal", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const DISPOSITIONS = ["warning", "suspension_7d", "suspension_30d", "ban"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const REPORT_STATUSES = ["open", "dispositioned", "appealed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export interface BlockRecord {
  blockerUserId: string;
  blockedUserId: string;
  createdAt: string;
}

export interface ReportRecord {
  reportId: string;
  reporterUserId: string;
  reportedUserId: string;
  reason: ReportReason;
  references: string[];
  excerpts: string[];
  excerptConsent: boolean;
  status: ReportStatus;
  disposition: Disposition | null;
  dispositionedAt: string | null;
  expiresAt: string;
  createdAt: string;
  appealCount: number;
}

export interface AppealRecord {
  reportId: string;
  appellantUserId: string;
  createdAt: string;
}

export interface AuditEntry {
  action: string;
  actorUserId: string;
  targetReportId: string | null;
  at: string;
}

export function validateBlockCreate(input: unknown): ValidationResult<{ blockedUserId: string }> {
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const id = body.blockedUserId;
  if (typeof id !== "string" || id.length === 0) {
    return invalid("blockedUserId is required.");
  }
  return { ok: true, value: { blockedUserId: id } };
}

export interface ReportCreateInput {
  reportedUserId: string;
  reason: ReportReason;
  references: string[];
  excerpts: string[];
  excerptConsent: boolean;
}

export function validateReportCreate(input: unknown): ValidationResult<ReportCreateInput> {
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  if (typeof body.reportedUserId !== "string" || body.reportedUserId.length === 0) {
    return invalid("reportedUserId is required.");
  }
  if (
    typeof body.reason !== "string" ||
    !(REPORT_REASONS as readonly string[]).includes(body.reason)
  ) {
    return invalid("reason must be an approved report reason.");
  }
  const references = Array.isArray(body.optionalReferences) ? body.optionalReferences : [];
  const excerpts = Array.isArray(body.optionalExcerpts) ? body.optionalExcerpts : [];
  for (const ref of references) {
    if (typeof ref !== "string" || ref.length === 0)
      return invalid("References must be opaque IDs.");
  }
  if (references.length > REPORT_REFERENCES_MAX) {
    return invalid(`At most ${REPORT_REFERENCES_MAX} references per report.`);
  }
  for (const excerpt of excerpts) {
    if (typeof excerpt !== "string") return invalid("Excerpts must be strings.");
    if ([...excerpt].length > EXCERPT_CODEPOINT_MAX) {
      return invalid(`Excerpts must be ≤ ${EXCERPT_CODEPOINT_MAX} characters each.`);
    }
  }
  if (excerpts.length > REPORT_EXCERPTS_MAX) {
    return invalid(`At most ${REPORT_EXCERPTS_MAX} excerpts per report.`);
  }
  const consent = body.excerptConsent === true;
  if (excerpts.length > 0 && !consent) {
    return invalid("Excerpts require explicit per-report consent.");
  }
  return {
    ok: true,
    value: {
      reportedUserId: body.reportedUserId,
      reason: body.reason as ReportReason,
      references: references as string[],
      excerpts: excerpts as string[],
      excerptConsent: consent,
    },
  };
}

export function validateDisposition(input: unknown): ValidationResult<Disposition> {
  if (typeof input !== "string" || !(DISPOSITIONS as readonly string[]).includes(input)) {
    return invalid("disposition must be an approved moderation action.");
  }
  return { ok: true, value: input as Disposition };
}

/** TTL: 90 days after final disposition (DEC-015). */
export function reportExpiresAt(dispositionedAt: Date): string {
  return new Date(dispositionedAt.getTime() + REPORT_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function invalid(message: string): ValidationResult<never> {
  return { ok: false, code: "INVALID_REQUEST", message, retryable: false };
}
