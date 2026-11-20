import {
  DEFAULT_READ_RECEIPTS_ENABLED,
  READ_RECEIPT_FOCUS_DEBOUNCE_MS,
  RECEIPT_SCHEMA_VERSION,
  computeUnreadCount,
  isErrorCode,
  isOpaqueId,
  mergeMonotonicReadThroughSeq,
  mergeMonotonicReceiptStage,
  mergeMonotonicTimestamp,
  validateConversationReceiptListResponse,
  validateMessageReceiptDetailResponse,
  validateMessageReceiptEvent,
  validateReadProgressResponse,
  validateReceiptPreferencesView,
  validateSubmitMessageReceiptResponse,
  type ConversationReceiptListResponse,
  type Envelope,
  type ErrorCode,
  type MessageReceiptDetailResponse,
  type MessageReceiptEvent,
  type MessageReceiptView,
  type ReadProgressResponse,
  type ReadProgressView,
  type ReceiptPreferencesView,
  type ReceiptStage,
  type ReceiptSubmitType,
  type SubmitMessageReceiptRequest,
  type SubmitMessageReceiptResponse,
  type UpdateReadProgressRequest,
  type UpdateReceiptPreferencesRequest,
} from "@chat/contracts";

import type { ReceivedTimelineMessage } from "./receive";

/**
 * Receipts, privacy preferences, and private unread controller v0 (`P2-11`,
 * `FR-CHAT-009..011`, `FR-HIST-004`, `FR-PRIV-003`, `ERR-003`, `DEC-020`).
 */

