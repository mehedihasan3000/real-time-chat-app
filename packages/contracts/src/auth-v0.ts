/**
 * Auth contracts v0 (P1-06) — Better Auth in Next.js, 5-min JWT/JWKS.
 * Provisional under DEC-001/DEC-019 (Accepted); no production claim.
 */

export const JWT_LIFETIME_SECONDS = 5 * 60;
export const SESSION_DEFAULT_DAYS = 7;
export const SESSION_REMEMBER_DAYS = 30;
export const SESSION_ABSOLUTE_DAYS = 90;
export const FRESH_SESSION_SECONDS = 15 * 60;
export const SESSION_CACHE_SECONDS = 60;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** Freshness helper: sensitive actions require auth within 15 minutes. */
export function isFreshSession(authenticatedAt: Date, now = new Date()): boolean {
  return now.getTime() - authenticatedAt.getTime() <= FRESH_SESSION_SECONDS * 1000;
}

/** Absolute cap: no session beyond 90 days from initial auth. */
export function exceedsAbsoluteCap(initialAuthenticatedAt: Date, now = new Date()): boolean {
  const days = (now.getTime() - initialAuthenticatedAt.getTime()) / (24 * 60 * 60 * 1000);
  return days > SESSION_ABSOLUTE_DAYS;
}

/** Password policy (DEC-001 §3.5): 12–128 chars, no composition, deny-list. */
export function validatePassword(password: string): { ok: true } | { ok: false; message: string } {
  if (typeof password !== "string") return { ok: false, message: "Password is required." };
  if (password.length < PASSWORD_MIN)
    return { ok: false, message: `Password must be at least ${PASSWORD_MIN} characters.` };
  if (password.length > PASSWORD_MAX)
    return { ok: false, message: `Password must be at most ${PASSWORD_MAX} characters.` };
  const DENIED = new Set(["password12345", "letmein123456", "qwertyuiop12"]);
  if (DENIED.has(password.toLowerCase())) return { ok: false, message: "Password is too common." };
  return { ok: true };
}

/** Recovery is email-only; no SMS/admin bypass exists. */
export const RECOVERY_EMAIL_ONLY = true;
export const RECOVERY_SMS_ENABLED = false;
export const RECOVERY_ADMIN_BYPASS = false;
