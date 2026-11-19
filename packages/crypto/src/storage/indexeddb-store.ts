import { assertNoOutboxPlaintextOrSecrets, type SealedOutboxEntryRecord } from "./outbox-crypto.js";

/**
 * Atomic IndexedDB storage backend and standards-compatible in-memory
 * `IDBFactory` test harness for the offline encrypted outbox (`P2-09`,
 * `FR-CHAT-008`, `DATA-013`, `DEC-021` §6.1, `DEC-002` §4.1).
 *
 * Uses three object stores:
 * - `"outbox_keys"`: dedicated non-extractable AES-256-GCM `CryptoKey` per account
 * - `"outbox_entries"`: AES-GCM sealed entries indexed by `"by_account"`
 * - `"outbox_meta"`: pending-entry count + bounded accepted-receipt map for multi-tab dedupe
 */

export const OUTBOX_IDB_DEFAULT_NAME = "chat_encrypted_outbox_v1" as const;
export const OUTBOX_IDB_VERSION = 1 as const;
export const OUTBOX_STORE_KEYS = "outbox_keys" as const;
export const OUTBOX_STORE_ENTRIES = "outbox_entries" as const;
export const OUTBOX_STORE_META = "outbox_meta" as const;
export const OUTBOX_ACCOUNT_INDEX = "by_account" as const;

export interface OutboxKeyRecord {
  accountId: string;
  keyId: string;
  key: CryptoKey;
  createdAtMs: number;
}

export interface OutboxAcceptedReceipt {
  messageId: string;
  seq: number;
  committedAt: string;
}

export interface OutboxMetaRecord {
  accountId: string;
  keyId: string;
  pendingCount: number;
  lastAcceptedByClientId: Record<string, OutboxAcceptedReceipt>;
  updatedAtMs: number;
}

export interface AccountIndexedDbState {
  keyRecord: OutboxKeyRecord | null;
  metaRecord: OutboxMetaRecord | null;
  entries: SealedOutboxEntryRecord[];
}

export interface WriteAccountIndexedDbStateInput {
  accountId: string;
  keyRecord?: OutboxKeyRecord;
  entries: readonly SealedOutboxEntryRecord[];
  metaRecord: OutboxMetaRecord;
}

export class BrowserIndexedDbOutboxBackend {
  private readonly idbFactory: IDBFactory | null;
  readonly dbName: string;

  constructor(options?: { idbFactory?: IDBFactory | null; dbName?: string }) {
    this.idbFactory =
      options?.idbFactory !== undefined ? options.idbFactory : (globalThis.indexedDB ?? null);
    this.dbName = options?.dbName ?? OUTBOX_IDB_DEFAULT_NAME;
  }

