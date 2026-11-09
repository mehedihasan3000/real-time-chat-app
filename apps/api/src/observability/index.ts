/**
 * Observability baseline v0 (P1-12).
 *
 * Structured redacted logs, correlation IDs, operational metrics, and
 * safe error mapping. No plaintext, tokens, or secrets ever reach logs,
 * traces, or error output (FR-SEC-023 / NFR-MAINT-002).
 */
export * from "./redact.js";
export * from "./logger.js";
export * from "./metrics.js";
export * from "./correlation.js";
export * from "./safe-error.js";
