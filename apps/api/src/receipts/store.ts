import { randomUUID } from "node:crypto";

import {
  DEFAULT_READ_RECEIPTS_ENABLED,
  RECEIPT_SCHEMA_VERSION,
  isDeviceId,
  isOpaqueId,
  isReceiptStage,
  mergeMonotonicReadThroughSeq,
  mergeMonotonicReceiptStage,
  mergeMonotonicTimestamp,
  type ReceiptStage,
  type ReceiptSubmitType,
} from "@chat/contracts";

/**
 * Receipts & private read-progress repository v0 (P2-11, FR-CHAT-009..011,
 * FR-HIST-004, DATA-006; DEC-015, DEC-020, DEC-021, DEC-023).
 *
 * Enforces:
 * - Uniqueness on `(messageId, recipientUserId)` for `receipts` and
 *   `(conversationId, userId)` for `read_progress`.
 * - Strictly monotonic stage (`sent -> delivered -> read`), non-regressing
 *   confirmed timestamps, and non-decreasing private `readThroughSeq`.
 * - Majority write/read concern on Mongo collections with E11000 race recovery.
 * - Full deletion helpers when messages or user accounts are removed (`DEC-015`).
 */

export interface ReceiptRecord {
  messageId: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  stage: ReceiptStage;
  deliveredAt: string | null;
  readAt: string | null;
  updatedAt: string;
  schemaVersion: 1;
}

export interface ReadProgressRecord {
  conversationId: string;
  userId: string;
  readThroughSeq: number;
  updatedAt: string;
  schemaVersion: 1;
}

export interface ReceiptPreferencesRecord {
  userId: string;
  readReceiptsEnabled: boolean;
  updatedAt: string;
  schemaVersion: 1;
}

export interface UpsertReceiptInput {
  messageId: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  type: ReceiptSubmitType;
  now?: Date;
}

export interface UpsertReceiptResult {
  record: ReceiptRecord;
  advanced: boolean;
}

export interface ReceiptStore {
  upsertReceipt(input: UpsertReceiptInput): Promise<UpsertReceiptResult>;
  getReceipt(messageId: string, recipientUserId: string): Promise<ReceiptRecord | null>;
  listByConversationForSender(
    conversationId: string,
    senderUserId: string,
  ): Promise<ReceiptRecord[]>;
  getReadProgress(conversationId: string, userId: string): Promise<ReadProgressRecord | null>;
  advanceReadProgress(
    conversationId: string,
    userId: string,
    candidateSeq: number,
    maxSeq: number,
    now?: Date,
  ): Promise<ReadProgressRecord>;
  getPreferences(userId: string): Promise<ReceiptPreferencesRecord | null>;
  setPreferences(
    userId: string,
    readReceiptsEnabled: boolean,
    now?: Date,
  ): Promise<ReceiptPreferencesRecord>;
  deleteByMessageIds(messageIds: readonly string[]): Promise<number>;
  deleteByUserId(userId: string): Promise<number>;
}

const MAJORITY_WRITE = { writeConcern: { w: "majority", j: true, wtimeout: 5000 } } as const;
const MAJORITY_READ = { readConcern: { level: "majority" } } as const;

function assertValidReceiptInput(input: UpsertReceiptInput): void {
  if (
    !isOpaqueId(input.messageId) ||
    !isOpaqueId(input.conversationId) ||
    !isOpaqueId(input.senderUserId) ||
    !isOpaqueId(input.recipientUserId) ||
    !isDeviceId(input.recipientDeviceId) ||
    input.senderUserId === input.recipientUserId ||
    !Number.isSafeInteger(input.seq) ||
    input.seq < 1
  ) {
    throw new Error("Receipt invariant violated: invalid receipt identifiers or seq.");
  }
}

function cloneReceipt(record: ReceiptRecord): ReceiptRecord {
  return { ...record };
}

function cloneProgress(record: ReadProgressRecord): ReadProgressRecord {
  return { ...record };
}

function clonePreferences(record: ReceiptPreferencesRecord): ReceiptPreferencesRecord {
  return { ...record };
}

