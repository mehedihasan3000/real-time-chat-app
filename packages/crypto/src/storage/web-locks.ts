import type { SingleWriterLock } from "../olm/session.js";
import { OutboxCryptoError } from "./outbox-crypto.js";

/**
 * Web Locks coordination wrapper and deterministic shared fake LockManager
 * for multi-tab single-writer outbox serialization (`DEC-021` §6.1, `DEC-002` §4.1).
 */

export interface LockLike {
  readonly name: string;
  readonly mode: "exclusive" | "shared";
}

export interface LockManagerRequestOptions {
  mode?: "exclusive" | "shared";
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: AbortSignal;
}

export interface LockManagerLike {
  request<T>(name: string, callback: (lock: LockLike | null) => Promise<T> | T): Promise<T>;
  request<T>(
    name: string,
    options: LockManagerRequestOptions,
    callback: (lock: LockLike | null) => Promise<T> | T,
  ): Promise<T>;
}

export interface WebLocksSingleWriterLockOptions {
  lockManager?: LockManagerLike | null;
  requireWebLocks?: boolean;
}

export class WebLocksSingleWriterLock implements SingleWriterLock {
  private readonly lockManager: LockManagerLike | null;
  private readonly requireWebLocks: boolean;
  private readonly inProcessQueues = new Map<string, Promise<unknown>>();

  constructor(options: WebLocksSingleWriterLockOptions = {}) {
    this.lockManager =
      options.lockManager !== undefined
        ? options.lockManager
        : ((globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks ?? null);
    this.requireWebLocks = options.requireWebLocks ?? false;
  }

  get hasWebLocks(): boolean {
    return this.lockManager !== null;
  }

  async acquire<T>(lockName: string, operation: () => Promise<T>): Promise<T> {
    if (this.lockManager) {
      return this.lockManager.request(lockName, { mode: "exclusive" }, async () => operation());
    }
    if (this.requireWebLocks) {
      throw new OutboxCryptoError(
        "WEB_CRYPTO_UNAVAILABLE",
        "Web Locks API is unavailable in this browser context (DEC-009 / DEC-021 §6.1).",
      );
    }

    const previous = this.inProcessQueues.get(lockName) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.inProcessQueues.set(
      lockName,
      previous.then(() => gate),
    );
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.inProcessQueues.get(lockName) === gate) {
        this.inProcessQueues.delete(lockName);
      }
    }
  }

  async tryAcquireIfAvailable<T>(
    lockName: string,
    operation: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    if (this.lockManager) {
      return this.lockManager.request(
        lockName,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) {
            return { acquired: false as const };
          }
          return { acquired: true as const, value: await operation() };
        },
      );
    }
    if (this.requireWebLocks) {
      throw new OutboxCryptoError(
        "WEB_CRYPTO_UNAVAILABLE",
        "Web Locks API is unavailable in this browser context (DEC-009 / DEC-021 §6.1).",
      );
    }
    if (this.inProcessQueues.has(lockName)) {
      return { acquired: false };
    }
    return { acquired: true, value: await this.acquire(lockName, operation) };
  }
}

/**
 * Deterministic in-memory W3C `LockManager`-compatible coordinator so Node unit
 * and integration tests can exercise real multi-tab contention and `ifAvailable`
 * lock behavior without mutating `globalThis.navigator`.
 */
export function createSharedFakeLockManager(): LockManagerLike {
  const activeCounts = new Map<string, number>();
  const waitQueues = new Map<string, Array<() => void>>();

  const request = async <T>(
    name: string,
    optionsOrCallback: LockManagerRequestOptions | ((lock: LockLike | null) => Promise<T> | T),
    maybeCallback?: (lock: LockLike | null) => Promise<T> | T,
  ): Promise<T> => {
    const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
    if (!callback) {
      throw new Error("LockManager.request requires a callback.");
    }

    const mode = options.mode ?? "exclusive";
    const heldCount = activeCounts.get(name) ?? 0;

    if (options.ifAvailable && heldCount > 0) {
      return await callback(null);
    }

    if (heldCount > 0) {
      await new Promise<void>((resolve) => {
        const queue = waitQueues.get(name) ?? [];
        queue.push(resolve);
        waitQueues.set(name, queue);
      });
    }

    activeCounts.set(name, (activeCounts.get(name) ?? 0) + 1);
    try {
      return await callback({ name, mode });
    } finally {
      const remaining = (activeCounts.get(name) ?? 1) - 1;
      if (remaining <= 0) {
        activeCounts.delete(name);
        const queue = waitQueues.get(name);
        if (queue && queue.length > 0) {
          const next = queue.shift()!;
          if (queue.length === 0) {
            waitQueues.delete(name);
          }
          next();
        }
      } else {
        activeCounts.set(name, remaining);
      }
    }
  };

  return { request } as LockManagerLike;
}
