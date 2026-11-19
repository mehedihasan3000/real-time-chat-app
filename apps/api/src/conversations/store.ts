import { randomUUID } from "node:crypto";

import {
  CONVERSATION_SCHEMA_VERSION,
  canonicalConversationPair,
  encodeConversationCursor,
  isOpaqueId,
  type ConversationListQuery,
} from "@chat/contracts";

/**
 * Conversation store v0 (P2-03, FR-CHAT-001, FR-HIST-001, DATA-002; DEC-023 §9.1).
 *
 * Provisional under Release-gated DEC-023:
 * - Enforces one immutable direct conversation per unordered pair of distinct
 *   eligible users (`unique pairKey`, `participantIds.length === 2`).
 * - Concurrent creation attempts for the same `(a, b)` or `(b, a)` pair
 *   resolve to the single canonical conversation record.
 * - Listing is participant-scoped only, bounded (default 50 / max 100), and
 *   ordered deterministically by `(lastActivityAt desc, id desc)`.
 */
export interface ConversationRecord {
  id: string;
  pairKey: string;
  participantIds: [string, string];
  lastSeq: number;
  createdAt: string;
  lastActivityAt: string;
  schemaVersion: 1;
}

export interface ConversationListResult {
  items: ConversationRecord[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ConversationUpsertResult {
  conversation: ConversationRecord;
  created: boolean;
}

export interface ConversationStore {
  upsertDirect(userA: string, userB: string, now?: Date): Promise<ConversationUpsertResult>;
  getById(conversationId: string): Promise<ConversationRecord | null>;
  getByPair(userA: string, userB: string): Promise<ConversationRecord | null>;
  listForUser(userId: string, query: ConversationListQuery): Promise<ConversationListResult>;
  reserveNextSeq(
    conversationId: string,
    participantUserId: string,
    now?: Date,
  ): Promise<number | null>;
}

export interface MemoryConversationStoreOptions {
  /** Optional test hook executed inside the pair critical section before insert. */
  beforeInsertHook?: (pairKey: string) => Promise<void> | void;
  idGenerator?: () => string;
}

function cloneRecord(record: ConversationRecord): ConversationRecord {
  assertTwoDistinctParticipants(record.participantIds);
  return {
    ...record,
    participantIds: [record.participantIds[0], record.participantIds[1]],
  };
}

export function assertTwoDistinctParticipants(
  participantIds: readonly string[],
): asserts participantIds is [string, string] {
  if (
    participantIds.length !== 2 ||
    !isOpaqueId(participantIds[0]) ||
    !isOpaqueId(participantIds[1]) ||
    participantIds[0] === participantIds[1]
  ) {
    throw new Error("Conversation invariant violated: requires exactly two distinct participants.");
  }
}

export function compareConversationsDesc(a: ConversationRecord, b: ConversationRecord): number {
  if (a.lastActivityAt !== b.lastActivityAt) {
    return a.lastActivityAt > b.lastActivityAt ? -1 : 1;
  }
  if (a.id !== b.id) {
    return a.id > b.id ? -1 : 1;
  }
  return 0;
}

export class MemoryConversationStore implements ConversationStore {
  private readonly byId = new Map<string, ConversationRecord>();
  private readonly byPairKey = new Map<string, ConversationRecord>();
  private readonly inFlightByPair = new Map<string, Promise<unknown>>();
  private readonly beforeInsertHook?: (pairKey: string) => Promise<void> | void;
  private readonly idGenerator: () => string;

  constructor(options: MemoryConversationStoreOptions = {}) {
    this.beforeInsertHook = options.beforeInsertHook;
    this.idGenerator = options.idGenerator ?? (() => `conv_${randomUUID()}`);
  }

  async upsertDirect(
    userA: string,
    userB: string,
    now = new Date(),
  ): Promise<ConversationUpsertResult> {
    const { pairKey, participantIds } = canonicalConversationPair(userA, userB);

    const runLocked = async (): Promise<ConversationUpsertResult> => {
      const existing = this.byPairKey.get(pairKey);
      if (existing) {
        return { conversation: cloneRecord(existing), created: false };
      }

      if (this.beforeInsertHook) {
        await this.beforeInsertHook(pairKey);
        const raced = this.byPairKey.get(pairKey);
        if (raced) {
          return { conversation: cloneRecord(raced), created: false };
        }
      }

      const timestamp = now.toISOString();
      const record: ConversationRecord = {
        id: this.idGenerator(),
        pairKey,
        participantIds: [participantIds[0], participantIds[1]],
        lastSeq: 0,
        createdAt: timestamp,
        lastActivityAt: timestamp,
        schemaVersion: CONVERSATION_SCHEMA_VERSION,
      };
      this.byId.set(record.id, record);
      this.byPairKey.set(record.pairKey, record);
      return { conversation: cloneRecord(record), created: true };
    };

    const previous = this.inFlightByPair.get(pairKey) ?? Promise.resolve();
    const nextPromise = previous.then(runLocked, runLocked);
    this.inFlightByPair.set(pairKey, nextPromise);
    try {
      return await nextPromise;
    } finally {
      if (this.inFlightByPair.get(pairKey) === nextPromise) {
        this.inFlightByPair.delete(pairKey);
      }
    }
  }

  async getById(conversationId: string): Promise<ConversationRecord | null> {
    const record = this.byId.get(conversationId);
    return record ? cloneRecord(record) : null;
  }

  async getByPair(userA: string, userB: string): Promise<ConversationRecord | null> {
    if (!isOpaqueId(userA) || !isOpaqueId(userB) || userA === userB) {
      return null;
    }
    const { pairKey } = canonicalConversationPair(userA, userB);
    const record = this.byPairKey.get(pairKey);
    return record ? cloneRecord(record) : null;
  }

  async listForUser(userId: string, query: ConversationListQuery): Promise<ConversationListResult> {
    const owned = [...this.byId.values()]
      .filter((record) => record.participantIds.includes(userId))
      .sort(compareConversationsDesc);

    const filtered = query.before
      ? owned.filter((record) => {
          const cursor = query.before!;
          if (record.lastActivityAt < cursor.lastActivityAt) return true;
          if (record.lastActivityAt === cursor.lastActivityAt && record.id < cursor.id) return true;
          return false;
        })
      : owned;

    const slice = filtered.slice(0, query.limit + 1);
    const hasMore = slice.length > query.limit;
    const page = (hasMore ? slice.slice(0, query.limit) : slice).map(cloneRecord);
    const last = page.at(-1);
    const nextCursor =
      hasMore && last ? encodeConversationCursor(last.lastActivityAt, last.id) : null;

    return { items: page, nextCursor, hasMore };
  }

  async reserveNextSeq(
    conversationId: string,
    participantUserId: string,
    now = new Date(),
  ): Promise<number | null> {
    const record = this.byId.get(conversationId);
    if (!record || !record.participantIds.includes(participantUserId)) {
      return null;
    }
    record.lastSeq += 1;
    const timestamp = now.toISOString();
    if (timestamp > record.lastActivityAt) {
      record.lastActivityAt = timestamp;
    }
    return record.lastSeq;
  }
}

/**
 * MongoDB-backed conversation repository structure (DEC-023 §9.1).
 *
 * Uses atomic `$setOnInsert` upsert against the unique `uniq_pairKey` index and
 * duplicate-key (`E11000` / code `11000`) read-back resolution. Local tests can
 * supply an in-memory collection double; live Atlas query-plan verification
 * remains Release-gated under `DEC-023`.
 */
export interface MongoConversationDocument {
  _id: string;
  pairKey: string;
  participantIds: string[];
  lastSeq: number;
  createdAt: Date;
  lastActivityAt: Date;
  schemaVersion: number;
}

export interface MongoFindCursorLike<T> {
  sort(spec: Record<string, 1 | -1>): MongoFindCursorLike<T>;
  limit(n: number): MongoFindCursorLike<T>;
  toArray(): Promise<T[]>;
}

export interface MongoConversationCollectionLike {
  findOne(filter: Record<string, unknown>): Promise<MongoConversationDocument | null>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<MongoConversationDocument | null>;
  find(filter: Record<string, unknown>): MongoFindCursorLike<MongoConversationDocument>;
}

function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return code === 11000 || (typeof message === "string" && message.includes("E11000"));
}

function fromMongoDoc(doc: MongoConversationDocument): ConversationRecord {
  assertTwoDistinctParticipants(doc.participantIds);
  if (doc.schemaVersion !== CONVERSATION_SCHEMA_VERSION) {
    throw new Error(`Unsupported stored conversation schemaVersion: ${doc.schemaVersion}`);
  }
  return {
    id: doc._id,
    pairKey: doc.pairKey,
    participantIds: [doc.participantIds[0], doc.participantIds[1]],
    lastSeq: doc.lastSeq,
    createdAt: doc.createdAt.toISOString(),
    lastActivityAt: doc.lastActivityAt.toISOString(),
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
  };
}

export class MongoConversationStore implements ConversationStore {
  private readonly idGenerator: () => string;

