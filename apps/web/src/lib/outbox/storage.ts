import { assertValidOutboxRecord, cloneOutboxRecord, type OutboxRecord } from "./state";

/**
 * Outbox persistence boundary (`P2-05` / `P2-09`, `FR-CHAT-007`–`FR-CHAT-008`,
 * `DATA-013`, `DEC-021` §6.1).
 *
 * `P2-05` provides the swappable contract and an in-memory adapter plus an
 * explicit unavailable/eviction simulation mode. Durable AES-256-GCM
 * IndexedDB + Web Locks persistence is implemented in `P2-09`. Plaintext
 * localStorage queues are strictly prohibited.
 */
export type OutboxStorageErrorCode = "STORAGE_UNAVAILABLE" | "STORAGE_CLEARED" | "CORRUPT_OUTBOX";

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
