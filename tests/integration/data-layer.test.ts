import { describe, expect, it } from "vitest";

import { applyIndexes, runMigrations, type DbLike } from "../../apps/api/src/db/migrate.js";
import {
  COLLECTIONS,
  INDEXES,
  PAGE_DEFAULT,
  PAGE_MAX,
  RELEASE_GATED_FIELDS,
  SCHEMA_VERSION,
  clampPageLimit,
  pairKeyFor,
} from "../../apps/api/src/db/schema.js";

/**
 * In-memory fake Db — records createIndexes calls so migration tests run
 * without a live MongoDB (synthetic, no real data). Proves: schema applies
 * cleanly (no throw) from an empty DB, idempotency, and index inventory.
 */
function fakeDb() {
  const calls: Array<{ collection: string; count: number }> = [];
  const collections = new Map<string, { indexes: unknown[]; docs: unknown[] }>();
  const ledger: { docs: Array<Record<string, unknown>> } = { docs: [] };
  const db = {
    collection(name: string) {
      if (!collections.has(name)) {
        collections.set(name, { indexes: [], docs: [] });
      }
      const store = collections.get(name)!;
      return {
        async createIndexes(specs: unknown[]) {
          store.indexes.push(...specs);
          calls.push({ collection: name, count: specs.length });
          return specs as string[];
        },
        async createIndex(): Promise<string> {
          throw new Error("createIndex should not be used by batch migrate");
        },
      };
    },
  } as unknown as DbLike;
  // Attach fake ledger behavior for runMigrations via monkey-patched collection
  const anyDb = db as unknown as Record<string, unknown>;
  const original = db.collection;
  anyDb.collection = (name: string) => {
    if (name === "schema_migrations") {
      return {
        async createIndexes(specs: unknown[]) {
          calls.push({ collection: name, count: specs.length });
          return specs as string[];
        },
        async createIndex(): Promise<string> {
          throw new Error("unused");
        },
        async findOne() {
          return ledger.docs[0] ?? null;
        },
        async insertOne(doc: Record<string, unknown>) {
          // Unique version guard mirrors Mongo unique index behavior
          if (ledger.docs.some((d) => d.version === doc.version)) {
            throw new Error("E11000 duplicate key error");
          }
          ledger.docs.push(doc);
          return { acknowledged: true };
        },
      };
    }
    return original(name);
  };
  return { db, calls, collections, ledger };
}

describe("data layer v0 (P1-04)", () => {
  it("defines every required collection including blocks/reports/appeals/key-backups/journal", () => {
    for (const required of [
      "conversations",
      "messages",
      "receipts",
      "calls",
      "blocks",
      "reports",
      "moderation_appeals",
      "key_backups",
      "deletion_journal",
      "schema_migrations",
    ]) {
      expect(COLLECTIONS).toContain(required);
    }
    expect(SCHEMA_VERSION).toBe(1);
    expect(RELEASE_GATED_FIELDS.length).toBeGreaterThan(0);
  });

  it("applies cleanly from an empty database and is idempotent", async () => {
    const first = fakeDb();
    await applyIndexes(first.db);
    const firstCount = first.calls.reduce((n, c) => n + c.count, 0);
    expect(firstCount).toBe(INDEXES.length);

    // Re-run: no error (idempotent)
    await applyIndexes(first.db);
    expect(first.calls.length).toBeGreaterThan(0);

    // Migration ledger: first run applies, second is a no-op
    const second = fakeDb();
    const r1 = await runMigrations(second.db as never);
    const r2 = await runMigrations(second.db as never);
    expect(r1).toEqual({ applied: true, version: 1 });
    expect(r2).toEqual({ applied: false, version: 1 });
    expect(second.ledger.docs).toHaveLength(1);
  });

  it("enforces one-thread-per-pair uniqueness (pairKey)", () => {
    expect(pairKeyFor("b-user", "a-user")).toBe("a-user:b-user");
    expect(pairKeyFor("a-user", "b-user")).toBe("a-user:b-user");
    expect(() => pairKeyFor("a-user", "a-user")).toThrow();
    // Index exists and is unique
    const pairIndex = INDEXES.find((i) => i.name === "uniq_pairKey");
    expect(pairIndex?.unique).toBe(true);
    expect(pairIndex?.key).toEqual({ pairKey: 1 });
  });

  it("enforces message ordering + idempotency uniqueness", () => {
    const seq = INDEXES.find((i) => i.name === "uniq_conversation_seq");
    const idem = INDEXES.find((i) => i.name === "uniq_idempotency");
    expect(seq?.unique).toBe(true);
    expect(idem?.unique).toBe(true);
    expect(idem?.key).toEqual({ senderUserId: 1, senderDeviceId: 1, clientMessageId: 1 });
  });

  it("bounds cursor pages to 50/100 (query-bound)", () => {
    expect(clampPageLimit(undefined)).toBe(PAGE_DEFAULT);
    expect(clampPageLimit(50)).toBe(50);
    expect(clampPageLimit(100)).toBe(PAGE_MAX);
    expect(() => clampPageLimit(0)).toThrow();
    expect(() => clampPageLimit(101)).toThrow();
    expect(() => clampPageLimit(1.5)).toThrow();
    // History index exists for bounded scans
    expect(INDEXES.some((i) => i.name === "history_seq_desc")).toBe(true);
  });

  it("includes approved TTLs and never TTLs message history", () => {
    const ttls = INDEXES.filter((i) => i.expireAfterSeconds !== undefined);
    const names = ttls.map((i) => i.name);
    expect(names).toContain("call_ttl_90d");
    expect(names).toContain("report_ttl_90d");
    expect(names).toContain("ai_request_ttl_30d");
    expect(names).toContain("deletion_ttl");
    // Messages have no TTL
    expect(
      INDEXES.filter((i) => i.collection === "messages" && i.expireAfterSeconds !== undefined),
    ).toHaveLength(0);
  });

  it("records block/report uniqueness for enforcement", () => {
    expect(INDEXES.find((i) => i.name === "uniq_block_pair")?.unique).toBe(true);
    expect(INDEXES.find((i) => i.name === "uniq_appeal_per_report")?.unique).toBe(true);
    expect(INDEXES.find((i) => i.name === "uniq_key_backup")?.unique).toBe(true);
    expect(INDEXES.find((i) => i.name === "uniq_deletion_entry")?.unique).toBe(true);
  });
});
