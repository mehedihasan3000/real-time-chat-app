import {
  BrowserIndexedDbOutboxBackend,
  OutboxCryptoError,
  WebLocksSingleWriterLock,
  assertNoOutboxPlaintextOrSecrets,
  assertValidOutboxStorageKey,
  base64UrlDecode,
  base64UrlEncode,
  generateOutboxStorageKey,
  newKeyId,
  sealOutboxEntry,
  unsealOutboxEntry,
  type LockManagerLike,
  type OutboxAcceptedReceipt,
  type OutboxMetaRecord,
  type SealedOutboxEntryRecord,
} from "@chat/crypto";

import { assertValidOutboxRecord, cloneOutboxRecord, type OutboxRecord } from "./state";

/**
 * Outbox persistence boundary (`P2-05` / `P2-09`, `FR-CHAT-007`–`FR-CHAT-008`,
 * `DATA-013`, `DEC-021` §6.1).
 *
 * - `InMemoryOutboxStorageAdapter` (`P2-05`): deterministic volatile store for isolated unit tests.
 * - `EncryptedIndexedDbOutboxStorageAdapter` (`P2-09`): durable AES-256-GCM IndexedDB +
 *   Web Locks persistence using a dedicated non-extractable `CryptoKey` that never reuses
 *   any Olm protocol-state key. Plaintext `localStorage` queues are strictly prohibited.
 */
export type OutboxStorageErrorCode = "STORAGE_UNAVAILABLE" | "STORAGE_CLEARED" | "CORRUPT_OUTBOX";

const MAX_ACCEPTED_RECEIPT_CACHE = 50;

export class OutboxStorageError extends Error {
  constructor(
    readonly code: OutboxStorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OutboxStorageError";
  }
}

export interface OutboxStorageAdapter {
  readonly persistent: boolean;
  loadAll(accountId: string): Promise<OutboxRecord[]>;
  saveAll(accountId: string, records: readonly OutboxRecord[]): Promise<void>;
  clear(accountId: string): Promise<void>;
  withSendLock?<T>(
    accountId: string,
    clientMessageId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  getAcceptedReceipt?(
    accountId: string,
    clientMessageId: string,
  ): Promise<OutboxAcceptedReceipt | null>;
}

/**
 * Deterministic in-memory adapter storing deep-cloned encrypted envelope
 * records per account (zero plaintext, zero `localStorage`).
 */
export class InMemoryOutboxStorageAdapter implements OutboxStorageAdapter {
  readonly persistent = false;
  private readonly storeByAccount = new Map<string, OutboxRecord[]>();
  private available = true;

  setAvailable(available: boolean): void {
    this.available = available;
  }

  simulateExternalEviction(accountId: string): void {
    this.storeByAccount.delete(accountId);
  }

  async loadAll(accountId: string): Promise<OutboxRecord[]> {
    if (!this.available) {
      throw new OutboxStorageError(
        "STORAGE_UNAVAILABLE",
        "Encrypted local outbox storage is unavailable in this browser context.",
      );
    }
    const items = this.storeByAccount.get(accountId) ?? [];
    return items.map((item) => {
      assertValidOutboxRecord(item);
      return cloneOutboxRecord(item);
    });
  }

  async saveAll(accountId: string, records: readonly OutboxRecord[]): Promise<void> {
    if (!this.available) {
      throw new OutboxStorageError(
        "STORAGE_UNAVAILABLE",
        "Encrypted local outbox storage is unavailable in this browser context.",
      );
    }
    const validated = records.map((item) => {
      assertValidOutboxRecord(item);
      return cloneOutboxRecord(item);
    });
    this.storeByAccount.set(accountId, validated);
  }

