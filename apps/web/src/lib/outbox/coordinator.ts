import { type MessageSendInput, type MessageSendResponse } from "@chat/contracts";

import { MessageSendApiError, type PreparedEncryptedSend } from "../../features/chat/send";

import {
  cloneOutboxRecord,
  createQueuedOutboxEntry,
  markAttemptOutcomeFailure,
  markAttemptStarted,
  markAttemptSucceeded,
  markDeviceRevokedFailure,
  markManualRetry,
  reconcileOutboxAfterReload,
  type OutboxRecord,
} from "./state";
import {
  InMemoryOutboxStorageAdapter,
  OutboxStorageError,
  type OutboxStorageAdapter,
} from "./storage";

/**
 * Stateful Send-State Outbox Coordinator (`P2-05`, `FR-CHAT-007`,
 * `ERR-002`–`ERR-003`; `DEC-021` §5–§6).
 *
 * Manages queued/sending/unknown/sent/failed transitions, bounded jittered
 * retries, reload reconciliation, device-revocation invalidation, and
 * stale-context cancellation (`ERR-003`).
 */

export interface PreparedMessageSender {
  sendPrepared(prepared: PreparedEncryptedSend): Promise<MessageSendResponse>;
}

export interface OutboxSnapshot {
  accountId: string;
  activeConversationId: string | null;
  online: boolean;
  storageAvailable: boolean;
  storageNoticeCode: "STORAGE_UNAVAILABLE" | "STORAGE_CLEARED" | "CORRUPT_OUTBOX" | null;
  logoutWarningPendingCount?: number | null;
  entriesForActiveConversation: OutboxRecord[];
  allEntries: OutboxRecord[];
}

export type OutboxListener = (snapshot: OutboxSnapshot) => void;

export interface SendOutboxCoordinatorOptions {
  accountId: string;
  activeConversationId?: string | null;
  sender: PreparedMessageSender;
  storage?: OutboxStorageAdapter;
  online?: boolean;
  nowMs?: () => number;
  random?: () => number;
  scheduleTimer?: (callback: () => void, delayMs: number) => unknown;
  cancelTimer?: (handle: unknown) => void;
}

const HASH_DOMAIN = ["chat", "message", "payload", "v1"].join(".");

