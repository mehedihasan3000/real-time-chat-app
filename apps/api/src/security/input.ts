/**
 * Input-validation baseline v0 (P1-13, FR-SEC-014 / TC-SEC-006).
 *
 * Every externally supplied value is validated before it can affect
 * queries, state transitions, or outbound requests. Helpers here cover:
 * - prototype-pollution keys are stripped from request bodies,
 * - query objects are plain (no operator injection leaked to queries),
 * - outbound URLs must be exact origins (no credentials/path).
 */

const PROTO_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** True when the value is a plain JSON-style object (not null/array/class). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Shallow strip of prototype-pollution keys (mass-assignment guard). */
export function stripProtoKeys(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (PROTO_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Reject operator-style query keys (`$ne`, `__proto__`, etc.) before they
 * can reach a query builder. Returns the offending key or null.
 */
export function findOperatorKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findOperatorKey(item);
      if (found) return found;
    }
    return null;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (PROTO_KEYS.has(key) || key.startsWith("$")) return key;
      const found = findOperatorKey(entry);
      if (found) return found;
    }
  }
  return null;
}

/** Exact-origin check for outbound URLs (no credentials, path, query). */
export function isExactOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}
