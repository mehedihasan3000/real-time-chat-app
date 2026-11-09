/**
 * Profiles + discovery contracts v0 (P1-17, DEC-020).
 *
 * Username/display policies are shared so web and API apply identical
 * rules. Provisional under Release-gated DEC-023. Discovery and public
 * profile views return ONLY `userId`, `username`, `displayName`, and
 * `avatar: null` (generated fallback, DEC-027) — never email, presence,
 * counts, or any private field.
 */
import type { ValidationResult } from "./v0.js";

/* -------------------------------- Username ------------------------------- */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;
const USERNAME_RE = /^[a-z][a-z0-9_]{2,23}$/;
export const RESERVED_USERNAMES = new Set(["admin", "support", "system"]);

/** Normalize exactly as the server persists: lowercase ASCII only. */
export function normalizeUsername(input: string): string {
  return input.toLowerCase();
}

export function validateUsername(input: unknown): ValidationResult<string> {
  if (typeof input !== "string") {
    return invalidUsername("Username is required.");
  }
  const normalized = normalizeUsername(input);
  if (!USERNAME_RE.test(normalized) || RESERVED_USERNAMES.has(normalized)) {
    return invalidUsername(
      "Username must be 3-24 lowercase letters, digits, or underscores, starting with a letter.",
    );
  }
  return { ok: true, value: normalized };
}

function invalidUsername(message: string): ValidationResult<string> {
  return { ok: false, code: "INVALID_REQUEST", message, retryable: false };
}

/* ------------------------------- Display name ---------------------------- */

export const DISPLAY_NAME_MIN = 1;
export const DISPLAY_NAME_MAX = 50;

export function validateDisplayName(input: unknown): ValidationResult<string> {
  if (typeof input !== "string") {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Display name is required.",
      retryable: false,
    };
  }
  // Count Unicode code points (grapheme-ish; handles Bengali/emoji).
  const length = [...input].length;
  if (length < DISPLAY_NAME_MIN || length > DISPLAY_NAME_MAX) {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      message: "Display name must be 1-50 characters.",
      retryable: false,
    };
  }
  return { ok: true, value: input };
}

/* --------------------------------- Profiles ------------------------------ */

/** Own profile (authenticated view): includes locale/timeZone prefs. */
export interface ProfileResponse {
  userId: string;
  username: string;
  displayName: string;
  avatar: null;
  locale: "en" | "bn";
  timeZone: string;
}

/** Public profile (discovery result): minimal fields only. */
export interface PublicProfile {
  userId: string;
  username: string;
  displayName: string;
  avatar: null;
}

export const PROFILE_PUBLIC_FIELDS = ["userId", "username", "displayName", "avatar"] as const;

/* --------------------------------- Avatar -------------------------------- */

export interface GeneratedAvatar {
  /** First grapheme (code point) of display name (or username). */
  initial: string;
  /** Deterministic hue 0-359 from the opaque userId. */
  hue: number;
}

/** Deterministic generated-initials avatar (DEC-027): same userId → same color. */
export function generatedAvatar(
  userId: string,
  displayName: string,
  username: string,
): GeneratedAvatar {
  const source = [...displayName][0] ?? [...username][0] ?? "?";
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { initial: source, hue: hash % 360 };
}