  constructor(
    private readonly collection: MongoConversationCollectionLike,
    options: { idGenerator?: () => string } = {},
  ) {
    this.idGenerator = options.idGenerator ?? (() => `conv_${randomUUID()}`);
  }

  async upsertDirect(
    userA: string,
    userB: string,
    now = new Date(),
  ): Promise<ConversationUpsertResult> {
    const { pairKey, participantIds } = canonicalConversationPair(userA, userB);
    const existing = await this.collection.findOne({ pairKey });
    if (existing) {
      return { conversation: fromMongoDoc(existing), created: false };
    }

    const candidateId = this.idGenerator();
    try {
      const updated = await this.collection.findOneAndUpdate(
        { pairKey },
        {
          $setOnInsert: {
            _id: candidateId,
            pairKey,
            participantIds: [participantIds[0], participantIds[1]],
            lastSeq: 0,
            createdAt: now,
            lastActivityAt: now,
            schemaVersion: CONVERSATION_SCHEMA_VERSION,
          },
        },
        { upsert: true, returnDocument: "after" },
      );
      if (!updated) {
        const fallback = await this.collection.findOne({ pairKey });
        if (!fallback) throw new Error("Conversation upsert returned empty result.");
        return { conversation: fromMongoDoc(fallback), created: fallback._id === candidateId };
      }
      return {
        conversation: fromMongoDoc(updated),
        created: updated._id === candidateId,
      };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const winner = await this.collection.findOne({ pairKey });
      if (!winner) throw error;
      return { conversation: fromMongoDoc(winner), created: false };
    }
  }