  get hasIndexedDb(): boolean {
    return this.idbFactory !== null;
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (!this.idbFactory) {
      return Promise.reject(new Error("IndexedDB is unavailable in this browser context."));
    }
    const factory = this.idbFactory;
    return new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = factory.open(this.dbName, OUTBOX_IDB_VERSION);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OUTBOX_STORE_KEYS)) {
          db.createObjectStore(OUTBOX_STORE_KEYS, { keyPath: "accountId" });
        }
        if (!db.objectStoreNames.contains(OUTBOX_STORE_ENTRIES)) {
          const entryStore = db.createObjectStore(OUTBOX_STORE_ENTRIES, {
            keyPath: "storageKey",
          });
          entryStore.createIndex(OUTBOX_ACCOUNT_INDEX, "accountId", { unique: false });
        }
        if (!db.objectStoreNames.contains(OUTBOX_STORE_META)) {
          db.createObjectStore(OUTBOX_STORE_META, { keyPath: "accountId" });
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error("Failed to open IndexedDB outbox database."));
      };
      request.onblocked = () => {
        reject(new Error("IndexedDB outbox database upgrade was blocked."));
      };
    });
  }

  private async withDb<T>(operation: (db: IDBDatabase) => Promise<T>): Promise<T> {
    const db = await this.openDatabase();
    try {
      return await operation(db);
    } finally {
      db.close();
    }
  }

  async readAccountState(accountId: string): Promise<AccountIndexedDbState> {
    return this.withDb(
      (db) =>
        new Promise<AccountIndexedDbState>((resolve, reject) => {
          const tx = db.transaction(
            [OUTBOX_STORE_KEYS, OUTBOX_STORE_ENTRIES, OUTBOX_STORE_META],
            "readonly",
          );
          const keysStore = tx.objectStore(OUTBOX_STORE_KEYS);
          const entriesStore = tx.objectStore(OUTBOX_STORE_ENTRIES);
          const metaStore = tx.objectStore(OUTBOX_STORE_META);

          const keyReq = keysStore.get(accountId);
          const metaReq = metaStore.get(accountId);
          const entriesReq = entriesStore.index(OUTBOX_ACCOUNT_INDEX).getAll(accountId);

          tx.oncomplete = () => {
            resolve({
              keyRecord: (keyReq.result as OutboxKeyRecord | undefined) ?? null,
              metaRecord: (metaReq.result as OutboxMetaRecord | undefined) ?? null,
              entries: ((entriesReq.result as SealedOutboxEntryRecord[] | undefined) ?? []).map(
                (entry) => ({ ...entry }),
              ),
            });
          };
          tx.onerror = () => {
            reject(tx.error ?? new Error("Failed reading outbox IndexedDB state."));
          };
          tx.onabort = () => {
            reject(tx.error ?? new Error("IndexedDB read transaction aborted."));
          };
        }),
    );
  }

  async writeAccountState(input: WriteAccountIndexedDbStateInput): Promise<void> {
    for (const entry of input.entries) {
      assertNoOutboxPlaintextOrSecrets(entry);
    }

    await this.withDb(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(
            [OUTBOX_STORE_KEYS, OUTBOX_STORE_ENTRIES, OUTBOX_STORE_META],
            "readwrite",
          );
          const keysStore = tx.objectStore(OUTBOX_STORE_KEYS);
          const entriesStore = tx.objectStore(OUTBOX_STORE_ENTRIES);
          const metaStore = tx.objectStore(OUTBOX_STORE_META);

          if (input.keyRecord) {
            keysStore.put(input.keyRecord);
          }
          metaStore.put(input.metaRecord);

          const existingReq = entriesStore.index(OUTBOX_ACCOUNT_INDEX).getAll(input.accountId);
          existingReq.onsuccess = () => {
            const existing = (existingReq.result as SealedOutboxEntryRecord[] | undefined) ?? [];
            for (const row of existing) {
              entriesStore.delete(row.storageKey);
            }
            for (const next of input.entries) {
              entriesStore.put(next);
            }
          };

          tx.oncomplete = () => resolve();
          tx.onerror = () => {
            reject(tx.error ?? new Error("Failed writing outbox IndexedDB state."));
          };
          tx.onabort = () => {
            reject(tx.error ?? new Error("IndexedDB write transaction aborted."));
          };
        }),
    );
  }

  async deleteAccountState(accountId: string): Promise<void> {
    await this.withDb(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(
            [OUTBOX_STORE_KEYS, OUTBOX_STORE_ENTRIES, OUTBOX_STORE_META],
            "readwrite",
          );
          const keysStore = tx.objectStore(OUTBOX_STORE_KEYS);
          const entriesStore = tx.objectStore(OUTBOX_STORE_ENTRIES);
          const metaStore = tx.objectStore(OUTBOX_STORE_META);

          keysStore.delete(accountId);
          metaStore.delete(accountId);

          const existingReq = entriesStore.index(OUTBOX_ACCOUNT_INDEX).getAll(accountId);
          existingReq.onsuccess = () => {
            const existing = (existingReq.result as SealedOutboxEntryRecord[] | undefined) ?? [];
            for (const row of existing) {
              entriesStore.delete(row.storageKey);
            }
          };

          tx.oncomplete = () => resolve();
          tx.onerror = () => {
            reject(tx.error ?? new Error("Failed deleting outbox IndexedDB state."));
          };
          tx.onabort = () => {
            reject(tx.error ?? new Error("IndexedDB delete transaction aborted."));
          };
        }),
    );
  }

  /**
   * Simulates browser eviction/clearing of only `"outbox_keys"` while
   * sealed ciphertext rows remain on disk (deterministic fault injection).
   */
  async evictAccountKeyOnly(accountId: string): Promise<void> {
    await this.withDb(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction([OUTBOX_STORE_KEYS], "readwrite");
          tx.objectStore(OUTBOX_STORE_KEYS).delete(accountId);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("Failed to evict account outbox key."));
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB key-evict aborted."));
        }),
    );
  }

  /**
   * Simulates partial clearing of `"outbox_entries"` while metadata still
   * records pending entries (`STORAGE_CLEARED` detection path).
   */
  async evictAccountEntriesOnly(accountId: string): Promise<void> {
    await this.withDb(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction([OUTBOX_STORE_ENTRIES], "readwrite");
          const entriesStore = tx.objectStore(OUTBOX_STORE_ENTRIES);
          const existingReq = entriesStore.index(OUTBOX_ACCOUNT_INDEX).getAll(accountId);
          existingReq.onsuccess = () => {
            const existing = (existingReq.result as SealedOutboxEntryRecord[] | undefined) ?? [];
            for (const row of existing) {
              entriesStore.delete(row.storageKey);
            }
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error ?? new Error("Failed to evict outbox entries."));
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB entry-evict aborted."));
        }),
    );
  }

  /**
   * Mutates a persisted sealed record directly in IndexedDB to test AES-256-GCM
   * tamper/corruption detection.
   */
  async tamperSealedEntry(
    storageKey: string,
    mutator: (entry: SealedOutboxEntryRecord) => SealedOutboxEntryRecord,
  ): Promise<boolean> {
    return this.withDb(
      (db) =>
        new Promise<boolean>((resolve, reject) => {
          let mutated = false;
          const tx = db.transaction([OUTBOX_STORE_ENTRIES], "readwrite");
          const entriesStore = tx.objectStore(OUTBOX_STORE_ENTRIES);
          const getReq = entriesStore.get(storageKey);
          getReq.onsuccess = () => {
            const current = getReq.result as SealedOutboxEntryRecord | undefined;
            if (!current) {
              return;
            }
            entriesStore.put(mutator({ ...current }));
            mutated = true;
          };
          tx.oncomplete = () => resolve(mutated);
          tx.onerror = () => reject(tx.error ?? new Error("Failed to tamper sealed outbox entry."));
          tx.onabort = () => reject(tx.error ?? new Error("IndexedDB tamper transaction aborted."));
        }),
    );
  }
}

