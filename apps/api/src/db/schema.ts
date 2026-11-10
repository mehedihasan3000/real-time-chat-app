/**
 * Data layer v0 — MongoDB schema and index catalogue (DEC-023, Release-gated).
 *
 * This module is the single source of truth for v0 collections, indexes,
 * TTLs, query bounds, and release-gated fields. It contains no runtime
 * queries; `migrate.ts` applies these indexes. All documents carry
 * `schemaVersion: 1` and synthetic fixtures only in tests.
 *
 * Better Auth adapter collections (`user`, `session`, `account`,
 * `verification`) are library-managed by P1-06; indexes listed here for
 * those names ensure uniqueness after the adapter creates them, but the
 * adapter owns their lifecycle. See `docs/data-durability-contracts.md` §9.4.
 */

export const SCHEMA_VERSION = 1;

/** Cursor page bounds (DEC-023 §7): default 50, max 100. */
export const PAGE_DEFAULT = 50;
export const PAGE_MAX = 100;

/** Enforce cursor bounds; throw on unbounded or over-max limits. */
export function clampPageLimit(requested: number | undefined): number {
  if (requested === undefined) return PAGE_DEFAULT;
  if (!Number.isInteger(requested) || requested < 1 || requested > PAGE_MAX) {
    throw new Error(`Invalid page limit: must be an integer in 1..${PAGE_MAX}`);
  }
  return requested;
}