  async getById(conversationId: string): Promise<ConversationRecord | null> {
    const doc = await this.collection.findOne({ _id: conversationId });
    return doc ? fromMongoDoc(doc) : null;
  }

  async getByPair(userA: string, userB: string): Promise<ConversationRecord | null> {
    if (!isOpaqueId(userA) || !isOpaqueId(userB) || userA === userB) {
      return null;
    }
    const { pairKey } = canonicalConversationPair(userA, userB);
    const doc = await this.collection.findOne({ pairKey });
    return doc ? fromMongoDoc(doc) : null;
  }

  async listForUser(userId: string, query: ConversationListQuery): Promise<ConversationListResult> {
    const filter: Record<string, unknown> = { participantIds: userId };
    if (query.before) {
      const cursorTime = new Date(query.before.lastActivityAt);
      filter.$or = [
        { lastActivityAt: { $lt: cursorTime } },
        { lastActivityAt: cursorTime, _id: { $lt: query.before.id } },
      ];
    }

    const docs = await this.collection
      .find(filter)
      .sort({ lastActivityAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .toArray();

    const hasMore = docs.length > query.limit;
    const pageDocs = hasMore ? docs.slice(0, query.limit) : docs;
    const items = pageDocs.map(fromMongoDoc);
    const last = items.at(-1);
    const nextCursor =
      hasMore && last ? encodeConversationCursor(last.lastActivityAt, last.id) : null;
    return { items, nextCursor, hasMore };
  }

  async reserveNextSeq(
    conversationId: string,
    participantUserId: string,
    now = new Date(),
  ): Promise<number | null> {
    const updated = await this.collection.findOneAndUpdate(
      { _id: conversationId, participantIds: participantUserId },
      {
        $inc: { lastSeq: 1 },
        $max: { lastActivityAt: now },
      },
      {
        returnDocument: "after",
        writeConcern: { w: "majority", j: true, wtimeout: 5000 },
      },
    );
    if (!updated) return null;
    const record = fromMongoDoc(updated);
    if (!record.participantIds.includes(participantUserId)) return null;
    return record.lastSeq;
  }
}