export class ReceiptsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode | "INVALID_RESPONSE",
    public readonly retryable: boolean,
    public readonly requestId: string | null = null,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Receipts API request failed with ${code} (${status})`);
    this.name = "ReceiptsApiError";
  }
}

export interface ReceiptsClientOptions {
  apiOrigin?: string;
  origin?: string;
  expectedUserId: string;
  getToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export type ParsedMessageReceiptEvent =
  | { ok: true; event: MessageReceiptEvent }
  | { ok: false; reason: "invalid_envelope" | "invalid_event" };

/** Parses and strictly validates a server `"message:receipt"` Socket.IO payload. */
export function parseMessageReceiptEventEnvelope(rawPayload: unknown): ParsedMessageReceiptEvent {
  if (!isPlainRecord(rawPayload) || rawPayload.ok !== true || !("data" in rawPayload)) {
    return { ok: false, reason: "invalid_envelope" };
  }
  const checked = validateMessageReceiptEvent(rawPayload.data);
  if (!checked.ok) {
    return { ok: false, reason: "invalid_event" };
  }
  return { ok: true, event: checked.value };
}

export class ReceiptsClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ReceiptsClientOptions) {
    const rawOrigin = options.apiOrigin ?? options.origin ?? "";
    this.origin = rawOrigin.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getPreferences(): Promise<ReceiptPreferencesView> {
    const raw = await this.request("/api/v1/me/receipt-preferences", { method: "GET" });
    const checked = validateReceiptPreferencesView(raw);
    if (!checked.ok || checked.value.userId !== this.options.expectedUserId) {
      throw new ReceiptsApiError(502, "INVALID_RESPONSE", false);
    }
    return checked.value;
  }

  async setPreferences(readReceiptsEnabled: boolean): Promise<ReceiptPreferencesView> {
    const payload: UpdateReceiptPreferencesRequest = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      readReceiptsEnabled,
    };
    const raw = await this.request("/api/v1/me/receipt-preferences", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    const checked = validateReceiptPreferencesView(raw);
    if (!checked.ok || checked.value.userId !== this.options.expectedUserId) {
      throw new ReceiptsApiError(502, "INVALID_RESPONSE", false);
    }
    return checked.value;
  }

  async listConversationReceipts(conversationId: string): Promise<ConversationReceiptListResponse> {
    if (!isOpaqueId(conversationId)) {
      throw new ReceiptsApiError(400, "INVALID_REQUEST", false);
    }
    const raw = await this.request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/receipts`,
      { method: "GET" },
    );
    const checked = validateConversationReceiptListResponse(raw);
    if (!checked.ok) {
      throw new ReceiptsApiError(502, "INVALID_RESPONSE", false);
    }
    return checked.value;
  }

  async getMessageReceipt(
    conversationId: string,
    messageId: string,
  ): Promise<MessageReceiptDetailResponse> {
    if (!isOpaqueId(conversationId) || !isOpaqueId(messageId)) {
      throw new ReceiptsApiError(400, "INVALID_REQUEST", false);
    }
    const raw = await this.request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/receipt`,
      { method: "GET" },
    );
    const checked = validateMessageReceiptDetailResponse(raw);
    if (!checked.ok) {
      throw new ReceiptsApiError(502, "INVALID_RESPONSE", false);
    }
    return checked.value;
  }

  async submitReceipt(input: {
    conversationId: string;
    messageId: string;
    type: ReceiptSubmitType;
    deviceId: string;
  }): Promise<SubmitMessageReceiptResponse> {
    if (!isOpaqueId(input.conversationId) || !isOpaqueId(input.messageId)) {
      throw new ReceiptsApiError(400, "INVALID_REQUEST", false);
    }
    const payload: SubmitMessageReceiptRequest = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      type: input.type,
      deviceId: input.deviceId,
    };
    const raw = await this.request(
      `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/messages/${encodeURIComponent(input.messageId)}/receipt`,
      { method: "POST", body: JSON.stringify(payload) },
    );
    const checked = validateSubmitMessageReceiptResponse(raw);
    if (!checked.ok) {
      throw new ReceiptsApiError(502, "INVALID_RESPONSE", false);
    }
    return checked.value;
  }

  async getReadProgress(conversationId: string): Promise<ReadProgressResponse> {
    if (!isOpaqueId(conversationId)) {
      throw new ReceiptsApiError(400, "INVALID_REQUEST", false);
    }
    const raw = await this.request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/read-progress`,
      { method: "GET" },
    );
    const checked = validateReadProgressResponse(raw);
    if (!checked.ok || checked.value.progress.userId !== this.options.expectedUserId) {
      throw new ReceiptsApiError(502, "INVALID_RESPONSE", false);
    }
    return checked.value;
  }

  async updateReadProgress(
    conversationId: string,
    readThroughSeq: number,
  ): Promise<ReadProgressResponse> {
    if (
      !isOpaqueId(conversationId) ||
      !Number.isSafeInteger(readThroughSeq) ||
      readThroughSeq < 0
    ) {
      throw new ReceiptsApiError(400, "INVALID_REQUEST", false);
    }
    const payload: UpdateReadProgressRequest = {
      schemaVersion: RECEIPT_SCHEMA_VERSION,
      readThroughSeq,
    };
    const raw = await this.request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/read-progress`,
      { method: "POST", body: JSON.stringify(payload) },
    );
    const checked = validateReadProgressResponse(raw);
    if (!checked.ok || checked.value.progress.userId !== this.options.expectedUserId) {
      throw new ReceiptsApiError(502, "INVALID_RESPONSE", false);
    }
    return checked.value;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const token = await this.options.getToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
    };
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const response = await this.fetchImpl(`${this.origin}${path}`, {
      ...init,
      headers,
      credentials: "omit",
    });

    const retryHeader = response.headers.get("retry-after");
    const retryAfterSeconds =
      retryHeader && /^\d+$/.test(retryHeader.trim()) ? Number(retryHeader.trim()) : null;

    let body: Envelope<unknown> | null = null;
    try {
      body = (await response.json()) as Envelope<unknown>;
    } catch {
      throw new ReceiptsApiError(
        response.status,
        "INVALID_RESPONSE",
        response.status >= 500,
        null,
        retryAfterSeconds,
      );
    }

    if (!body || typeof body !== "object") {
      throw new ReceiptsApiError(
        response.status,
        "INVALID_RESPONSE",
        false,
        null,
        retryAfterSeconds,
      );
    }

    const requestId = typeof body.requestId === "string" ? body.requestId : null;
    if (!response.ok || !body.ok) {
      const code =
        !body.ok && body.error && isErrorCode(body.error.code)
          ? body.error.code
          : response.status === 401
            ? "UNAUTHENTICATED"
            : "INTERNAL_ERROR";
      const retryable =
        !body.ok && body.error && typeof body.error.retryable === "boolean"
          ? body.error.retryable
          : response.status === 429 || response.status >= 500;
      throw new ReceiptsApiError(response.status, code, retryable, requestId, retryAfterSeconds);
    }

    return body.data;
  }
}

export interface ReceiptsControllerSnapshot {
  accountId: string;
  conversationId: string;
  focused: boolean;
  readReceiptsEnabled: boolean;
  blocked: boolean;
  latestSeq: number;
  readThroughSeq: number;
  unreadCount: number;
  pendingReadTimerActive: boolean;
  senderReceipts: ReadonlyMap<string, MessageReceiptView>;
  emittedDeliveredIds: ReadonlySet<string>;
  emittedReadIds: ReadonlySet<string>;
}

export type ReceiptsSnapshotListener = (snapshot: ReceiptsControllerSnapshot) => void;

export interface ReceiptsAndUnreadControllerOptions {
  accountId: string;
  conversationId: string;
  focused?: boolean;
  readReceiptsEnabled?: boolean;
  blocked?: boolean;
  focusDebounceMs?: number;
  initialReadThroughSeq?: number;
  initialLatestSeq?: number;
  onEmitReceipt?: (type: ReceiptSubmitType, item: ReceivedTimelineMessage) => Promise<void> | void;
  onCommitReadProgress?: (readThroughSeq: number) => Promise<void> | void;
}

/**
 * Stateful browser controller coordinating:
 * - Decrypted-only delivery evidence (`FR-CHAT-009`)
 * - 500 ms focused-conversation debounce + opt-in/reciprocal read receipts (`FR-CHAT-010`)
 * - Monotonic sender receipt merges & private `readThroughSeq` unread calculation (`FR-CHAT-011`, `FR-HIST-004`)
 * - Clean epoch/timer invalidation across conversation/account switches (`ERR-003`)
 */
export class ReceiptsAndUnreadController {
  private accountId: string;
  private conversationId: string;
  private focused: boolean;
  private readReceiptsEnabled: boolean;
  private blocked: boolean;
  private readonly focusDebounceMs: number;
  private latestSeq: number;
  private readThroughSeq: number;
  private epoch = 0;
  private disposed = false;
  private focusTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly itemsById = new Map<string, ReceivedTimelineMessage>();
  private readonly senderReceipts = new Map<string, MessageReceiptView>();
  private readonly emittedDeliveredIds = new Set<string>();
  private readonly emittedReadIds = new Set<string>();
  private readonly listeners = new Set<ReceiptsSnapshotListener>();
  private readonly onEmitReceipt?: ReceiptsAndUnreadControllerOptions["onEmitReceipt"];
  private readonly onCommitReadProgress?: ReceiptsAndUnreadControllerOptions["onCommitReadProgress"];

  constructor(options: ReceiptsAndUnreadControllerOptions) {
    this.accountId = options.accountId;
    this.conversationId = options.conversationId;
    this.focused = options.focused ?? false;
    this.readReceiptsEnabled = options.readReceiptsEnabled ?? DEFAULT_READ_RECEIPTS_ENABLED;
    this.blocked = options.blocked ?? false;
    this.focusDebounceMs = Math.max(0, options.focusDebounceMs ?? READ_RECEIPT_FOCUS_DEBOUNCE_MS);
    this.readThroughSeq = Math.max(0, options.initialReadThroughSeq ?? 0);
    this.latestSeq = Math.max(this.readThroughSeq, options.initialLatestSeq ?? 0);
    this.onEmitReceipt = options.onEmitReceipt;
    this.onCommitReadProgress = options.onCommitReadProgress;
  }

  subscribe(listener: ReceiptsSnapshotListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): ReceiptsControllerSnapshot {
    return {
      accountId: this.accountId,
      conversationId: this.conversationId,
      focused: this.focused,
      readReceiptsEnabled: this.readReceiptsEnabled,
      blocked: this.blocked,
      latestSeq: this.latestSeq,
      readThroughSeq: this.readThroughSeq,
      unreadCount: this.computeLocalUnreadCount(),
      pendingReadTimerActive: this.focusTimer !== null,
      senderReceipts: new Map(this.senderReceipts),
      emittedDeliveredIds: new Set(this.emittedDeliveredIds),
      emittedReadIds: new Set(this.emittedReadIds),
    };
  }

  private emit(): void {
    const snap = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }

  private clearFocusTimer(): void {
    if (this.focusTimer !== null) {
      clearTimeout(this.focusTimer);
      this.focusTimer = null;
    }
  }

  private computeLocalUnreadCount(): number {
    if (this.itemsById.size > 0) {
      let unread = 0;
      for (const item of this.itemsById.values()) {
        if (item.seq > this.readThroughSeq && item.senderUserId !== this.accountId) {
          unread += 1;
        }
      }
      // Account for unseen tail seqs above highest synced local item when offline/unfetched.
      let maxKnownItemSeq = 0;
      for (const item of this.itemsById.values()) {
        if (item.seq > maxKnownItemSeq) maxKnownItemSeq = item.seq;
      }
      if (this.latestSeq > maxKnownItemSeq) {
        const baselineSeq = Math.max(this.readThroughSeq, maxKnownItemSeq);
        unread += Math.max(0, this.latestSeq - baselineSeq);
      }
      return unread;
    }
    return computeUnreadCount(this.latestSeq, this.readThroughSeq);
  }

  private getPendingPeerReadItems(): ReceivedTimelineMessage[] {
    const pending: ReceivedTimelineMessage[] = [];
    for (const item of this.itemsById.values()) {
      if (
        item.kind === "decrypted" &&
        item.canEmitReadReceipt &&
        item.senderUserId !== this.accountId &&
        !this.emittedReadIds.has(item.messageId)
      ) {
        pending.push(item);
      }
    }
    pending.sort((a, b) => a.seq - b.seq);
    return pending;
  }

  private getHighestDisplayedPeerSeq(): number {
    let maxSeq = this.readThroughSeq;
    for (const item of this.itemsById.values()) {
      if (item.senderUserId !== this.accountId && item.seq > maxSeq) {
        maxSeq = item.seq;
      }
    }
    return Math.min(maxSeq, Math.max(this.latestSeq, maxSeq));
  }

  private scheduleFocusReadIfNeeded(): void {
    if (this.disposed || !this.focused) {
      this.clearFocusTimer();
      return;
    }
    const hasUnreadOrPending =
      this.computeLocalUnreadCount() > 0 ||
      (this.readReceiptsEnabled && !this.blocked && this.getPendingPeerReadItems().length > 0);
    if (!hasUnreadOrPending) {
      this.clearFocusTimer();
      return;
    }
    if (this.focusTimer !== null) {
      return;
    }
    const capturedEpoch = this.epoch;
    const capturedAccount = this.accountId;
    const capturedConversation = this.conversationId;
    this.focusTimer = setTimeout(() => {
      this.focusTimer = null;
      if (
        this.disposed ||
        this.epoch !== capturedEpoch ||
        this.accountId !== capturedAccount ||
        this.conversationId !== capturedConversation ||
        !this.focused
      ) {
        return;
      }
      void this.flushFocusedRead();
    }, this.focusDebounceMs);
  }

  async flushFocusedRead(): Promise<void> {
    if (this.disposed || !this.focused) return;
    const capturedEpoch = this.epoch;
    const targetSeq = Math.min(this.getHighestDisplayedPeerSeq(), this.latestSeq);
    if (targetSeq > this.readThroughSeq) {
      this.readThroughSeq = mergeMonotonicReadThroughSeq(
        this.readThroughSeq,
        targetSeq,
        this.latestSeq,
      );
      if (this.onCommitReadProgress) {
        try {
          await this.onCommitReadProgress(this.readThroughSeq);
        } catch {
          // Keep optimistic monotonic state locally if network commit retries later.
        }
      }
    }

    if (this.disposed || this.epoch !== capturedEpoch || !this.focused) {
      return;
    }

    if (this.readReceiptsEnabled && !this.blocked) {
      const toEmit = this.getPendingPeerReadItems();
      for (const item of toEmit) {
        if (this.disposed || this.epoch !== capturedEpoch || !this.focused) break;
        this.emittedReadIds.add(item.messageId);
        if (this.onEmitReceipt) {
          try {
            await this.onEmitReceipt("read", item);
          } catch {
            this.emittedReadIds.delete(item.messageId);
          }
        }
      }
    }

    this.emit();
  }

  setFocused(focused: boolean): void {
    if (this.disposed || this.focused === focused) return;
    this.focused = focused;
    if (!focused) {
      this.clearFocusTimer();
    } else {
      this.scheduleFocusReadIfNeeded();
    }
    this.emit();
  }

  setReadReceiptsEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.readReceiptsEnabled = enabled;
    if (this.focused && enabled) {
      this.scheduleFocusReadIfNeeded();
    }
    this.emit();
  }

  setBlocked(blocked: boolean): void {
    if (this.disposed) return;
    this.blocked = blocked;
    if (blocked) {
      this.clearFocusTimer();
    }
    this.emit();
  }

  async syncTimeline(
    items: readonly ReceivedTimelineMessage[],
    options: { latestSeq?: number } = {},
  ): Promise<void> {
    if (this.disposed) return;
    const capturedEpoch = this.epoch;

    for (const item of items) {
      if (item.conversationId !== this.conversationId) continue;
      if (item.seq > this.latestSeq) {
        this.latestSeq = item.seq;
      }
      const prev = this.itemsById.get(item.messageId);
      // Never overwrite a valid decrypted record with a transient error state.
      if (!prev || prev.kind !== "decrypted" || item.kind === "decrypted") {
        this.itemsById.set(item.messageId, item);
      }

      if (
        !this.blocked &&
        item.kind === "decrypted" &&
        item.canEmitDeliveryReceipt &&
        item.senderUserId !== this.accountId &&
        !this.emittedDeliveredIds.has(item.messageId)
      ) {
        this.emittedDeliveredIds.add(item.messageId);
        if (this.onEmitReceipt) {
          try {
            await this.onEmitReceipt("delivered", item);
          } catch {
            this.emittedDeliveredIds.delete(item.messageId);
          }
        }
        if (this.disposed || this.epoch !== capturedEpoch) return;
      }
    }

    if (options.latestSeq !== undefined && options.latestSeq > this.latestSeq) {
      this.latestSeq = options.latestSeq;
    }

    if (this.focused) {
      this.scheduleFocusReadIfNeeded();
    }
    this.emit();
  }

  /** Marks private `readThroughSeq` explicitly (works even when read receipts are off). */
  async markReadThrough(seq: number): Promise<void> {
    if (this.disposed) return;
    const next = mergeMonotonicReadThroughSeq(this.readThroughSeq, seq, this.latestSeq);
    if (next <= this.readThroughSeq) return;
    this.readThroughSeq = next;
    if (this.onCommitReadProgress) {
      try {
        await this.onCommitReadProgress(this.readThroughSeq);
      } catch {
        // Ignore transient failure cleanly; high-water remains valid for retry.
      }
    }
    this.emit();
  }

  applyReceiptView(view: MessageReceiptView): ReceiptStage | null {
    if (this.disposed || view.conversationId !== this.conversationId) {
      return null;
    }
    const existing = this.senderReceipts.get(view.messageId);
    if (!existing) {
      this.senderReceipts.set(view.messageId, { ...view });
      this.emit();
      return view.stage;
    }
    const mergedStage = mergeMonotonicReceiptStage(existing.stage, view.stage);
    const merged: MessageReceiptView = {
      ...existing,
      stage: mergedStage,
      deliveredAt: mergeMonotonicTimestamp(existing.deliveredAt, view.deliveredAt),
      readAt: mergeMonotonicTimestamp(existing.readAt, view.readAt),
      updatedAt: mergedStage !== existing.stage ? view.updatedAt : existing.updatedAt,
    };
    this.senderReceipts.set(view.messageId, merged);
    this.emit();
    return mergedStage;
  }

  applySocketReceiptEvent(rawPayload: unknown): boolean {
    if (this.disposed) return false;
    const parsed = parseMessageReceiptEventEnvelope(rawPayload);
    if (!parsed.ok) return false;
    if (
      parsed.event.conversationId !== this.conversationId ||
      parsed.event.senderUserId !== this.accountId
    ) {
      return false;
    }
    this.applyReceiptView({
      schemaVersion: parsed.event.schemaVersion,
      messageId: parsed.event.messageId,
      conversationId: parsed.event.conversationId,
      seq: parsed.event.seq,
      recipientUserId: parsed.event.recipientUserId,
      recipientDeviceId: parsed.event.recipientDeviceId,
      stage: parsed.event.stage,
      deliveredAt: parsed.event.deliveredAt,
      readAt: parsed.event.readAt,
      updatedAt: parsed.event.updatedAt,
    });
    return true;
  }

  applyServerReadProgress(progress: ReadProgressView): boolean {
    if (
      this.disposed ||
      progress.conversationId !== this.conversationId ||
      progress.userId !== this.accountId
    ) {
      return false;
    }
    if (progress.latestSeq > this.latestSeq) {
      this.latestSeq = progress.latestSeq;
    }
    this.readThroughSeq = mergeMonotonicReadThroughSeq(
      this.readThroughSeq,
      progress.readThroughSeq,
      this.latestSeq,
    );
    this.emit();
    return true;
  }

  switchContext(next: {
    accountId: string;
    conversationId: string;
    focused?: boolean;
    readReceiptsEnabled?: boolean;
    blocked?: boolean;
    initialReadThroughSeq?: number;
    initialLatestSeq?: number;
  }): void {
    this.clearFocusTimer();
    this.epoch += 1;
    this.accountId = next.accountId;
    this.conversationId = next.conversationId;
    this.focused = next.focused ?? false;
    this.readReceiptsEnabled = next.readReceiptsEnabled ?? DEFAULT_READ_RECEIPTS_ENABLED;
    this.blocked = next.blocked ?? false;
    this.readThroughSeq = Math.max(0, next.initialReadThroughSeq ?? 0);
    this.latestSeq = Math.max(this.readThroughSeq, next.initialLatestSeq ?? 0);
    this.itemsById.clear();
    this.senderReceipts.clear();
    this.emittedDeliveredIds.clear();
    this.emittedReadIds.clear();
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.clearFocusTimer();
    this.epoch += 1;
    this.itemsById.clear();
    this.senderReceipts.clear();
    this.emittedDeliveredIds.clear();
    this.emittedReadIds.clear();
    this.listeners.clear();
  }
}
