import { createHash, randomUUID } from "node:crypto";

import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  type MessageProtocolVersion,
} from "@chat/contracts";

import type { ConversationStore } from "../conversations/store.js";

/**
 * Durable encrypted message store v0 (P2-04, FR-CHAT-002..004, DATA-003..005,
 * NFR-REL-002; DEC-021 §4-5, DEC-023 §9.2).
 *
 * Provisional under Release-gated DEC-023 (`payloadHash canonicalization`,
 * schema/indexes; live Atlas driver execution and query plans remain Release-gated):
 * - Canonical write path: HTTP POST -> reserve per-conversation `seq` under
 *   majority+journaled write concern -> immutable message insert under same
 *   write concern -> acknowledge only after both commits succeed.
 * - Permanent gaps on failed/aborted writes after seq reservation are allowed
 *   and never reused (`DEC-021` §4.3).
 * - Deduplication via unique `(senderUserId, senderDeviceId, clientMessageId)`
 *   plus canonical SHA-256 `payloadHash` (`409 IDEMPOTENCY_CONFLICT` on mismatch).
 */
export const MESSAGE_WRITE_CONCERN = { w: "majority", j: true, wtimeout: 5000 } as const;
export const MESSAGE_READ_CONCERN = { level: "majority" } as const;

export interface MessageRecord {
  id: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  senderDeviceId: string;
  clientMessageId: string;
  payloadHash: string;
  protocolVersion: MessageProtocolVersion;
  encryptedEnvelope: string;
  committedAt: string;
  schemaVersion: 1;
}

export interface SubmitMessageInput {
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  clientMessageId: string;
  protocolVersion: MessageProtocolVersion;
  encryptedEnvelope: string;
  conversationStore: ConversationStore;
  now?: Date;
}

export type MessageCommitResult =
  | { ok: true; record: MessageRecord; idempotent: boolean }
  | {
      ok: false;
      code: "NOT_FOUND" | "IDEMPOTENCY_CONFLICT" | "TEMPORARILY_UNAVAILABLE";
    };

export interface MessageStore {
  submitDurable(input: SubmitMessageInput): Promise<MessageCommitResult>;
  getById(messageId: string): Promise<MessageRecord | null>;
  findByIdempotencyKey(
    senderUserId: string,
    senderDeviceId: string,
    clientMessageId: string,
  ): Promise<MessageRecord | null>;
  listByConversation(conversationId: string): Promise<MessageRecord[]>;
}

/**
 * Compute canonical domain-separated SHA-256 payload hash (`DEC-021` §4.2 step 3).
 * Length-prefixed UTF-8 encoding prevents field-boundary collisions.
 */