  async clear(accountId: string): Promise<void> {
    this.storeByAccount.delete(accountId);
  }
}

export interface EncryptedIndexedDbOutboxStorageAdapterOptions {
  idbFactory?: IDBFactory | null;
  lockManager?: LockManagerLike | null;
  subtle?: SubtleCrypto | null;
  dbName?: string;
  requireWebLocks?: boolean;
  forbiddenReuseKeys?: readonly CryptoKey[];
  nowMs?: () => number;
}

export interface OutboxAtRestInspection {
  hasKey: boolean;
  keyExtractable: boolean | null;
  keyAlgorithm: string | null;
  keyId: string | null;
  sealedEntries: SealedOutboxEntryRecord[];
  meta: OutboxMetaRecord | null;
}

function mutateLockName(accountId: string): string {
  return `chat:outbox:mutate:${accountId}`;
}

function sendLockName(accountId: string, clientMessageId: string): string {
  return `chat:outbox:send:${accountId}:${clientMessageId}`;
}

function trimAcceptedReceiptCache(
  cache: Record<string, OutboxAcceptedReceipt>,
): Record<string, OutboxAcceptedReceipt> {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_ACCEPTED_RECEIPT_CACHE) {
    return cache;
  }
  const keepKeys = keys.slice(keys.length - MAX_ACCEPTED_RECEIPT_CACHE);
  const next: Record<string, OutboxAcceptedReceipt> = {};
  for (const k of keepKeys) {
    const receipt = cache[k];
    if (receipt) next[k] = receipt;
  }
  return next;
}

function mapStorageException(error: unknown, fallbackMessage: string): never {
  if (error instanceof OutboxStorageError) {
    throw error;
  }
  if (error instanceof OutboxCryptoError) {
    if (error.code === "KEY_REUSE_FORBIDDEN" || error.code === "FORBIDDEN_PLAINTEXT_FIELD") {
      throw error;
    }
    if (error.code === "WEB_CRYPTO_UNAVAILABLE") {
      throw new OutboxStorageError("STORAGE_UNAVAILABLE", error.message);
    }
    throw new OutboxStorageError("CORRUPT_OUTBOX", error.message);
  }
  throw new OutboxStorageError(
    "STORAGE_UNAVAILABLE",
    error instanceof Error && error.message ? error.message : fallbackMessage,
  );
}

/**
 * Durable AES-256-GCM IndexedDB + Web Locks outbox adapter (`P2-09`,
 * `FR-CHAT-008`, `DATA-013`, `DEC-021` §6.1).
 */
export class EncryptedIndexedDbOutboxStorageAdapter implements OutboxStorageAdapter {
  readonly persistent = true;
  private readonly backend: BrowserIndexedDbOutboxBackend;
  private readonly lock: WebLocksSingleWriterLock;
  private readonly subtle: SubtleCrypto | null | undefined;
  private readonly forbiddenReuseKeys: readonly CryptoKey[] | undefined;
  private readonly nowMs: () => number;

