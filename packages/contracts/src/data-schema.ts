/**
 * Shared data-schema constants (P1-04). The API `schema.ts` is the source of
 * truth for index options; this file exposes only stable cross-package
 * constants (version, collections, bounds, release-gated fields) so web and
 * tests do not duplicate them.
 */
export const schemaVersion = 1;

/** Cursor page bounds (DEC-023 §7): default 50, max 100. */
export const pageBounds = { default: 50, max: 100 } as const;

export const dataCollections = [
  "users",
  "devices",
  "conversations",
  "messages",
  "receipts",
  "read_progress",
  "calls",
  "key_backups",
  "blocks",
  "reports",
  "moderation_appeals",
  "ai_consent",
  "ai_requests",
  "deletion_journal",
  "schema_migrations",
] as const;

export const releaseGatedFields = [
  "pairKey encoding",
  "payloadHash canonicalization",
  "protocolVersion allowlist",
  "encryptedEnvelope bounds (DEC-016)",
  "call schema fields (DEC-022)",
  "locale/timeZone profile storage",
] as const;