function computeNextReceiptState(
  existing: ReceiptRecord | null,
  input: UpsertReceiptInput,
): UpsertReceiptResult {
  assertValidReceiptInput(input);
  const at = (input.now ?? new Date()).toISOString();

  if (!existing) {
    const created: ReceiptRecord = {
      messageId: input.messageId,
      conversationId: input.conversationId,
      seq: input.seq,
      senderUserId: input.senderUserId,
      recipientUserId: input.recipientUserId,
      recipientDeviceId: input.recipientDeviceId,
      stage: input.type,
      deliveredAt: at,
      readAt: input.type === "read" ? at : null,
      updatedAt: at,
      schemaVersion: RECEIPT_SCHEMA_VERSION,
    };
    return { record: cloneReceipt(created), advanced: true };
  }

  const nextStage = mergeMonotonicReceiptStage(existing.stage, input.type);
  const stageAdvanced = nextStage !== existing.stage;
  if (!stageAdvanced) {
    return { record: cloneReceipt(existing), advanced: false };
  }

  const updated: ReceiptRecord = {
    ...existing,
    stage: nextStage,
    deliveredAt: mergeMonotonicTimestamp(existing.deliveredAt, at),
    readAt: input.type === "read" ? mergeMonotonicTimestamp(existing.readAt, at) : existing.readAt,
    updatedAt: at,
  };
  return { record: cloneReceipt(updated), advanced: true };
}

export interface MemoryReceiptStoreOptions {
  beforeUpsertHook?: (key: string) => Promise<void> | void;
}

export class MemoryReceiptStore implements ReceiptStore {
  private readonly receipts = new Map<string, ReceiptRecord>();
  private readonly readProgress = new Map<string, ReadProgressRecord>();
  private readonly preferences = new Map<string, ReceiptPreferencesRecord>();

  constructor(private readonly options: MemoryReceiptStoreOptions = {}) {}

  private receiptKey(messageId: string, recipientUserId: string): string {
    return `${messageId}::${recipientUserId}`;
  }

  private progressKey(conversationId: string, userId: string): string {
    return `${conversationId}::${userId}`;
  }

  async upsertReceipt(input: UpsertReceiptInput): Promise<UpsertReceiptResult> {
    assertValidReceiptInput(input);
    const key = this.receiptKey(input.messageId, input.recipientUserId);
    if (this.options.beforeUpsertHook) {
      await this.options.beforeUpsertHook(key);
    }
    const existing = this.receipts.get(key) ?? null;
    const outcome = computeNextReceiptState(existing, input);
    if (!existing || outcome.advanced) {
      this.receipts.set(key, cloneReceipt(outcome.record));
    }
    return {
      record: cloneReceipt(outcome.record),
      advanced: outcome.advanced,
    };
  }

  async getReceipt(messageId: string, recipientUserId: string): Promise<ReceiptRecord | null> {
    const found = this.receipts.get(this.receiptKey(messageId, recipientUserId));
    return found ? cloneReceipt(found) : null;
  }

  async listByConversationForSender(
    conversationId: string,
    senderUserId: string,
  ): Promise<ReceiptRecord[]> {
    const items: ReceiptRecord[] = [];
    for (const record of this.receipts.values()) {
      if (record.conversationId === conversationId && record.senderUserId === senderUserId) {
        items.push(cloneReceipt(record));
      }
    }
    items.sort((a, b) => a.seq - b.seq || a.messageId.localeCompare(b.messageId));
    return items;
  }

  async getReadProgress(
    conversationId: string,
    userId: string,
  ): Promise<ReadProgressRecord | null> {
    const found = this.readProgress.get(this.progressKey(conversationId, userId));
    return found ? cloneProgress(found) : null;
  }

  async advanceReadProgress(
    conversationId: string,
    userId: string,
    candidateSeq: number,
    maxSeq: number,
    now: Date = new Date(),
  ): Promise<ReadProgressRecord> {
    if (!isOpaqueId(conversationId) || !isOpaqueId(userId)) {
      throw new Error("ReadProgress invariant violated: invalid conversationId or userId.");
    }
    const key = this.progressKey(conversationId, userId);
    const existing = this.readProgress.get(key) ?? null;
    const currentSeq = existing?.readThroughSeq ?? 0;
    const nextSeq = mergeMonotonicReadThroughSeq(currentSeq, candidateSeq, maxSeq);
    if (existing && nextSeq === existing.readThroughSeq) {
      return cloneProgress(existing);
    }
    const updated: ReadProgressRecord = {
      conversationId,
      userId,
      readThroughSeq: nextSeq,
      updatedAt: now.toISOString(),
      schemaVersion: RECEIPT_SCHEMA_VERSION,
    };
    this.readProgress.set(key, cloneProgress(updated));
    return cloneProgress(updated);
  }

  async getPreferences(userId: string): Promise<ReceiptPreferencesRecord | null> {
    const found = this.preferences.get(userId);
    return found ? clonePreferences(found) : null;
  }