/** Deterministic sorted pair key for one-thread-per-pair (DEC-023 §9.1). */
export function pairKeyFor(a: string, b: string): string {
  if (a === b || a.length === 0 || b.length === 0) {
    throw new Error("pairKey requires two distinct non-empty user IDs");
  }
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Fields whose final shape is Release-gated (DEC-023). v0 may include them
 * provisionally but must record them explicitly; no irreversible lock.
 */
export const RELEASE_GATED_FIELDS = [
  "pairKey encoding",
  "payloadHash canonicalization",
  "protocolVersion allowlist",
  "encryptedEnvelope bounds (DEC-016)",
  "call schema fields (DEC-022)",
  "locale/timeZone profile storage",
  "device key bundle fields (DEC-018; provisional dev-webcrypto-v0)",
] as const;

export interface IndexSpec {
  /** Collection name. */
  collection: string;
  /** Index name (stable, stored in Mongo). */
  name: string;
  key: Record<string, 1 | -1>;
  unique?: boolean;
  partialFilterExpression?: Record<string, unknown>;
  expireAfterSeconds?: number;
}

/** All v0 collections, including required blocks/reports/moderation/key-backups/deletion journal. */
export const COLLECTIONS = [
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
  "device_audit",
  "schema_migrations",
] as const;

export type CollectionName = (typeof COLLECTIONS)[number];

/**
 * Approved indexes per `docs/data-durability-contracts.md` §9 and linked
 * briefs. Names are stable; re-running `createIndexes` is idempotent.
 */
export const INDEXES: IndexSpec[] = [
  // users / profiles (DEC-023 §10.2 locale/timeZone on profile)
  { collection: "users", name: "uniq_username", key: { username: 1 }, unique: true },
  { collection: "users", name: "uniq_email", key: { email: 1 }, unique: true },
  // devices (DEC-018: one active device ref per user session)
  {
    collection: "devices",
    name: "uniq_device",
    key: { userId: 1, deviceId: 1 },
    unique: true,
  },
  {
    collection: "devices",
    name: "device_active_lookup",
    key: { userId: 1, isActive: 1 },
  },
  {
    collection: "devices",
    name: "uniq_active_device_per_user",
    key: { userId: 1 },
    unique: true,
    partialFilterExpression: { isActive: true },
  },
  // device audit (DEC-004: enrollment/replacement/revocation evidence; no keys)
  {
    collection: "device_audit",
    name: "device_audit_user",
    key: { userId: 1, at: -1 },
  },
  {
    collection: "device_audit",
    name: "device_audit_device",
    key: { userId: 1, deviceId: 1, at: -1 },
  },
  // conversations (DEC-023 §9.1)
  { collection: "conversations", name: "uniq_pairKey", key: { pairKey: 1 }, unique: true },
  {
    collection: "conversations",
    name: "conversation_listing",
    key: { participantIds: 1, lastActivityAt: -1, _id: -1 },
  },
  // messages (DEC-023 §9.2) — immutable, no TTL
  {
    collection: "messages",
    name: "uniq_conversation_seq",
    key: { conversationId: 1, seq: 1 },
    unique: true,
  },
  {
    collection: "messages",
    name: "uniq_idempotency",
    key: { senderUserId: 1, senderDeviceId: 1, clientMessageId: 1 },
    unique: true,
  },
  { collection: "messages", name: "history_seq_desc", key: { conversationId: 1, seq: -1 } },
  // receipts + read progress (DEC-020 §9.3)
  {
    collection: "receipts",
    name: "uniq_receipt",
    key: { messageId: 1, recipientUserId: 1 },
    unique: true,
  },
  {
    collection: "read_progress",
    name: "uniq_read_progress",
    key: { conversationId: 1, userId: 1 },
    unique: true,
  },
  // calls (DEC-022 §9.5 in brief / P0-07 spike)
  { collection: "calls", name: "uniq_callId", key: { callId: 1 }, unique: true },
  {
    collection: "calls",
    name: "uniq_active_call_per_conversation",
    key: { conversationId: 1 },
    unique: true,
    partialFilterExpression: { isActive: true },
  },
  {
    collection: "calls",
    name: "uniq_active_call_per_user",
    key: { participantIds: 1 },
    unique: true,
    partialFilterExpression: { isActive: true },
  },
  {
    collection: "calls",
    name: "uniq_invite_idempotency",
    key: { callerUserId: 1, clientRequestId: 1 },
    unique: true,
    partialFilterExpression: { clientRequestId: { $exists: true } },
  },
  { collection: "calls", name: "call_history", key: { participantIds: 1, startedAt: -1, _id: -1 } },
  { collection: "calls", name: "call_ttl_90d", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  // key backups (DEC-003/DEC-004: encrypted archive, rotation)
  {
    collection: "key_backups",
    name: "uniq_key_backup",
    key: { userId: 1, backupId: 1 },
    unique: true,
  },
  {
    collection: "key_backups",
    name: "key_backup_kid",
    key: { userId: 1, kid: 1 },
    unique: true,
  },
  // blocks (DEC-008: unique pair, reverse-enforcement, private list; no history)
  {
    collection: "blocks",
    name: "uniq_block_pair",
    key: { blockerUserId: 1, blockedUserId: 1 },
    unique: true,
  },
  {
    collection: "blocks",
    name: "block_reverse_lookup",
    key: { blockedUserId: 1, blockerUserId: 1 },
  },
  {
    collection: "blocks",
    name: "block_list_private",
    key: { blockerUserId: 1, createdAt: -1 },
  },
  // reports (DEC-008: reporter known, dedupe 24h, 90d after disposition, TTL on expiresAt)
  {
    collection: "reports",
    name: "report_reporter_queue",
    key: { reporterUserId: 1, createdAt: -1 },
  },
  {
    collection: "reports",
    name: "report_reported_lookup",
    key: { reportedUserId: 1, createdAt: -1 },
  },
  {
    collection: "reports",
    name: "report_dedupe_24h",
    key: { reporterUserId: 1, reportedUserId: 1, createdAt: -1 },
  },
  {
    collection: "reports",
    name: "report_status_queue",
    key: { status: 1, createdAt: 1 },
  },
  { collection: "reports", name: "report_ttl_90d", key: { expiresAt: 1 }, expireAfterSeconds: 0 },
  // moderation + appeals (DEC-008: one appeal in 7d)
  {
    collection: "moderation_appeals",
    name: "uniq_appeal_per_report",
    key: { reportId: 1 },
    unique: true,
  },
  {
    collection: "moderation_appeals",
    name: "appeal_window",
    key: { reportId: 1, createdAt: -1 },
  },
  // AI metadata (DEC-006/007: consent + requests, 30d TTL)
  {
    collection: "ai_consent",
    name: "uniq_ai_consent",
    key: { userId: 1, operation: 1 },
    unique: true,
  },
  {
    collection: "ai_requests",
    name: "ai_request_user_day",
    key: { userId: 1, createdAt: -1 },
  },
  {
    collection: "ai_requests",
    name: "ai_request_ttl_30d",
    key: { expiresAt: 1 },
    expireAfterSeconds: 0,
  },
  // deletion journal (DEC-025/Data-012: in-DB journal, replay)
  {
    collection: "deletion_journal",
    name: "uniq_deletion_entry",
    key: { entryId: 1 },
    unique: true,
  },
  {
    collection: "deletion_journal",
    name: "deletion_target_lookup",
    key: { targetUserId: 1, createdAt: -1 },
  },
  {
    collection: "deletion_journal",
    name: "deletion_ttl",
    key: { expiresAt: 1 },
    expireAfterSeconds: 0,
  },
  // migrations ledger
  {
    collection: "schema_migrations",
    name: "uniq_migration_version",
    key: { version: 1 },
    unique: true,
  },
];

export function indexesFor(collection: string): IndexSpec[] {
  return INDEXES.filter((spec) => spec.collection === collection);
}