export async function computeClientPayloadHash(input: {
  conversationId: string;
  senderUserId: string;
  senderDeviceId: string;
  clientMessageId: string;
  protocolVersion: MessageSendInput["protocolVersion"];
  encryptedEnvelope: string;
}): Promise<string> {
  const fields = [
    HASH_DOMAIN,
    input.conversationId,
    input.senderUserId,
    input.senderDeviceId,
    input.clientMessageId,
    input.protocolVersion,
    input.encryptedEnvelope,
  ];
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (const field of fields) {
    const valueBytes = encoder.encode(field);
    const prefixBytes = encoder.encode(`${valueBytes.byteLength}:`);
    const newlineBytes = encoder.encode("\n");
    chunks.push(prefixBytes, valueBytes, newlineBytes);
    totalBytes += prefixBytes.byteLength + valueBytes.byteLength + newlineBytes.byteLength;
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", combined);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class SendOutboxCoordinator {
  private accountId: string;
  private activeConversationId: string | null;
  private readonly sender: PreparedMessageSender;
  private readonly storage: OutboxStorageAdapter;
  private readonly nowMs: () => number;
  private readonly random: () => number;
  private readonly scheduleTimerFn: (cb: () => void, delayMs: number) => unknown;
  private readonly cancelTimerFn: (handle: unknown) => void;

  private online: boolean;
  private storageAvailable = true;
  private storageNoticeCode: "STORAGE_UNAVAILABLE" | "STORAGE_CLEARED" | "CORRUPT_OUTBOX" | null =
    null;
  private logoutWarningPendingCount: number | null = null;
  private epoch = 0;
  private entries = new Map<string, OutboxRecord>();
  private canceledIds = new Set<string>();
  private retryTimers = new Map<string, unknown>();
  private inFlightPromises = new Map<string, Promise<OutboxRecord>>();
  private listeners = new Set<OutboxListener>();

  constructor(options: SendOutboxCoordinatorOptions) {
    this.accountId = options.accountId;
    this.activeConversationId = options.activeConversationId ?? null;
    this.sender = options.sender;
    this.storage = options.storage ?? new InMemoryOutboxStorageAdapter();
    this.online = options.online ?? true;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.random = options.random ?? (() => Math.random());
    this.scheduleTimerFn = options.scheduleTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.cancelTimerFn =
      options.cancelTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  subscribe(listener: OutboxListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): OutboxSnapshot {
    const all = Array.from(this.entries.values())
      .map(cloneOutboxRecord)
      .sort(
        (a, b) =>
          a.createdAtMs - b.createdAtMs || a.clientMessageId.localeCompare(b.clientMessageId),
      );
    const filtered =
      this.activeConversationId === null
        ? []
        : all.filter((entry) => entry.conversationId === this.activeConversationId);
    return {
      accountId: this.accountId,
      activeConversationId: this.activeConversationId,
      online: this.online,
      storageAvailable: this.storageAvailable,
      storageNoticeCode: this.storageNoticeCode,
      logoutWarningPendingCount: this.logoutWarningPendingCount,
      entriesForActiveConversation: filtered,
      allEntries: all,
    };
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private clearAllTimers(): void {
    for (const handle of this.retryTimers.values()) {
      this.cancelTimerFn(handle);
    }
    this.retryTimers.clear();
  }

  private clearEntryTimer(clientMessageId: string): void {
    const handle = this.retryTimers.get(clientMessageId);
    if (handle !== undefined) {
      this.cancelTimerFn(handle);
      this.retryTimers.delete(clientMessageId);
    }
  }

  private async persist(): Promise<void> {
    const snapshotList = Array.from(this.entries.values()).map(cloneOutboxRecord);
    try {
      await this.storage.saveAll(this.accountId, snapshotList);
      this.storageAvailable = true;
      if (
        this.storageNoticeCode === "STORAGE_UNAVAILABLE" ||
        this.storageNoticeCode === "CORRUPT_OUTBOX"
      ) {
        this.storageNoticeCode = null;
      }
    } catch (error) {
      if (error instanceof OutboxStorageError) {
        this.storageAvailable = error.code === "STORAGE_CLEARED";
        this.storageNoticeCode = error.code;
        return;
      }
      this.storageAvailable = false;
      this.storageNoticeCode = "STORAGE_UNAVAILABLE";
    }
  }

  setActiveConversation(conversationId: string | null): void {
    this.activeConversationId = conversationId;
    this.emit();
  }

  async setOnline(online: boolean): Promise<void> {
    this.online = online;
    this.emit();
    if (online) {
      await this.flushDue();
    }
  }

  async hydrate(): Promise<void> {
    const capturedEpoch = this.epoch;
    const capturedAccount = this.accountId;
    try {
      const loaded = await this.storage.loadAll(capturedAccount);
      if (capturedEpoch !== this.epoch || capturedAccount !== this.accountId) return;
      this.storageAvailable = true;
      const reconciled = reconcileOutboxAfterReload(loaded, this.nowMs());
      this.entries.clear();
      for (const entry of reconciled) {
        this.entries.set(entry.clientMessageId, entry);
      }
      await this.persist();
      this.emit();
    } catch (error) {
      if (capturedEpoch !== this.epoch || capturedAccount !== this.accountId) return;
      if (error instanceof OutboxStorageError) {
        this.storageAvailable = error.code === "STORAGE_CLEARED";
        this.storageNoticeCode = error.code;
        if (error.code === "STORAGE_CLEARED" || error.code === "CORRUPT_OUTBOX") {
          this.entries.clear();
        }
      } else {
        this.storageAvailable = false;
        this.storageNoticeCode = "STORAGE_UNAVAILABLE";
      }
      this.emit();
    }
  }

  /**
   * Simulate browser reload or tab resume: drops volatile timers and
   * reloads persisted outbox state so any mid-flight `sending` item becomes
   * `unknown` and reconciles on reconnect using its original logical ID.
   */
  async reconcileAfterReload(): Promise<void> {
    const previouslyPendingCount = Array.from(this.entries.values()).filter(
      (entry) =>
        entry.status === "queued" || entry.status === "sending" || entry.status === "unknown",
    ).length;

    this.epoch += 1;
    this.clearAllTimers();
    this.inFlightPromises.clear();
    this.entries.clear();
    this.logoutWarningPendingCount = null;
    this.storageNoticeCode = null;

    await this.hydrate();
    if (previouslyPendingCount > 0 && this.entries.size === 0 && this.storageAvailable) {
      // Previously queued entries vanished from storage across reload.
      this.storageNoticeCode = "STORAGE_CLEARED";
      this.emit();
    }
    if (this.online) {
      await this.flushDue();
    }
  }

  async submitPrepared(prepared: PreparedEncryptedSend): Promise<OutboxRecord> {
    const payloadHash = await computeClientPayloadHash({
      conversationId: prepared.conversationId,
      senderUserId: this.accountId,
      senderDeviceId: prepared.payload.senderDeviceId,
      clientMessageId: prepared.payload.clientMessageId,
      protocolVersion: prepared.payload.protocolVersion,
      encryptedEnvelope: prepared.payload.encryptedEnvelope,
    });

    const entry = createQueuedOutboxEntry({
      accountId: this.accountId,
      conversationId: prepared.conversationId,
      payload: prepared.payload,
      payloadHash,
      nowMs: this.nowMs(),
    });

    this.logoutWarningPendingCount = null;
    if (
      this.storageNoticeCode === "STORAGE_CLEARED" ||
      this.storageNoticeCode === "CORRUPT_OUTBOX"
    ) {
      this.storageNoticeCode = null;
    }
    this.canceledIds.delete(entry.clientMessageId);
    this.entries.set(entry.clientMessageId, entry);
    await this.persist();
    this.emit();

    if (!this.online) {
      const queuedOffline: OutboxRecord = {
        ...cloneOutboxRecord(entry),
        failureReason: "retryable_network",
        errorCode: "NETWORK_ERROR",
        updatedAtMs: this.nowMs(),
      };
      this.entries.set(entry.clientMessageId, queuedOffline);
      await this.persist();
      this.emit();
      return cloneOutboxRecord(queuedOffline);
    }

    return this.dispatchSend(entry.clientMessageId, { countTowardAutoCap: true });
  }

  async manualRetry(clientMessageId: string): Promise<OutboxRecord | null> {
    const existing = this.entries.get(clientMessageId);
    if (!existing) return null;
    if (existing.status === "sent") return cloneOutboxRecord(existing);

    const resetEntry = markManualRetry(existing, this.nowMs());
    this.clearEntryTimer(clientMessageId);
    this.entries.set(clientMessageId, resetEntry);
    await this.persist();
    this.emit();

    if (!this.online) {
      const queuedOffline: OutboxRecord = {
        ...cloneOutboxRecord(resetEntry),
        failureReason: "retryable_network",
        errorCode: "NETWORK_ERROR",
        updatedAtMs: this.nowMs(),
      };
      this.entries.set(clientMessageId, queuedOffline);
      await this.persist();
      this.emit();
      return cloneOutboxRecord(queuedOffline);
    }

    return this.dispatchSend(clientMessageId, { countTowardAutoCap: true });
  }

  async discard(clientMessageId: string): Promise<void> {
    this.clearEntryTimer(clientMessageId);
    this.canceledIds.add(clientMessageId);
    this.entries.delete(clientMessageId);
    await this.persist();
    this.emit();
  }

  async flushDue(): Promise<void> {
    if (!this.online) return;
    const now = this.nowMs();
    const dueIds = Array.from(this.entries.values())
      .filter(
        (entry) =>
          (entry.status === "queued" || entry.status === "unknown") &&
          (entry.nextAttemptAtMs === null || entry.nextAttemptAtMs <= now),
      )
      .map((entry) => entry.clientMessageId);

    for (const id of dueIds) {
      await this.dispatchSend(id, { countTowardAutoCap: true });
    }
  }

  private scheduleRetryIfNeeded(
    entry: OutboxRecord,
    capturedEpoch: number,
    capturedAccount: string,
  ): void {
    this.clearEntryTimer(entry.clientMessageId);
    if (
      (entry.status !== "queued" && entry.status !== "unknown") ||
      entry.nextAttemptAtMs === null ||
      !this.online
    ) {
      return;
    }
    const delayMs = Math.max(0, entry.nextAttemptAtMs - this.nowMs());
    const timerHandle = this.scheduleTimerFn(() => {
      if (capturedEpoch !== this.epoch || capturedAccount !== this.accountId) return;
      if (this.canceledIds.has(entry.clientMessageId)) return;
      void this.dispatchSend(entry.clientMessageId, { countTowardAutoCap: true });
    }, delayMs);
    this.retryTimers.set(entry.clientMessageId, timerHandle);
  }

  private async dispatchSend(
    clientMessageId: string,
    opts: { countTowardAutoCap: boolean },
  ): Promise<OutboxRecord> {
    const inFlight = this.inFlightPromises.get(clientMessageId);
    if (inFlight) return inFlight;

    const current = this.entries.get(clientMessageId);
    if (!current) {
      throw new Error(`Unknown outbox clientMessageId: ${clientMessageId}`);
    }
    if (current.status === "sent" || current.status === "failed") {
      return cloneOutboxRecord(current);
    }

    const capturedEpoch = this.epoch;
    const capturedAccount = this.accountId;

    const runAttempt = async (): Promise<OutboxRecord> => {
      if (
        capturedEpoch !== this.epoch ||
        capturedAccount !== this.accountId ||
        this.canceledIds.has(clientMessageId) ||
        !this.entries.has(clientMessageId)
      ) {
        return cloneOutboxRecord(current);
      }

      let activeRecord = this.entries.get(clientMessageId)!;

      // Cross-tab Web Locks coordination (DEC-021 §6.1): avoid duplicating an
      // HTTP send that a sibling tab completed or updated while we waited for the lock.
      if (this.storage.persistent) {
        try {
          const accepted = await this.storage.getAcceptedReceipt?.(
            capturedAccount,
            clientMessageId,
          );
          if (
            capturedEpoch !== this.epoch ||
            capturedAccount !== this.accountId ||
            this.canceledIds.has(clientMessageId) ||
            !this.entries.has(clientMessageId)
          ) {
            return cloneOutboxRecord(activeRecord);
          }
          if (accepted) {
            const syntheticResponse: MessageSendResponse = {
              idempotent: true,
              message: {
                messageId: accepted.messageId,
                conversationId: activeRecord.conversationId,
                seq: accepted.seq,
                senderUserId: capturedAccount,
                senderDeviceId: activeRecord.senderDeviceId,
                clientMessageId: activeRecord.clientMessageId,
                protocolVersion: activeRecord.payload.protocolVersion,
                committedAt: accepted.committedAt,
                schemaVersion: 1,
              },
            };
            const syncedSent = markAttemptSucceeded(activeRecord, syntheticResponse, this.nowMs());
            this.entries.set(clientMessageId, syncedSent);
            await this.persist();
            this.emit();
            return cloneOutboxRecord(syncedSent);
          }

          const persisted = await this.storage.loadAll(capturedAccount);
          if (
            capturedEpoch !== this.epoch ||
            capturedAccount !== this.accountId ||
            this.canceledIds.has(clientMessageId) ||
            !this.entries.has(clientMessageId)
          ) {
            return cloneOutboxRecord(activeRecord);
          }
          const fresher = persisted.find((item) => item.clientMessageId === clientMessageId);
          if (fresher) {
            activeRecord = fresher;
            this.entries.set(clientMessageId, fresher);
            if (fresher.status === "sent" || fresher.status === "failed") {
              this.emit();
              return cloneOutboxRecord(fresher);
            }
            if (fresher.nextAttemptAtMs !== null && fresher.nextAttemptAtMs > this.nowMs()) {
              this.emit();
              this.scheduleRetryIfNeeded(fresher, capturedEpoch, capturedAccount);
              return cloneOutboxRecord(fresher);
            }
          }
        } catch (storageErr) {
          if (storageErr instanceof OutboxStorageError) {
            this.storageAvailable = storageErr.code === "STORAGE_CLEARED";
            this.storageNoticeCode = storageErr.code;
          }
        }
      }

      const sendingRecord = markAttemptStarted(activeRecord, this.nowMs(), opts.countTowardAutoCap);
      this.clearEntryTimer(clientMessageId);
      this.entries.set(clientMessageId, sendingRecord);
      await this.persist();
      this.emit();

      try {
        const prepared: PreparedEncryptedSend = {
          conversationId: sendingRecord.conversationId,
          payload: sendingRecord.payload,
        };
        const response = await this.sender.sendPrepared(prepared);

        if (
          capturedEpoch !== this.epoch ||
          capturedAccount !== this.accountId ||
          this.canceledIds.has(clientMessageId) ||
          !this.entries.has(clientMessageId)
        ) {
          // ERR-003: Ignore late completion if context switched/canceled/logged out.
          return cloneOutboxRecord(sendingRecord);
        }

        const latest = this.entries.get(clientMessageId)!;
        const sentRecord = markAttemptSucceeded(latest, response, this.nowMs());
        this.entries.set(clientMessageId, sentRecord);
        await this.persist();
        this.emit();
        return cloneOutboxRecord(sentRecord);
      } catch (error) {
        if (
          capturedEpoch !== this.epoch ||
          capturedAccount !== this.accountId ||
          this.canceledIds.has(clientMessageId) ||
          !this.entries.has(clientMessageId)
        ) {
          // ERR-003: Stale async failure never mutates new active UI context.
          return cloneOutboxRecord(sendingRecord);
        }

        const effectiveError =
          !this.online && !(error instanceof MessageSendApiError)
            ? new MessageSendApiError(0, "NETWORK_ERROR", true, "unknown")
            : error;

        const latest = this.entries.get(clientMessageId)!;
        const nextRecord = markAttemptOutcomeFailure(latest, effectiveError, {
          nowMs: this.nowMs(),
          online: this.online,
          randomValue: this.random(),
        });
        this.entries.set(clientMessageId, nextRecord);
        await this.persist();
        this.emit();
        this.scheduleRetryIfNeeded(nextRecord, capturedEpoch, capturedAccount);
        return cloneOutboxRecord(nextRecord);
      }
    };

    const executeAttempt = this.storage.withSendLock
      ? () => this.storage.withSendLock!(capturedAccount, clientMessageId, runAttempt)
      : runAttempt;

    const promise = executeAttempt().finally(() => {
      this.inFlightPromises.delete(clientMessageId);
    });

    this.inFlightPromises.set(clientMessageId, promise);
    return promise;
  }

  async onDeviceRevoked(): Promise<void> {
    this.epoch += 1;
    this.clearAllTimers();
    this.inFlightPromises.clear();
    this.logoutWarningPendingCount = null;
    const now = this.nowMs();
    for (const [id, entry] of this.entries.entries()) {
      if (entry.status !== "sent") {
        this.entries.set(id, markDeviceRevokedFailure(entry, now));
      }
    }
    await this.persist();
    this.emit();
  }

  hasPendingEntries(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.status === "queued" || entry.status === "sending" || entry.status === "unknown") {
        return true;
      }
    }
    return false;
  }

  /**
   * DEC-021 §6.1: Warn before sign-out if pending outbox entries exist; once
   * confirmed (or when none are pending), delete outbox entries and local key.
   */
  async requestLogout(options?: {
    confirmDiscardPending?: boolean;
  }): Promise<{ completed: boolean; requiresConfirmation: boolean; pendingCount: number }> {
    const pendingCount = Array.from(this.entries.values()).filter(
      (entry) =>
        entry.status === "queued" || entry.status === "sending" || entry.status === "unknown",
    ).length;

    if (pendingCount > 0 && !options?.confirmDiscardPending) {
      this.logoutWarningPendingCount = pendingCount;
      this.emit();
      return {
        completed: false,
        requiresConfirmation: true,
        pendingCount,
      };
    }

    this.logoutWarningPendingCount = null;
    await this.logoutAndClear();
    return {
      completed: true,
      requiresConfirmation: false,
      pendingCount,
    };
  }

  cancelLogoutRequest(): void {
    if (this.logoutWarningPendingCount !== null) {
      this.logoutWarningPendingCount = null;
      this.emit();
    }
  }

  async switchAccount(
    nextAccountId: string,
    nextConversationId: string | null = null,
  ): Promise<void> {
    this.epoch += 1;
    this.clearAllTimers();
    this.inFlightPromises.clear();
    this.canceledIds.clear();
    this.entries.clear();
    this.accountId = nextAccountId;
    this.activeConversationId = nextConversationId;
    this.storageNoticeCode = null;
    this.logoutWarningPendingCount = null;
    await this.hydrate();
  }

  async logoutAndClear(): Promise<void> {
    const prevAccount = this.accountId;
    this.epoch += 1;
    this.clearAllTimers();
    this.inFlightPromises.clear();
    this.canceledIds.clear();
    this.entries.clear();
    this.storageNoticeCode = null;
    this.logoutWarningPendingCount = null;
    await this.storage.clear(prevAccount);
    this.emit();
  }
}
