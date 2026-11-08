import type { Db } from "mongodb";

import { INDEXES, SCHEMA_VERSION, type IndexSpec } from "./schema.js";

/**
 * Minimal Db/Collection surface used by the migration runner. Keeping the
 * interface narrow allows unit tests with an in-memory fake (no live Mongo
 * required) while remaining compatible with the real driver.
 */
export interface CollectionLike {
  createIndexes(specs: IndexSpec[]): Promise<string[]>;
  createIndex(key: IndexSpec["key"], options: Record<string, unknown>): Promise<string>;
}

export interface DbLike {
  collection(name: string): CollectionLike;
}

/**
 * Apply all v0 indexes. Idempotent: safe to re-run; existing indexes with the
 * same name/key are no-ops in MongoDB.
 */
export async function applyIndexes(db: DbLike): Promise<void> {
  const byCollection = new Map<string, IndexSpec[]>();
  for (const spec of INDEXES) {
    const list = byCollection.get(spec.collection) ?? [];
    list.push(spec);
    byCollection.set(spec.collection, list);
  }
  for (const [collection, specs] of byCollection) {
    await db.collection(collection).createIndexes(specs);
  }
}

export interface MigrationRecord {
  version: number;
  name: string;
  appliedAt: Date;
  schemaVersion: number;
}

/**
 * Run the v0 migration ledger: apply indexes, then record version 1.
 * Idempotent — if version 1 is already recorded, indexes are still
 * ensured (safe) and no duplicate ledger row is created.
 */
export async function runMigrations(
  db: Db & { collection(name: "schema_migrations"): unknown },
  now = new Date(),
): Promise<{ applied: boolean; version: number }> {
  await applyIndexes(db);
  const ledger = db.collection("schema_migrations") as unknown as {
    findOne(filter: Record<string, unknown>): Promise<MigrationRecord | null>;
    insertOne(doc: MigrationRecord): Promise<unknown>;
  };
  const existing = await ledger.findOne({ version: 1 });
  if (existing) return { applied: false, version: 1 };
  await ledger.insertOne({
    version: 1,
    name: "v0001_initial",
    appliedAt: now,
    schemaVersion: SCHEMA_VERSION,
  });
  return { applied: true, version: 1 };
}
