/**
 * Browser telemetry redaction v0 (P1-12, FR-SEC-023).
 *
 * The web client never logs message plaintext, AI plaintext, report
 * excerpts, tokens, or credentials — this module is the scrub point for
 * client-side error reporting.
 */
export const REDACTED = "[REDACTED]" as const;

const REDACTED_KEYS = new Set([
  "authorization",
  "cookie",
  "token",
  "password",
  "secret",
  "ciphertext",
  "encryptedenvelope",
  "message",
  "body",
  "excerpt",
  "excerpts",
  "prompt",
  "privatekey",
  "credential",
]);

const VALUE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._-]+/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /mongodb(?:\+srv)?:\/\/[^\s"']+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9]{8,}\b/g,
];

export function redactClientValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  let out = value;
  for (const pattern of VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function redactClientObject(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return redactClientValue(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactClientObject(item, new Set(seen)));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase())
      ? REDACTED
      : redactClientObject(entry, new Set(seen));
  }
  return out;
}

export function containsClientSecretPattern(text: string): boolean {
  for (const pattern of VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}
