import type { DeviceIdentityMaterial, PeerKeyState } from "@chat/crypto";

/**
 * Endpoint identity storage (P2-01, DEC-002 §4.5).
 *
 * Non-extractable CryptoKey objects are stored in IndexedDB via structured
 * clone. Private keys never enter localStorage, cookies, logs, or requests.
 * A Web Lock serializes mutations so two tabs cannot race the same identity.
 */
export type DeviceStorageErrorCode =
  | "INDEXEDDB_UNAVAILABLE"
  | "STORAGE_DENIED"
  | "STORAGE_BLOCKED"
  | "LOCK_UNAVAILABLE"
  | "USER_MISMATCH"
  | "CORRUPT";

export class DeviceStorageError extends Error {
  constructor(
    readonly code: DeviceStorageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DeviceStorageError";
  }
}

export interface StoredDeviceIdentity extends DeviceIdentityMaterial {
  userId: string;
}

interface StoredPeerTrust {
  id: string;
  ownerUserId: string;
  state: PeerKeyState;
}

const DB_NAME = "chat-device-v1";
const DB_VERSION = 1;
const IDENTITY_STORE = "identity";
const PEER_TRUST_STORE = "peer-trust";

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new DeviceStorageError(
        "INDEXEDDB_UNAVAILABLE",
        "IndexedDB is unavailable; device keys cannot be stored safely.",
      ),
    );
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDENTITY_STORE)) {
        db.createObjectStore(IDENTITY_STORE, { keyPath: "userId" });
      }
      if (!db.objectStoreNames.contains(PEER_TRUST_STORE)) {
        db.createObjectStore(PEER_TRUST_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new DeviceStorageError("STORAGE_DENIED", "Device storage could not be opened."));
    request.onblocked = () =>
      reject(
        new DeviceStorageError("STORAGE_BLOCKED", "Device storage is blocked by another open tab."),
      );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(new DeviceStorageError("STORAGE_DENIED", "Device storage transaction failed."));
    transaction.onabort = () =>
      reject(new DeviceStorageError("STORAGE_DENIED", "Device storage transaction was aborted."));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new DeviceStorageError("STORAGE_DENIED", "Device storage request failed."));
  });
}

export async function loadDeviceIdentity(userId: string): Promise<StoredDeviceIdentity | null> {
  const db = await openDb();
  try {
    const transaction = db.transaction(IDENTITY_STORE, "readonly");
    const result = await requestResult(
      transaction.objectStore(IDENTITY_STORE).get(userId) as IDBRequest<
        StoredDeviceIdentity | undefined
      >,
    );
    return result ?? null;
  } finally {
    db.close();
  }
}

export async function saveDeviceIdentity(identity: StoredDeviceIdentity): Promise<void> {
  const db = await openDb();
  try {
    const transaction = db.transaction(IDENTITY_STORE, "readwrite");
    transaction.objectStore(IDENTITY_STORE).put(identity);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function deleteDeviceIdentity(userId: string): Promise<void> {
  const db = await openDb();
  try {
    const transaction = db.transaction(IDENTITY_STORE, "readwrite");
    transaction.objectStore(IDENTITY_STORE).delete(userId);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function loadPeerTrustStates(ownerUserId: string): Promise<PeerKeyState[]> {
  const db = await openDb();
  try {
    const transaction = db.transaction(PEER_TRUST_STORE, "readonly");
    const all = await requestResult(
      transaction.objectStore(PEER_TRUST_STORE).getAll() as IDBRequest<StoredPeerTrust[]>,
    );
    return all.filter((entry) => entry.ownerUserId === ownerUserId).map((entry) => entry.state);
  } finally {
    db.close();
  }
}

export async function savePeerTrustState(ownerUserId: string, state: PeerKeyState): Promise<void> {
  const db = await openDb();
  try {
    const transaction = db.transaction(PEER_TRUST_STORE, "readwrite");
    const entry: StoredPeerTrust = {
      id: `${ownerUserId}\u0000${state.peerUserId}`,
      ownerUserId,
      state,
    };
    transaction.objectStore(PEER_TRUST_STORE).put(entry);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function deletePeerTrustState(ownerUserId: string, peerUserId: string): Promise<void> {
  const db = await openDb();
  try {
    const transaction = db.transaction(PEER_TRUST_STORE, "readwrite");
    transaction.objectStore(PEER_TRUST_STORE).delete(`${ownerUserId}\u0000${peerUserId}`);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

/** Single-writer lock for identity/session mutations across tabs (DEC-002). */
export async function withDeviceLock<T>(userId: string, work: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    throw new DeviceStorageError(
      "LOCK_UNAVAILABLE",
      "Web Locks is unavailable; concurrent device state cannot be serialized safely.",
    );
  }
  return navigator.locks.request(`chat-device:${userId}`, { mode: "exclusive" }, () => work());
}