  async setPreferences(
    userId: string,
    readReceiptsEnabled: boolean,
    now: Date = new Date(),
  ): Promise<ReceiptPreferencesRecord> {
    if (!isOpaqueId(userId)) {
      throw new Error("ReceiptPreferences invariant violated: invalid userId.");
    }
    const record: ReceiptPreferencesRecord = {
      userId,
      readReceiptsEnabled,
      updatedAt: now.toISOString(),
      schemaVersion: RECEIPT_SCHEMA_VERSION,
    };
    this.preferences.set(userId, clonePreferences(record));
    return clonePreferences(record);
  }

  async deleteByMessageIds(messageIds: readonly string[]): Promise<number> {
    const target = new Set(messageIds);
    let deleted = 0;
    for (const [key, record] of this.receipts.entries()) {
      if (target.has(record.messageId)) {
        this.receipts.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  async deleteByUserId(userId: string): Promise<number> {
    let deleted = 0;
    for (const [key, record] of this.receipts.entries()) {
      if (record.senderUserId === userId || record.recipientUserId === userId) {
        this.receipts.delete(key);
        deleted += 1;
      }
    }
    for (const [key, progress] of this.readProgress.entries()) {
      if (progress.userId === userId) {
        this.readProgress.delete(key);
        deleted += 1;
      }
    }
    if (this.preferences.delete(userId)) {
      deleted += 1;
    }
    return deleted;
  }
}

export interface MongoReceiptDocument {
  _id: string;
  messageId: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  recipientUserId: string;
  recipientDeviceId: string;
  stage: string;
  deliveredAt: Date | null;
  readAt: Date | null;
  updatedAt: Date;
  schemaVersion: number;
}

export interface MongoReadProgressDocument {
  _id: string;
  conversationId: string;
  userId: string;
  readThroughSeq: number;
  updatedAt: Date;
  schemaVersion: number;
}

export interface MongoReceiptPreferencesDocument {
  _id: string;
  userId: string;
  readReceiptsEnabled: boolean;
  updatedAt: Date;
  schemaVersion: number;
}

export interface MongoCursorLike<T> {
  sort(spec: Record<string, 1 | -1>): MongoCursorLike<T>;
  toArray(): Promise<T[]>;
}

export interface MongoCollectionLike<TDoc> {
  findOne(filter: Record<string, unknown>, options?: Record<string, unknown>): Promise<TDoc | null>;
  insertOne(doc: TDoc, options?: Record<string, unknown>): Promise<{ acknowledged: boolean }>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ acknowledged: boolean; matchedCount?: number; modifiedCount?: number }>;
  find(filter: Record<string, unknown>, options?: Record<string, unknown>): MongoCursorLike<TDoc>;
  deleteMany(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<{ deletedCount?: number }>;
}

function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return code === 11000 || (typeof message === "string" && message.includes("E11000"));
}

function fromMongoReceiptDoc(doc: MongoReceiptDocument): ReceiptRecord {
  if (doc.schemaVersion !== RECEIPT_SCHEMA_VERSION || !isReceiptStage(doc.stage)) {
    throw new Error(`Invalid stored receipt document for ${doc.messageId}`);
  }
  return {
    messageId: doc.messageId,
    conversationId: doc.conversationId,
    seq: doc.seq,
    senderUserId: doc.senderUserId,
    recipientUserId: doc.recipientUserId,
    recipientDeviceId: doc.recipientDeviceId,
    stage: doc.stage,
    deliveredAt: doc.deliveredAt ? doc.deliveredAt.toISOString() : null,
    readAt: doc.readAt ? doc.readAt.toISOString() : null,
    updatedAt: doc.updatedAt.toISOString(),
    schemaVersion: RECEIPT_SCHEMA_VERSION,
  };
}

function fromMongoProgressDoc(doc: MongoReadProgressDocument): ReadProgressRecord {
  if (doc.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error(`Unsupported read_progress schemaVersion: ${doc.schemaVersion}`);
  }
  return {
    conversationId: doc.conversationId,
    userId: doc.userId,
    readThroughSeq: doc.readThroughSeq,
    updatedAt: doc.updatedAt.toISOString(),
    schemaVersion: RECEIPT_SCHEMA_VERSION,
  };
}

function fromMongoPrefsDoc(doc: MongoReceiptPreferencesDocument): ReceiptPreferencesRecord {
  if (doc.schemaVersion !== RECEIPT_SCHEMA_VERSION) {
    throw new Error(`Unsupported receipt preferences schemaVersion: ${doc.schemaVersion}`);
  }
  return {
    userId: doc.userId,
    readReceiptsEnabled: Boolean(doc.readReceiptsEnabled),
    updatedAt: doc.updatedAt.toISOString(),
    schemaVersion: RECEIPT_SCHEMA_VERSION,
  };
}

export interface MongoReceiptStoreCollections {
  receipts: MongoCollectionLike<MongoReceiptDocument>;
  readProgress: MongoCollectionLike<MongoReadProgressDocument>;
  preferences: MongoCollectionLike<MongoReceiptPreferencesDocument>;
}

/**
 * MongoDB-backed receipts and private read-progress repository (`DATA-006`,
 * `DEC-015`, `DEC-020`, `DEC-023`).
 */
export class MongoReceiptStore implements ReceiptStore {
  private readonly idGenerator: () => string;

  constructor(
    private readonly collections: MongoReceiptStoreCollections,
    options: { idGenerator?: () => string } = {},
  ) {
    this.idGenerator = options.idGenerator ?? (() => randomUUID());
  }

  async upsertReceipt(input: UpsertReceiptInput): Promise<UpsertReceiptResult> {
    assertValidReceiptInput(input);
    const filter = {
      messageId: input.messageId,
      recipientUserId: input.recipientUserId,
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existingDoc = await this.collections.receipts.findOne(filter, MAJORITY_READ);
      const existing = existingDoc ? fromMongoReceiptDoc(existingDoc) : null;
      const outcome = computeNextReceiptState(existing, input);

      if (!existing) {
        const doc: MongoReceiptDocument = {
          _id: `rcp_${this.idGenerator()}`,
          messageId: outcome.record.messageId,
          conversationId: outcome.record.conversationId,
          seq: outcome.record.seq,
          senderUserId: outcome.record.senderUserId,
          recipientUserId: outcome.record.recipientUserId,
          recipientDeviceId: outcome.record.recipientDeviceId,
          stage: outcome.record.stage,
          deliveredAt: outcome.record.deliveredAt ? new Date(outcome.record.deliveredAt) : null,
          readAt: outcome.record.readAt ? new Date(outcome.record.readAt) : null,
          updatedAt: new Date(outcome.record.updatedAt),
          schemaVersion: RECEIPT_SCHEMA_VERSION,
        };
        try {
          await this.collections.receipts.insertOne(doc, MAJORITY_WRITE);
          return outcome;
        } catch (error) {
          if (isDuplicateKeyError(error)) {
            continue;
          }
          throw error;
        }
      }

      if (!outcome.advanced) {
        return outcome;
      }

      await this.collections.receipts.updateOne(
        {
          ...filter,
          stage: existing.stage,
        },
        {
          $set: {
            stage: outcome.record.stage,
            deliveredAt: outcome.record.deliveredAt ? new Date(outcome.record.deliveredAt) : null,
            readAt: outcome.record.readAt ? new Date(outcome.record.readAt) : null,
            updatedAt: new Date(outcome.record.updatedAt),
          },
        },
        MAJORITY_WRITE,
      );

      const refreshed = await this.collections.receipts.findOne(filter, MAJORITY_READ);
      if (!refreshed) {
        continue;
      }
      const persisted = fromMongoReceiptDoc(refreshed);
      const reachedTarget =
        input.type === "delivered"
          ? persisted.stage === "delivered" || persisted.stage === "read"
          : persisted.stage === "read";
      if (reachedTarget) {
        return {
          record: persisted,
          advanced: true,
        };
      }
    }

    const finalDoc = await this.collections.receipts.findOne(filter, MAJORITY_READ);
    if (!finalDoc) {
      throw new Error("Receipt upsert did not converge.");
    }
    return { record: fromMongoReceiptDoc(finalDoc), advanced: false };
  }

  async getReceipt(messageId: string, recipientUserId: string): Promise<ReceiptRecord | null> {
    const doc = await this.collections.receipts.findOne(
      { messageId, recipientUserId },
      MAJORITY_READ,
    );
    return doc ? fromMongoReceiptDoc(doc) : null;
  }

  async listByConversationForSender(
    conversationId: string,
    senderUserId: string,
  ): Promise<ReceiptRecord[]> {
    const docs = await this.collections.receipts
      .find({ conversationId, senderUserId }, MAJORITY_READ)
      .sort({ seq: 1, messageId: 1 })
      .toArray();
    return docs.map(fromMongoReceiptDoc);
  }

  async getReadProgress(
    conversationId: string,
    userId: string,
  ): Promise<ReadProgressRecord | null> {
    const doc = await this.collections.readProgress.findOne(
      { conversationId, userId },
      MAJORITY_READ,
    );
    return doc ? fromMongoProgressDoc(doc) : null;
  }

  async advanceReadProgress(
    conversationId: string,
    userId: string,
    candidateSeq: number,
    maxSeq: number,
    now: Date = new Date(),
  ): Promise<ReadProgressRecord> {
    if (!isOpaqueId(conversationId) || !isOpaqueId(userId)) {
      throw new Error("ReadProgress invariant violated: invalid conversationId or userId.");
    }
    const filter = { conversationId, userId };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existingDoc = await this.collections.readProgress.findOne(filter, MAJORITY_READ);
      const existing = existingDoc ? fromMongoProgressDoc(existingDoc) : null;
      const nextSeq = mergeMonotonicReadThroughSeq(
        existing?.readThroughSeq ?? 0,
        candidateSeq,
        maxSeq,
      );
      if (existing && nextSeq === existing.readThroughSeq) {
        return existing;
      }
      if (!existing) {
        const doc: MongoReadProgressDocument = {
          _id: `prog_${this.idGenerator()}`,
          conversationId,
          userId,
          readThroughSeq: nextSeq,
          updatedAt: now,
          schemaVersion: RECEIPT_SCHEMA_VERSION,
        };
        try {
          await this.collections.readProgress.insertOne(doc, MAJORITY_WRITE);
          return fromMongoProgressDoc(doc);
        } catch (error) {
          if (isDuplicateKeyError(error)) {
            continue;
          }
          throw error;
        }
      }
      await this.collections.readProgress.updateOne(
        filter,
        {
          $max: { readThroughSeq: nextSeq },
          $set: { updatedAt: now },
        },
        MAJORITY_WRITE,
      );
      const refreshed = await this.collections.readProgress.findOne(filter, MAJORITY_READ);
      if (refreshed) {
        return fromMongoProgressDoc(refreshed);
      }
    }
    const fallback = await this.collections.readProgress.findOne(filter, MAJORITY_READ);
    if (!fallback) {
      throw new Error("Read progress advance did not converge.");
    }
    return fromMongoProgressDoc(fallback);
  }

  async getPreferences(userId: string): Promise<ReceiptPreferencesRecord | null> {
    const doc = await this.collections.preferences.findOne({ userId }, MAJORITY_READ);
    return doc ? fromMongoPrefsDoc(doc) : null;
  }

  async setPreferences(
    userId: string,
    readReceiptsEnabled: boolean,
    now: Date = new Date(),
  ): Promise<ReceiptPreferencesRecord> {
    if (!isOpaqueId(userId)) {
      throw new Error("ReceiptPreferences invariant violated: invalid userId.");
    }
    const filter = { userId };
    await this.collections.preferences.updateOne(
      filter,
      {
        $set: {
          readReceiptsEnabled,
          updatedAt: now,
          schemaVersion: RECEIPT_SCHEMA_VERSION,
        },
        $setOnInsert: {
          _id: `pref_${this.idGenerator()}`,
          userId,
        },
      },
      { ...MAJORITY_WRITE, upsert: true },
    );
    const updated = await this.collections.preferences.findOne(filter, MAJORITY_READ);
    if (updated) {
      return fromMongoPrefsDoc(updated);
    }
    return {
      userId,
      readReceiptsEnabled: readReceiptsEnabled ?? DEFAULT_READ_RECEIPTS_ENABLED,
      updatedAt: now.toISOString(),
      schemaVersion: RECEIPT_SCHEMA_VERSION,
    };
  }

  async deleteByMessageIds(messageIds: readonly string[]): Promise<number> {
    if (messageIds.length === 0) return 0;
    const res = await this.collections.receipts.deleteMany(
      { messageId: { $in: [...messageIds] } },
      MAJORITY_WRITE,
    );
    return res.deletedCount ?? 0;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const [rcpRes, progRes, prefRes] = await Promise.all([
      this.collections.receipts.deleteMany(
        { $or: [{ senderUserId: userId }, { recipientUserId: userId }] },
        MAJORITY_WRITE,
      ),
      this.collections.readProgress.deleteMany({ userId }, MAJORITY_WRITE),
      this.collections.preferences.deleteMany({ userId }, MAJORITY_WRITE),
    ]);
    return (rcpRes.deletedCount ?? 0) + (progRes.deletedCount ?? 0) + (prefRes.deletedCount ?? 0);
  }
}