export function computeMessagePayloadHash(input: {
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  clientMessageId: string;
  protocolVersion: MessageProtocolVersion;
  encryptedEnvelope: string;
}): string {
  const hash = createHash("sha256");
  const fields = [
    "chat.message.payload.v1",
    input.conversationId,
    input.senderUserId,
    input.senderDeviceId,
    input.clientMessageId,
    input.protocolVersion,
    input.encryptedEnvelope,
  ];
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    hash.update(`${bytes.byteLength}:`);
    hash.update(bytes);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function idempotencyKeyString(
  senderUserId: string,
  senderDeviceId: string,
  clientMessageId: string,
): string {
  return JSON.stringify([senderUserId, senderDeviceId, clientMessageId]);
}

function cloneMessageRecord(record: MessageRecord): MessageRecord {
  return { ...record };
}

function assertValidStoredMessage(record: MessageRecord): void {
  if (record.schemaVersion !== MESSAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported stored message schemaVersion: ${record.schemaVersion}`);
  }
  if (record.protocolVersion !== MESSAGE_ALLOWED_PROTOCOL_VERSION) {
    throw new Error(`Unsupported stored message protocolVersion: ${record.protocolVersion}`);
  }
  if (!Number.isInteger(record.seq) || record.seq < 1) {
    throw new Error(`Invalid stored message seq: ${record.seq}`);
  }
}

export interface MemoryMessageFaultContext {
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  clientMessageId: string;
  payloadHash: string;
  seq?: number;
}

export interface MemoryMessageStoreOptions {
  idGenerator?: () => string;
  beforeSeqReserve?: (ctx: MemoryMessageFaultContext) => Promise<void> | void;
  afterSeqReserveBeforeInsert?: (
    ctx: MemoryMessageFaultContext & { seq: number },
  ) => Promise<void> | void;
  afterInsertBeforeAck?: (record: MessageRecord) => Promise<void> | void;
}

export class MemoryMessageStore implements MessageStore {
  private readonly byId = new Map<string, MessageRecord>();
  private readonly byIdemKey = new Map<string, MessageRecord>();
  private readonly byConvSeq = new Map<string, MessageRecord>();
  private readonly inFlightByIdemKey = new Map<string, Promise<unknown>>();
  private readonly idGenerator: () => string;
  private readonly beforeSeqReserve?: MemoryMessageStoreOptions["beforeSeqReserve"];
  private readonly afterSeqReserveBeforeInsert?: MemoryMessageStoreOptions["afterSeqReserveBeforeInsert"];
  private readonly afterInsertBeforeAck?: MemoryMessageStoreOptions["afterInsertBeforeAck"];

  constructor(options: MemoryMessageStoreOptions = {}) {
    this.idGenerator = options.idGenerator ?? (() => `msg_${randomUUID()}`);
    this.beforeSeqReserve = options.beforeSeqReserve;
    this.afterSeqReserveBeforeInsert = options.afterSeqReserveBeforeInsert;
    this.afterInsertBeforeAck = options.afterInsertBeforeAck;
  }

  async submitDurable(input: SubmitMessageInput): Promise<MessageCommitResult> {
    const payloadHash = computeMessagePayloadHash(input);
    const idemKey = idempotencyKeyString(
      input.senderUserId,
      input.senderDeviceId,
      input.clientMessageId,
    );

    const runLocked = async (): Promise<MessageCommitResult> => {
      try {
        const existing = this.byIdemKey.get(idemKey);
        if (existing) {
          if (
            existing.conversationId !== input.conversationId ||
            existing.payloadHash !== payloadHash
          ) {
            return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
          }
          return { ok: true, record: cloneMessageRecord(existing), idempotent: true };
        }

        const ctx: MemoryMessageFaultContext = {
          conversationId: input.conversationId,
          senderUserId: input.senderUserId,
          senderDeviceId: input.senderDeviceId,
          clientMessageId: input.clientMessageId,
          payloadHash,
        };
        if (this.beforeSeqReserve) {
          await this.beforeSeqReserve(ctx);
        }

        const now = input.now ?? new Date();
        const seq = await input.conversationStore.reserveNextSeq(
          input.conversationId,
          input.senderUserId,
          now,
        );
        if (seq === null) {
          return { ok: false, code: "NOT_FOUND" };
        }

        if (this.afterSeqReserveBeforeInsert) {
          await this.afterSeqReserveBeforeInsert({ ...ctx, seq });
        }

        // Re-check idempotency in case an external concurrent writer committed inside a hook.
        const raced = this.byIdemKey.get(idemKey);
        if (raced) {
          if (raced.conversationId !== input.conversationId || raced.payloadHash !== payloadHash) {
            return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
          }
          return { ok: true, record: cloneMessageRecord(raced), idempotent: true };
        }

        const convSeqKey = `${input.conversationId}:${seq}`;
        if (this.byConvSeq.has(convSeqKey)) {
          return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
        }

        const record: MessageRecord = {
          id: this.idGenerator(),
          conversationId: input.conversationId,
          seq,
          senderUserId: input.senderUserId,
          senderDeviceId: input.senderDeviceId,
          clientMessageId: input.clientMessageId,
          payloadHash,
          protocolVersion: input.protocolVersion,
          encryptedEnvelope: input.encryptedEnvelope,
          committedAt: now.toISOString(),
          schemaVersion: MESSAGE_SCHEMA_VERSION,
        };
        assertValidStoredMessage(record);

        this.byId.set(record.id, record);
        this.byIdemKey.set(idemKey, record);
        this.byConvSeq.set(convSeqKey, record);

        if (this.afterInsertBeforeAck) {
          await this.afterInsertBeforeAck(cloneMessageRecord(record));
        }

        return { ok: true, record: cloneMessageRecord(record), idempotent: false };
      } catch {
        // Any uncommitted write failure or post-commit ack drop must resolve safely as
        // retryable TEMPORARILY_UNAVAILABLE rather than emitting a false sent ack (FR-CHAT-003).
        return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
      }
    };

    const previous = this.inFlightByIdemKey.get(idemKey) ?? Promise.resolve();
    const nextPromise = previous.then(runLocked, runLocked);
    this.inFlightByIdemKey.set(idemKey, nextPromise);
    try {
      return await nextPromise;
    } finally {
      if (this.inFlightByIdemKey.get(idemKey) === nextPromise) {
        this.inFlightByIdemKey.delete(idemKey);
      }
    }
  }

  async getById(messageId: string): Promise<MessageRecord | null> {
    const record = this.byId.get(messageId);
    return record ? cloneMessageRecord(record) : null;
  }

  async findByIdempotencyKey(
    senderUserId: string,
    senderDeviceId: string,
    clientMessageId: string,
  ): Promise<MessageRecord | null> {
    const record = this.byIdemKey.get(
      idempotencyKeyString(senderUserId, senderDeviceId, clientMessageId),
    );
    return record ? cloneMessageRecord(record) : null;
  }

  async listByConversation(conversationId: string): Promise<MessageRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.conversationId === conversationId)
      .sort((a, b) => a.seq - b.seq)
      .map(cloneMessageRecord);
  }
}

export interface MongoMessageDocument {
  _id: string;
  conversationId: string;
  seq: number;
  senderUserId: string;
  senderDeviceId: string;
  clientMessageId: string;
  payloadHash: string;
  protocolVersion: string;
  encryptedEnvelope: string;
  committedAt: Date;
  schemaVersion: number;
}

export interface MongoInsertOneResultLike {
  acknowledged: boolean;
}

export interface MongoMessageFindCursorLike<T> {
  sort(spec: Record<string, 1 | -1>): MongoMessageFindCursorLike<T>;
  toArray(): Promise<T[]>;
}

export interface MongoMessageCollectionLike {
  findOne(
    filter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<MongoMessageDocument | null>;
  insertOne(
    doc: MongoMessageDocument,
    options?: Record<string, unknown>,
  ): Promise<MongoInsertOneResultLike>;
  find(filter: Record<string, unknown>): MongoMessageFindCursorLike<MongoMessageDocument>;
}

function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return code === 11000 || (typeof message === "string" && message.includes("E11000"));
}

function fromMongoMessageDoc(doc: MongoMessageDocument): MessageRecord {
  const record: MessageRecord = {
    id: doc._id,
    conversationId: doc.conversationId,
    seq: doc.seq,
    senderUserId: doc.senderUserId,
    senderDeviceId: doc.senderDeviceId,
    clientMessageId: doc.clientMessageId,
    payloadHash: doc.payloadHash,
    protocolVersion: doc.protocolVersion as MessageProtocolVersion,
    encryptedEnvelope: doc.encryptedEnvelope,
    committedAt: doc.committedAt.toISOString(),
    schemaVersion: MESSAGE_SCHEMA_VERSION,
  };
  if (doc.schemaVersion !== MESSAGE_SCHEMA_VERSION) {
    throw new Error(`Unsupported stored message schemaVersion: ${doc.schemaVersion}`);
  }
  assertValidStoredMessage(record);
  return record;
}

/**
 * MongoDB-backed immutable message repository (`DEC-021` §4, `DEC-023` §9.2).
 *
 * Enforces:
 * - Majority + journal write concern (`w: "majority", j: true, wtimeout: 5000`)
 *   on both `conversations` seq reservation and `messages` insert
 * - Majority read concern for pre-check and `E11000` / `11000` duplicate-key
 *   read-back resolution
 * - Unresolvable write/read-back failures map to `TEMPORARILY_UNAVAILABLE`
 *   (retryable `503`), never returning a false `sent` ack
 */
export class MongoMessageStore implements MessageStore {
  private readonly idGenerator: () => string;

  constructor(
    private readonly collection: MongoMessageCollectionLike,
    options: { idGenerator?: () => string } = {},
  ) {
    this.idGenerator = options.idGenerator ?? (() => `msg_${randomUUID()}`);
  }

  async submitDurable(input: SubmitMessageInput): Promise<MessageCommitResult> {
    const payloadHash = computeMessagePayloadHash(input);
    const idempotencyFilter = {
      senderUserId: input.senderUserId,
      senderDeviceId: input.senderDeviceId,
      clientMessageId: input.clientMessageId,
    };

    try {
      const existing = await this.collection.findOne(idempotencyFilter, {
        readConcern: MESSAGE_READ_CONCERN,
      });
      if (existing) {
        if (
          existing.conversationId !== input.conversationId ||
          existing.payloadHash !== payloadHash
        ) {
          return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
        }
        return { ok: true, record: fromMongoMessageDoc(existing), idempotent: true };
      }

      const now = input.now ?? new Date();
      const seq = await input.conversationStore.reserveNextSeq(
        input.conversationId,
        input.senderUserId,
        now,
      );
      if (seq === null) {
        return { ok: false, code: "NOT_FOUND" };
      }

      const doc: MongoMessageDocument = {
        _id: this.idGenerator(),
        conversationId: input.conversationId,
        seq,
        senderUserId: input.senderUserId,
        senderDeviceId: input.senderDeviceId,
        clientMessageId: input.clientMessageId,
        payloadHash,
        protocolVersion: input.protocolVersion,
        encryptedEnvelope: input.encryptedEnvelope,
        committedAt: now,
        schemaVersion: MESSAGE_SCHEMA_VERSION,
      };

      try {
        const writeResult = await this.collection.insertOne(doc, {
          writeConcern: MESSAGE_WRITE_CONCERN,
        });
        if (!writeResult?.acknowledged) {
          return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
        }
        return { ok: true, record: fromMongoMessageDoc(doc), idempotent: false };
      } catch (error) {
        if (!isDuplicateKeyError(error)) {
          return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
        }
        try {
          const winner = await this.collection.findOne(idempotencyFilter, {
            readConcern: MESSAGE_READ_CONCERN,
          });
          if (!winner) {
            return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
          }
          if (
            winner.conversationId !== input.conversationId ||
            winner.payloadHash !== payloadHash
          ) {
            return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
          }
          return { ok: true, record: fromMongoMessageDoc(winner), idempotent: true };
        } catch {
          return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
        }
      }
    } catch {
      return { ok: false, code: "TEMPORARILY_UNAVAILABLE" };
    }
  }

  async getById(messageId: string): Promise<MessageRecord | null> {
    const doc = await this.collection.findOne(
      { _id: messageId },
      { readConcern: MESSAGE_READ_CONCERN },
    );
    return doc ? fromMongoMessageDoc(doc) : null;
  }

  async findByIdempotencyKey(
    senderUserId: string,
    senderDeviceId: string,
    clientMessageId: string,
  ): Promise<MessageRecord | null> {
    const doc = await this.collection.findOne(
      { senderUserId, senderDeviceId, clientMessageId },
      { readConcern: MESSAGE_READ_CONCERN },
    );
    return doc ? fromMongoMessageDoc(doc) : null;
  }

  async listByConversation(conversationId: string): Promise<MessageRecord[]> {
    const docs = await this.collection.find({ conversationId }).sort({ seq: 1 }).toArray();
    return docs.map(fromMongoMessageDoc);
  }
}