function isCryptoKeyLike(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CryptoKey>;
  return (
    typeof candidate.extractable === "boolean" &&
    typeof candidate.type === "string" &&
    typeof candidate.algorithm === "object" &&
    Array.isArray(candidate.usages)
  );
}

function cloneIdbValue<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (isCryptoKeyLike(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneIdbValue(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = cloneIdbValue(v);
  }
  return out as T;
}

interface InMemoryStoreBacking {
  keyPath: string;
  records: Map<string, Record<string, unknown>>;
  indexes: Map<string, { keyPath: string }>;
}

interface InMemoryDbBacking {
  version: number;
  stores: Map<string, InMemoryStoreBacking>;
}

/**
 * Standards-compatible in-memory `IDBFactory` harness so `BrowserIndexedDbOutboxBackend`
 * and `EncryptedIndexedDbOutboxStorageAdapter` execute their real IndexedDB
 * transaction/upgrade/index code paths inside Node Vitest tests.
 */
export function createInMemoryIdbFactory(): IDBFactory & {
  setAvailable(available: boolean): void;
} {
  let available = true;
  const databases = new Map<string, InMemoryDbBacking>();

  function makeDomStringList(items: string[]): DOMStringList {
    return {
      length: items.length,
      item: (index: number) => items[index] ?? null,
      contains: (name: string) => items.includes(name),
      [Symbol.iterator]: () => items[Symbol.iterator](),
    } as DOMStringList;
  }

  function createRequest<T>(txNotify?: { register(): void; done(): void }): {
    req: Record<string, unknown>;
    resolve: (result: T) => void;
    reject: (error: unknown) => void;
  } {
    txNotify?.register();
    const req: Record<string, unknown> = {
      result: undefined,
      error: null,
      readyState: "pending",
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    };

    const resolve = (result: T) => {
      req.result = result;
      req.readyState = "done";
      if (typeof req.onsuccess === "function") {
        (req.onsuccess as (ev: unknown) => void)({ target: req });
      }
      txNotify?.done();
    };

    const reject = (error: unknown) => {
      req.error = error instanceof Error ? error : new Error(String(error));
      req.readyState = "done";
      if (typeof req.onerror === "function") {
        (req.onerror as (ev: unknown) => void)({ target: req });
      }
      txNotify?.done();
    };

    return { req, resolve, reject };
  }

  const factory = {
    setAvailable(nextAvailable: boolean) {
      available = nextAvailable;
    },
    open(name: string, version = 1): IDBOpenDBRequest {
      const { req, resolve, reject } = createRequest<IDBDatabase>();
      queueMicrotask(() => {
        if (!available) {
          reject(new Error("IndexedDB is unavailable in this simulated browser context."));
          return;
        }
        let backing = databases.get(name);
        const needsUpgrade = !backing || backing.version < version;
        if (!backing) {
          backing = { version, stores: new Map() };
          databases.set(name, backing);
        } else {
          backing.version = version;
        }

        const currentBacking = backing;
        const dbHandle = {
          name,
          version: currentBacking.version,
          get objectStoreNames(): DOMStringList {
            return makeDomStringList(Array.from(currentBacking.stores.keys()));
          },
          createObjectStore(storeName: string, options?: IDBObjectStoreParameters): IDBObjectStore {
            const keyPath = typeof options?.keyPath === "string" ? options.keyPath : "id";
            const storeBacking: InMemoryStoreBacking = {
              keyPath,
              records: new Map(),
              indexes: new Map(),
            };
            currentBacking.stores.set(storeName, storeBacking);
            return {
              name: storeName,
              createIndex(indexName: string, indexKeyPath: string) {
                storeBacking.indexes.set(indexName, { keyPath: indexKeyPath });
                return {} as IDBIndex;
              },
            } as unknown as IDBObjectStore;
          },
          transaction(storeNames: string | string[], mode: IDBTransactionMode = "readonly") {
            const allowedStores = Array.isArray(storeNames) ? storeNames : [storeNames];
            let pendingCount = 0;
            let scheduledComplete = false;
            const tx: Record<string, unknown> = {
              mode,
              error: null,
              oncomplete: null,
              onerror: null,
              onabort: null,
            };

            const maybeComplete = () => {
              if (pendingCount === 0 && !scheduledComplete) {
                scheduledComplete = true;
                queueMicrotask(() => {
                  if (pendingCount === 0 && typeof tx.oncomplete === "function") {
                    (tx.oncomplete as (ev: unknown) => void)({ target: tx });
                  }
                });
              }
            };

            const txNotify = {
              register() {
                pendingCount += 1;
                scheduledComplete = false;
              },
              done() {
                pendingCount -= 1;
                maybeComplete();
              },
            };

            tx.objectStore = (storeName: string): IDBObjectStore => {
              if (!allowedStores.includes(storeName)) {
                throw new Error(`Store "${storeName}" is not part of transaction.`);
              }
              const storeBacking = currentBacking.stores.get(storeName);
              if (!storeBacking) {
                throw new Error(`Object store "${storeName}" not found.`);
              }

              const get = (key: IDBValidKey) => {
                const r = createRequest<unknown>(txNotify);
                queueMicrotask(() => {
                  if (!available) {
                    const err = new Error("IndexedDB became unavailable.");
                    tx.error = err;
                    r.reject(err);
                    if (typeof tx.onerror === "function") {
                      (tx.onerror as (ev: unknown) => void)({ target: tx });
                    }
                    return;
                  }
                  const val = storeBacking.records.get(String(key));
                  r.resolve(val === undefined ? undefined : cloneIdbValue(val));
                });
                return r.req as unknown as IDBRequest;
              };

              const put = (value: Record<string, unknown>) => {
                if (mode === "readonly") {
                  throw new Error("Cannot mutate inside readonly transaction.");
                }
                const r = createRequest<IDBValidKey>(txNotify);
                const keyVal = String(value[storeBacking.keyPath]);
                queueMicrotask(() => {
                  if (!available) {
                    const err = new Error("IndexedDB became unavailable.");
                    tx.error = err;
                    r.reject(err);
                    if (typeof tx.onerror === "function") {
                      (tx.onerror as (ev: unknown) => void)({ target: tx });
                    }
                    return;
                  }
                  storeBacking.records.set(keyVal, cloneIdbValue(value));
                  r.resolve(keyVal);
                });
                return r.req as unknown as IDBRequest<IDBValidKey>;
              };

              const del = (key: IDBValidKey) => {
                if (mode === "readonly") {
                  throw new Error("Cannot delete inside readonly transaction.");
                }
                const r = createRequest<undefined>(txNotify);
                queueMicrotask(() => {
                  storeBacking.records.delete(String(key));
                  r.resolve(undefined);
                });
                return r.req as unknown as IDBRequest<undefined>;
              };

              const index = (indexName: string): IDBIndex => {
                const idx = storeBacking.indexes.get(indexName);
                if (!idx) {
                  throw new Error(`Index "${indexName}" not found on store "${storeName}".`);
                }
                return {
                  getAll(query?: unknown) {
                    const r = createRequest<unknown[]>(txNotify);
                    queueMicrotask(() => {
                      const matches: unknown[] = [];
                      for (const row of storeBacking.records.values()) {
                        if (query === undefined || row[idx.keyPath] === query) {
                          matches.push(cloneIdbValue(row));
                        }
                      }
                      r.resolve(matches);
                    });
                    return r.req as unknown as IDBRequest<unknown[]>;
                  },
                } as unknown as IDBIndex;
              };

              return {
                get,
                put,
                delete: del,
                index,
              } as unknown as IDBObjectStore;
            };

            queueMicrotask(maybeComplete);
            return tx as unknown as IDBTransaction;
          },
          close() {
            // no-op for in-memory backing
          },
        } as unknown as IDBDatabase;

        if (needsUpgrade && typeof req.onupgradeneeded === "function") {
          req.result = dbHandle;
          (req.onupgradeneeded as (ev: unknown) => void)({ target: req });
        }
        resolve(dbHandle);
      });

      return req as unknown as IDBOpenDBRequest;
    },
  };

  return factory as unknown as IDBFactory & { setAvailable(available: boolean): void };
}
