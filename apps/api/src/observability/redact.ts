/**
 * Redaction baseline v0 (P1-12, FR-SEC-023 / NFR-MAINT-002).
 *
 * Logs, traces, metrics, and error output must never contain ordinary
 * message plaintext, AI plaintext, report excerpts, private keys, tokens,
 * or credentials. This module is the single scrub point for API logging.
 * Keys are matched case-insensitively; values matching secret patterns
 * are replaced regardless of key.
 */

export const REDACTED = "[REDACTED]" as const;

/** Object keys whose values are always redacted (case-insensitive). */
export const REDACTED_KEYS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "token",
  "password",
  "passphrase",
  "secret",
  "apikey",
  "api_key",
  "access_token",
  "refresh_token",
  "jwt",
  "session_cookie",
  "ciphertext",
  "encryptedenvelope",
  "envelope",
  "plaintext",
  "message",
  "body",
  "excerpt",
  "excerpts",
  "prompt",
  "sdp",
  "ice_candidate",
  "icecandidate",
  "candidate",
  "privatekey",
  "private_key",
  "recovery_key",
  "recoverykey",
  "seed",
  "credential",
  "turn_credential",
]);

/** Value patterns that are secrets regardless of the enclosing key. */
const VALUE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._-]+/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/, // JWT
  /mongodb(?:\+srv)?:\/\/[^\s"']+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
];

export function isRedactedKey(key: string): boolean {
  return REDACTED_KEYS.has(key.toLowerCase());
}

/** Redact a single value if it looks like a secret. */
export function redactValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  let out = value;
  for (const pattern of VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Deep-redact an object for safe logging. Circular references become
 * "[CIRCULAR]" so the logger can never throw or recurse forever.
 */
export function redactObject(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return redactValue(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item, new Set(seen)));
  }
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    out[key] = isRedactedKey(key) ? REDACTED : redactObject(entry, new Set(seen));
  }
  return out;
}

/**
 * Marker audit helper: true when a string contains a secret pattern.
 * Used by tests to assert synthetic markers are absent everywhere.
 */
export function containsSecretPattern(text: string): boolean {
  for (const pattern of VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}