  constructor(options: EncryptedIndexedDbOutboxStorageAdapterOptions = {}) {
    this.backend = new BrowserIndexedDbOutboxBackend({
      idbFactory: options.idbFactory,
      dbName: options.dbName,
    });
    this.lock = new WebLocksSingleWriterLock({
      lockManager: options.lockManager,
      requireWebLocks: options.requireWebLocks,
    });
    this.subtle = options.subtle;
    this.forbiddenReuseKeys = options.forbiddenReuseKeys;
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  private assertBackendAvailable(): void {
    if (!this.backend.hasIndexedDb) {
      throw new OutboxStorageError(
        "STORAGE_UNAVAILABLE",
        "IndexedDB outbox storage is unavailable in this browser context.",
      );
    }
  }

  async loadAll(accountId: string): Promise<OutboxRecord[]> {
    this.assertBackendAvailable();
    try {
      return await this.lock.acquire(mutateLockName(accountId), async () => {
        const state = await this.backend.readAccountState(accountId);

        if (
          state.entries.length > 0 &&
          (!state.keyRecord ||
            (state.metaRecord && state.keyRecord.keyId !== state.metaRecord.keyId))
        ) {
          await this.backend.writeAccountState({
            accountId,
            keyRecord: state.keyRecord ?? undefined,
            entries: [],
            metaRecord: {
              accountId,
              keyId: state.keyRecord?.keyId ?? state.metaRecord?.keyId ?? newKeyId(),
              pendingCount: 0,
              lastAcceptedByClientId: state.metaRecord?.lastAcceptedByClientId ?? {},
              updatedAtMs: this.nowMs(),
            },
          });
          throw new OutboxStorageError(
            "STORAGE_CLEARED",
            "Encrypted outbox key was evicted or cleared from IndexedDB.",
          );
        }

        if (state.entries.length === 0 && state.metaRecord && state.metaRecord.pendingCount > 0) {
          await this.backend.writeAccountState({
            accountId,
            keyRecord: state.keyRecord ?? undefined,
            entries: [],
            metaRecord: {
              ...state.metaRecord,
              pendingCount: 0,
              updatedAtMs: this.nowMs(),
            },
          });
          throw new OutboxStorageError(
            "STORAGE_CLEARED",
            "Pending encrypted outbox entries were cleared from browser storage.",
          );
        }

        if (state.entries.length === 0 || !state.keyRecord) {
          return [];
        }

        assertValidOutboxStorageKey(state.keyRecord.key, {
          forbiddenKeys: this.forbiddenReuseKeys,
        });

        const unsealed: OutboxRecord[] = [];
        for (const sealed of state.entries) {
          const inner = await unsealOutboxEntry<OutboxRecord>({
            sealed,
            expectedAccountId: accountId,
            expectedKeyId: state.keyRecord.keyId,
            key: state.keyRecord.key,
            forbiddenReuseKeys: this.forbiddenReuseKeys,
            subtle: this.subtle,
          });
          if (
            inner.accountId !== sealed.accountId ||
            inner.conversationId !== sealed.conversationId ||
            inner.clientMessageId !== sealed.clientMessageId ||
            inner.senderDeviceId !== sealed.senderDeviceId ||
            inner.payloadHash !== sealed.payloadHash
          ) {
            throw new OutboxStorageError(
              "CORRUPT_OUTBOX",
              "Sealed outbox metadata does not match unsealed entry identity.",
            );
          }
          assertValidOutboxRecord(inner);
          unsealed.push(cloneOutboxRecord(inner));
        }

        unsealed.sort(
          (a, b) =>
            a.createdAtMs - b.createdAtMs || a.clientMessageId.localeCompare(b.clientMessageId),
        );
        return unsealed;
      });
    } catch (error) {
      mapStorageException(error, "Unable to read encrypted local outbox from IndexedDB.");
    }
  }

  async saveAll(accountId: string, records: readonly OutboxRecord[]): Promise<void> {
    for (const item of records) {
      assertValidOutboxRecord(item);
      assertNoOutboxPlaintextOrSecrets(item);
      if (item.accountId !== accountId) {
        throw new OutboxStorageError(
          "CORRUPT_OUTBOX",
          "Outbox record accountId does not match active IndexedDB storage scope.",
        );
      }
    }

    this.assertBackendAvailable();
    try {
      await this.lock.acquire(mutateLockName(accountId), async () => {
        const state = await this.backend.readAccountState(accountId);
        let keyRecord = state.keyRecord;
        if (!keyRecord) {
          const key = await generateOutboxStorageKey(this.subtle);
          keyRecord = {
            accountId,
            keyId: newKeyId(),
            key,
            createdAtMs: this.nowMs(),
          };
        }

        assertValidOutboxStorageKey(keyRecord.key, {
          forbiddenKeys: this.forbiddenReuseKeys,
        });

        const nextAccepted: Record<string, OutboxAcceptedReceipt> = {
          ...(state.metaRecord?.lastAcceptedByClientId ?? {}),
        };

        const recordsToPersist: OutboxRecord[] = [];
        for (const item of records) {
          if (
            item.status === "sent" &&
            item.committedMessageId &&
            item.committedSeq !== null &&
            item.committedAt
          ) {
            // DEC-021 §6.2: Accepted items leave persistent outbox storage and retain only deduplication metadata.
            delete nextAccepted[item.clientMessageId];
            nextAccepted[item.clientMessageId] = {
              messageId: item.committedMessageId,
              seq: item.committedSeq,
              committedAt: item.committedAt,
            };
            continue;
          }

          if (item.status === "failed" && item.failureReason === "device_revoked") {
            // DEC-021 §6.1 & FR-SEC-010: Discard queued ciphertext on device revocation.
            continue;
          }

          recordsToPersist.push(cloneOutboxRecord(item));
        }

        const sealedEntries: SealedOutboxEntryRecord[] = [];
        for (const record of recordsToPersist) {
          const sealed = await sealOutboxEntry({
            meta: {
              schemaVersion: 1,
              accountId: record.accountId,
              conversationId: record.conversationId,
              clientMessageId: record.clientMessageId,
              senderDeviceId: record.senderDeviceId,
              protocolVersion: record.payload.protocolVersion,
              payloadHash: record.payloadHash,
              createdAtMs: record.createdAtMs,
              updatedAtMs: record.updatedAtMs,
            },
            keyId: keyRecord.keyId,
            key: keyRecord.key,
            inner: record,
            forbiddenReuseKeys: this.forbiddenReuseKeys,
            subtle: this.subtle,
          });
          sealedEntries.push(sealed);
        }

        await this.backend.writeAccountState({
          accountId,
          keyRecord,
          entries: sealedEntries,
          metaRecord: {
            accountId,
            keyId: keyRecord.keyId,
            pendingCount: sealedEntries.length,
            lastAcceptedByClientId: trimAcceptedReceiptCache(nextAccepted),
            updatedAtMs: this.nowMs(),
          },
        });
      });
    } catch (error) {
      mapStorageException(error, "Unable to persist encrypted local outbox to IndexedDB.");
    }
  }

  async clear(accountId: string): Promise<void> {
    if (!this.backend.hasIndexedDb) {
      return;
    }
    try {
      await this.lock.acquire(mutateLockName(accountId), async () => {
        await this.backend.deleteAccountState(accountId);
      });
    } catch (error) {
      mapStorageException(error, "Unable to clear encrypted outbox from IndexedDB.");
    }
  }

  async withSendLock<T>(
    accountId: string,
    clientMessageId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.lock.acquire(sendLockName(accountId, clientMessageId), operation);
  }

  async getAcceptedReceipt(
    accountId: string,
    clientMessageId: string,
  ): Promise<OutboxAcceptedReceipt | null> {
    if (!this.backend.hasIndexedDb) {
      return null;
    }
    return this.lock.acquire(mutateLockName(accountId), async () => {
      const state = await this.backend.readAccountState(accountId);
      return state.metaRecord?.lastAcceptedByClientId[clientMessageId] ?? null;
    });
  }

  async inspectAtRest(accountId: string): Promise<OutboxAtRestInspection> {
    if (!this.backend.hasIndexedDb) {
      return {
        hasKey: false,
        keyExtractable: null,
        keyAlgorithm: null,
        keyId: null,
        sealedEntries: [],
        meta: null,
      };
    }
    return this.lock.acquire(mutateLockName(accountId), async () => {
      const state = await this.backend.readAccountState(accountId);
      const alg = state.keyRecord?.key?.algorithm as { name?: string; length?: number } | undefined;
      return {
        hasKey: Boolean(state.keyRecord?.key),
        keyExtractable: state.keyRecord?.key ? state.keyRecord.key.extractable : null,
        keyAlgorithm: alg?.name ? `${alg.name}-${alg.length ?? 256}` : null,
        keyId: state.keyRecord?.keyId ?? null,
        sealedEntries: state.entries,
        meta: state.metaRecord,
      };
    });
  }

  async simulateKeyEviction(accountId: string): Promise<void> {
    this.assertBackendAvailable();
    await this.lock.acquire(mutateLockName(accountId), async () => {
      await this.backend.evictAccountKeyOnly(accountId);
    });
  }

  async simulateEntriesEviction(accountId: string): Promise<void> {
    this.assertBackendAvailable();
    await this.lock.acquire(mutateLockName(accountId), async () => {
      await this.backend.evictAccountEntriesOnly(accountId);
    });
  }

  async simulateCiphertextTamper(accountId: string, clientMessageId: string): Promise<boolean> {
    this.assertBackendAvailable();
    return this.lock.acquire(mutateLockName(accountId), async () => {
      return this.backend.tamperSealedEntry(`${accountId}:${clientMessageId}`, (entry) => {
        const raw = base64UrlDecode(entry.ciphertext);
        const corrupted = new Uint8Array(raw);
        corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] ?? 0) ^ 0xff;
        return {
          ...entry,
          ciphertext: base64UrlEncode(corrupted),
        };
      });
    });
  }
}
