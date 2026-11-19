import {
  HISTORY_PAGE_DEFAULT,
  isErrorCode,
  isOpaqueId,
  isRequestId,
  validateHistoryPageResponse,
  validatePageLimit,
  type Envelope,
  type ErrorCode,
  type HistoryMessageItem,
  type HistoryPageResponse,
  type MessageNewEvent,
} from "@chat/contracts";
import { decryptReceivedEnvelope, type DecryptCapableDevice } from "@chat/crypto";

import { errorCopyFor, type ErrorCopy } from "../../i18n/errors";
import type { ReceivedTimelineMessage } from "./receive";

/**
 * Web encrypted history client, ascending-`seq` deduplicating state machine,
 * and `ERR-003` stale-context guard (`P2-07`, `FR-CHAT-012`, `FR-HIST-002`,
 * `FR-HIST-005`, `INT-006`, `DATA-013`, `ERR-001`–`ERR-003`).
 *
 * Provisional under Release-gated DEC-023:
 * - Fetches ciphertext-only pages via `GET /api/v1/conversations/:id/messages`
 *   using Bearer auth (`credentials: "omit"`), never persisting plaintext in
 *   `localStorage` or `sessionStorage`.
 * - Rejects malformed, unsorted, or foreign-conversation responses fail-closed.
 * - Preserves already-loaded decrypted messages when a subsequent older-page
 *   fetch fails (`TC-HIST-004`), while clearing protected items immediately on
 *   session/permission revocation (`401`/`403`/`404`).
 */
export type HistoryClientErrorCode = ErrorCode | "INVALID_RESPONSE" | "OFFLINE";

export class HistoryApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: HistoryClientErrorCode,
    public readonly retryable: boolean,
    public readonly requestId: string | null = null,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(`History API error (${code})`);
    this.name = "HistoryApiError";
  }
}

export interface HistoryFetchPageInput {
  conversationId: string;
  before?: string;
  after?: string;
  limit?: number;
}

export interface HistoryPageFetcher {
  fetchPage(input: HistoryFetchPageInput): Promise<HistoryPageResponse>;
}

export interface HistoryClientOptions {
  apiOrigin: string;
  getToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
  isOnline?: () => boolean;
}

function assertExactOrigin(apiOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(apiOrigin);
  } catch {
    throw new HistoryApiError(0, "INVALID_REQUEST", false);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new HistoryApiError(0, "INVALID_REQUEST", false);
  }
  return parsed.origin;
}

export class HistoryClient implements HistoryPageFetcher {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onlineCheck: () => boolean;

  constructor(private readonly options: HistoryClientOptions) {
    this.origin = assertExactOrigin(options.apiOrigin);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.onlineCheck =
      options.isOnline ??
      (() => {
        if (typeof globalThis.navigator !== "undefined" && "onLine" in globalThis.navigator) {
          return globalThis.navigator.onLine !== false;
        }
        return true;
      });
  }

  async fetchPage(input: HistoryFetchPageInput): Promise<HistoryPageResponse> {
    if (!this.onlineCheck()) {
      throw new HistoryApiError(0, "OFFLINE", true);
    }
    if (!isOpaqueId(input.conversationId)) {
      throw new HistoryApiError(400, "INVALID_REQUEST", false);
    }
    if (input.before !== undefined && input.after !== undefined) {
      throw new HistoryApiError(400, "INVALID_REQUEST", false);
    }

    const limitCheck = validatePageLimit(input.limit);
    if (!limitCheck.ok) {
      throw new HistoryApiError(400, "INVALID_REQUEST", false);
    }

    const params = new URLSearchParams();
    if (input.limit !== undefined) {
      params.set("limit", String(limitCheck.value));
    } else if (input.before !== undefined || input.after !== undefined) {
      params.set("limit", String(HISTORY_PAGE_DEFAULT));
    }
    if (input.before !== undefined) {
      params.set("before", input.before);
    }
    if (input.after !== undefined) {
      params.set("after", input.after);
    }

    const query = params.toString();
    const path = `/api/v1/conversations/${encodeURIComponent(input.conversationId)}/messages${query ? `?${query}` : ""}`;
    const token = await this.options.getToken();

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.origin}${path}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
        },
        credentials: "omit",
      });
    } catch {
      const code = this.onlineCheck() ? "TEMPORARILY_UNAVAILABLE" : "OFFLINE";
      throw new HistoryApiError(0, code, true);
    }

    const retryHeader = response.headers.get("retry-after");
    const retryAfterSeconds =
      retryHeader && /^\d+$/.test(retryHeader.trim()) ? Number(retryHeader.trim()) : null;

    let body: Envelope<unknown> | null = null;
    try {
      body = (await response.json()) as Envelope<unknown>;
    } catch {
      throw new HistoryApiError(
        response.status,
        "INVALID_RESPONSE",
        response.status >= 500,
        null,
        retryAfterSeconds,
      );
    }

    if (!body || typeof body !== "object") {
      throw new HistoryApiError(
        response.status,
        "INVALID_RESPONSE",
        false,
        null,
        retryAfterSeconds,
      );
    }

    const rawRequestId = (body as { requestId?: unknown }).requestId;
    const requestId = isRequestId(rawRequestId)
      ? rawRequestId
      : typeof rawRequestId === "string"
        ? rawRequestId
        : null;

    if (!response.ok || !body.ok) {
      const fallbackCode: ErrorCode =
        response.status === 401
          ? "UNAUTHENTICATED"
          : response.status === 403
            ? "FORBIDDEN"
            : response.status === 404
              ? "NOT_FOUND"
              : "INTERNAL_ERROR";
      const code: HistoryClientErrorCode =
        !body.ok && body.error && isErrorCode(body.error.code) ? body.error.code : fallbackCode;
      const retryable =
        !body.ok && body.error && typeof body.error.retryable === "boolean"
          ? body.error.retryable
          : response.status === 429 || response.status >= 500;
      throw new HistoryApiError(response.status, code, retryable, requestId, retryAfterSeconds);
    }

    const validated = validateHistoryPageResponse(body.data, input.conversationId);
    if (!validated.ok) {
      throw new HistoryApiError(502, "INVALID_RESPONSE", false, requestId, retryAfterSeconds);
    }
    return validated.value;
  }
}

/**
 * Merge retained/live timeline messages in strict ascending server `seq` order
 * with `messageId` deduplication (`FR-CHAT-012`, `DEC-021` §5.1/§7.2).
 * Never lets a duplicate failed attempt overwrite already-decrypted plaintext.
 */
export function mergeHistoryMessages(
  existing: readonly ReceivedTimelineMessage[],
  incoming: readonly ReceivedTimelineMessage[],
  expectedConversationId?: string,
): ReceivedTimelineMessage[] {
  const byId = new Map<string, ReceivedTimelineMessage>();

  const accept = (item: ReceivedTimelineMessage) => {
    if (expectedConversationId && item.conversationId !== expectedConversationId) {
      return;
    }
    const prev = byId.get(item.messageId);
    if (prev && prev.kind === "decrypted" && item.kind !== "decrypted") {
      return;
    }
    byId.set(item.messageId, item);
  };

  for (const item of existing) accept(item);
  for (const item of incoming) accept(item);

  return [...byId.values()].sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    return a.messageId.localeCompare(b.messageId);
  });
}

/**
 * Identify missing positive sequence integers between loaded retained messages
 * (e.g. permanent write-abort gaps or catch-up triggers).
 */
export function findSequenceGaps(items: readonly Pick<ReceivedTimelineMessage, "seq">[]): number[] {
  const seqs = [...new Set(items.map((item) => item.seq))].sort((a, b) => a - b);
  const missing: number[] = [];
  for (let i = 1; i < seqs.length; i += 1) {
    const prev = seqs[i - 1]!;
    const curr = seqs[i]!;
    for (let s = prev + 1; s < curr; s += 1) {
      missing.push(s);
    }
  }
  return missing;
}

export interface HistoryPageFailure {
  kind: "offline" | "failed";
  code: ErrorCode | null;
  retryable: boolean;
  requestId: string | null;
  retryAfterSeconds: number | null;
  copy: ErrorCopy;
}

export type HistoryViewState =
  | {
      status: "idle";
      conversationId: string;
      items: readonly ReceivedTimelineMessage[];
    }
  | {
      status: "loading";
      conversationId: string;
      items: readonly ReceivedTimelineMessage[];
    }
  | {
      status: "empty";
      conversationId: string;
      items: readonly ReceivedTimelineMessage[];
      hasMore: false;
      nextCursor: null;
    }
  | {
      status: "ready";
      conversationId: string;
      items: readonly ReceivedTimelineMessage[];
      hasMore: boolean;
      nextCursor: string | null;
      loadingOlder: boolean;
      pageError: HistoryPageFailure | null;
      keyUnavailableBanner: boolean;
    }
  | {
      status: "offline";
      conversationId: string;
      items: readonly ReceivedTimelineMessage[];
      retryable: true;
      copy: ErrorCopy;
    }
  | {
      status: "failed";
      conversationId: string;
      items: readonly ReceivedTimelineMessage[];
      code: ErrorCode | null;
      retryable: boolean;
      requestId: string | null;
      retryAfterSeconds: number | null;
      copy: ErrorCopy;
    }
  | {
      status: "forbidden";
      conversationId: string;
      items: readonly ReceivedTimelineMessage[];
      reason: "unauthenticated" | "forbidden" | "not_found";
      code: "UNAUTHENTICATED" | "SESSION_REVOKED" | "FORBIDDEN" | "NOT_FOUND";
      copy: ErrorCopy;
    }
  | {
      status: "key-unavailable";
      conversationId: string;
      items: readonly ReceivedTimelineMessage[];
      encryptedCount: number;
      recoveryHref: "/settings/encryption";
    };

export interface HistoryControllerOptions {
  accountId: string;
  conversationId: string;
  device: DecryptCapableDevice | null;
  client: HistoryPageFetcher;
  pageLimit?: number;
  expectedPeerIdentityKey?: string;
  expectedPeerSenderKey?: string;
}

export type HistoryStateListener = (state: HistoryViewState) => void;

type MappedHistoryError =
  | { kind: "offline" }
  | {
      kind: "forbidden";
      reason: "unauthenticated" | "forbidden" | "not_found";
      code: "UNAUTHENTICATED" | "SESSION_REVOKED" | "FORBIDDEN" | "NOT_FOUND";
      copy: ErrorCopy;
    }
  | {
      kind: "failed";
      code: ErrorCode | null;
      retryable: boolean;
      requestId: string | null;
      retryAfterSeconds: number | null;
      copy: ErrorCopy;
    };

function mapHistoryFailure(error: unknown): MappedHistoryError {
  if (error instanceof HistoryApiError) {
    if (error.code === "OFFLINE") {
      return { kind: "offline" };
    }
    if (error.code === "UNAUTHENTICATED" || error.code === "SESSION_REVOKED") {
      return {
        kind: "forbidden",
        reason: "unauthenticated",
        code: error.code,
        copy: errorCopyFor(error.code),
      };
    }
    if (error.code === "FORBIDDEN" || error.code === "BLOCKED") {
      return {
        kind: "forbidden",
        reason: "forbidden",
        code: "FORBIDDEN",
        copy: errorCopyFor(error.code),
      };
    }
    if (error.code === "NOT_FOUND") {
      return {
        kind: "forbidden",
        reason: "not_found",
        code: "NOT_FOUND",
        copy: errorCopyFor("NOT_FOUND"),
      };
    }
    const stableCode = error.code === "INVALID_RESPONSE" ? null : error.code;
    return {
      kind: "failed",
      code: stableCode,
      retryable: error.retryable,
      requestId: error.requestId,
      retryAfterSeconds: error.retryAfterSeconds,
      copy: errorCopyFor(stableCode),
    };
  }
  return {
    kind: "failed",
    code: null,
    retryable: true,
    requestId: null,
    retryAfterSeconds: null,
    copy: errorCopyFor(null),
  };
}

function isKeyUnavailableFailure(item: ReceivedTimelineMessage): boolean {
  return (
    item.kind === "decryption_failed" &&
    (item.failureState === "missing-key" ||
      item.failureState === "crypto-unavailable" ||
      item.failureState === "session-rollback")
  );
}

/**
 * In-memory conversation history controller managing initial load, bounded backward
 * pagination (`before`), live `message:new` deduplication/merge, localized `FR-HIST-005`
 * / `TC-HIST-004` UI states, and `ERR-003` stale-context cancellation.
 */
export class HistoryController {
  private accountId: string;
  private conversationId: string;
  private device: DecryptCapableDevice | null;
  private readonly client: HistoryPageFetcher;
  private readonly pageLimit: number;
  private expectedPeerIdentityKey?: string;
  private expectedPeerSenderKey?: string;
  private epoch = 0;
  private disposed = false;
  private itemsById = new Map<string, ReceivedTimelineMessage>();
  private state: HistoryViewState;
  private readonly listeners = new Set<HistoryStateListener>();

  constructor(options: HistoryControllerOptions) {
    this.accountId = options.accountId;
    this.conversationId = options.conversationId;
    this.device = options.device;
    this.client = options.client;
    this.pageLimit = options.pageLimit ?? HISTORY_PAGE_DEFAULT;
    this.expectedPeerIdentityKey = options.expectedPeerIdentityKey;
    this.expectedPeerSenderKey = options.expectedPeerSenderKey;
    this.state = {
      status: "idle",
      conversationId: options.conversationId,
      items: [],
    };
  }

  getState(): HistoryViewState {
    return this.state;
  }

  getItems(): ReceivedTimelineMessage[] {
    return mergeHistoryMessages([], [...this.itemsById.values()], this.conversationId);
  }

  subscribe(listener: HistoryStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(next: HistoryViewState): HistoryViewState {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
    return next;
  }

  private isStale(
    capturedEpoch: number,
    capturedAccount: string,
    capturedConversation: string,
  ): boolean {
    return (
      this.disposed ||
      this.epoch !== capturedEpoch ||
      this.accountId !== capturedAccount ||
      this.conversationId !== capturedConversation
    );
  }

  private async decryptSingleItem(
    item: HistoryMessageItem | MessageNewEvent,
    device: DecryptCapableDevice | null,
  ): Promise<ReceivedTimelineMessage> {
    const result = await decryptReceivedEnvelope(device, item, {
      peerUserId: item.senderUserId,
      expectedPeerIdentityKey: this.expectedPeerIdentityKey,
      expectedPeerSenderKey: this.expectedPeerSenderKey,
    });
    if (result.ok) {
      return {
        kind: "decrypted",
        messageId: result.messageId,
        conversationId: result.conversationId,
        seq: result.seq,
        senderUserId: result.senderUserId,
        senderDeviceId: result.senderDeviceId,
        ...(result.clientMessageId !== undefined
          ? { clientMessageId: result.clientMessageId }
          : {}),
        committedAt: result.committedAt,
        protocolVersion: result.protocolVersion,
        plaintext: result.plaintext,
        sessionId: result.sessionId,
        messageIndex: result.messageIndex,
        canEmitDeliveryReceipt: true,
        canEmitReadReceipt: true,
      };
    }
    return {
      kind: "decryption_failed",
      messageId: result.messageId,
      conversationId: result.conversationId,
      seq: result.seq,
      senderUserId: result.senderUserId,
      senderDeviceId: result.senderDeviceId,
      ...(result.clientMessageId !== undefined ? { clientMessageId: result.clientMessageId } : {}),
      committedAt: result.committedAt,
      protocolVersion: result.protocolVersion,
      failureState: result.failureState,
      code: result.code,
      recoverable: result.recoverable,
      canEmitDeliveryReceipt: false,
      canEmitReadReceipt: false,
    };
  }

  private async decryptBatchIntoStore(
    rawItems: readonly HistoryMessageItem[],
    capturedEpoch: number,
    capturedAccount: string,
    capturedConv: string,
    device: DecryptCapableDevice | null,
  ): Promise<boolean> {
    for (const rawItem of rawItems) {
      if (this.isStale(capturedEpoch, capturedAccount, capturedConv)) {
        return false;
      }
      if (rawItem.conversationId !== capturedConv) {
        continue;
      }
      const existing = this.itemsById.get(rawItem.messageId);
      if (existing && existing.kind === "decrypted") {
        continue;
      }
      const converted = await this.decryptSingleItem(rawItem, device);
      if (this.isStale(capturedEpoch, capturedAccount, capturedConv)) {
        return false;
      }
      const postAwaitExisting = this.itemsById.get(rawItem.messageId);
      if (postAwaitExisting && postAwaitExisting.kind === "decrypted") {
        continue;
      }
      this.itemsById.set(converted.messageId, converted);
    }
    return !this.isStale(capturedEpoch, capturedAccount, capturedConv);
  }

  async loadInitial(): Promise<HistoryViewState> {
    if (this.disposed) return this.state;

    this.epoch += 1;
    const capturedEpoch = this.epoch;
    const capturedAccount = this.accountId;
    const capturedConv = this.conversationId;
    const capturedDevice = this.device;

    this.itemsById.clear();
    this.setState({
      status: "loading",
      conversationId: capturedConv,
      items: [],
    });

    try {
      const page = await this.client.fetchPage({
        conversationId: capturedConv,
        limit: this.pageLimit,
      });
      if (this.isStale(capturedEpoch, capturedAccount, capturedConv)) {
        return this.state;
      }

      if (page.items.length === 0) {
        return this.setState({
          status: "empty",
          conversationId: capturedConv,
          items: [],
          hasMore: false,
          nextCursor: null,
        });
      }

      const stillFresh = await this.decryptBatchIntoStore(
        page.items,
        capturedEpoch,
        capturedAccount,
        capturedConv,
        capturedDevice,
      );
      if (!stillFresh) {
        return this.state;
      }

      const items = this.getItems();
      const decryptedCount = items.filter((item) => item.kind === "decrypted").length;
      if (decryptedCount === 0 && items.length > 0 && items.every(isKeyUnavailableFailure)) {
        return this.setState({
          status: "key-unavailable",
          conversationId: capturedConv,
          items,
          encryptedCount: items.length,
          recoveryHref: "/settings/encryption",
        });
      }

      return this.setState({
        status: "ready",
        conversationId: capturedConv,
        items,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        loadingOlder: false,
        pageError: null,
        keyUnavailableBanner: items.some(isKeyUnavailableFailure),
      });
    } catch (error) {
      if (this.isStale(capturedEpoch, capturedAccount, capturedConv)) {
        return this.state;
      }
      const mapped = mapHistoryFailure(error);
      if (mapped.kind === "offline") {
        return this.setState({
          status: "offline",
          conversationId: capturedConv,
          items: [],
          retryable: true,
          copy: errorCopyFor("TEMPORARILY_UNAVAILABLE"),
        });
      }
      if (mapped.kind === "forbidden") {
        return this.setState({
          status: "forbidden",
          conversationId: capturedConv,
          items: [],
          reason: mapped.reason,
          code: mapped.code,
          copy: mapped.copy,
        });
      }
      return this.setState({
        status: "failed",
        conversationId: capturedConv,
        items: [],
        code: mapped.code,
        retryable: mapped.retryable,
        requestId: mapped.requestId,
        retryAfterSeconds: mapped.retryAfterSeconds,
        copy: mapped.copy,
      });
    }
  }

  async loadOlder(): Promise<HistoryViewState> {
    if (
      this.disposed ||
      this.state.status !== "ready" ||
      !this.state.hasMore ||
      !this.state.nextCursor ||
      this.state.loadingOlder
    ) {
      return this.state;
    }

    const capturedEpoch = this.epoch;
    const capturedAccount = this.accountId;
    const capturedConv = this.conversationId;
    const capturedDevice = this.device;
    const cursor = this.state.nextCursor;

    this.setState({
      ...this.state,
      loadingOlder: true,
      pageError: null,
    });

    try {
      const page = await this.client.fetchPage({
        conversationId: capturedConv,
        before: cursor,
        limit: this.pageLimit,
      });
      if (this.isStale(capturedEpoch, capturedAccount, capturedConv)) {
        return this.state;
      }

      const stillFresh = await this.decryptBatchIntoStore(
        page.items,
        capturedEpoch,
        capturedAccount,
        capturedConv,
        capturedDevice,
      );
      if (!stillFresh) {
        return this.state;
      }

      const items = this.getItems();
      return this.setState({
        status: "ready",
        conversationId: capturedConv,
        items,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
        loadingOlder: false,
        pageError: null,
        keyUnavailableBanner: items.some(isKeyUnavailableFailure),
      });
    } catch (error) {
      if (this.isStale(capturedEpoch, capturedAccount, capturedConv)) {
        return this.state;
      }
      const mapped = mapHistoryFailure(error);
      if (mapped.kind === "forbidden") {
        // Session or permission revocation must immediately clear protected history.
        this.itemsById.clear();
        return this.setState({
          status: "forbidden",
          conversationId: capturedConv,
          items: [],
          reason: mapped.reason,
          code: mapped.code,
          copy: mapped.copy,
        });
      }

      const currentItems = this.getItems();
      if (this.state.status === "ready") {
        const pageError: HistoryPageFailure =
          mapped.kind === "offline"
            ? {
                kind: "offline",
                code: null,
                retryable: true,
                requestId: null,
                retryAfterSeconds: null,
                copy: errorCopyFor("TEMPORARILY_UNAVAILABLE"),
              }
            : {
                kind: "failed",
                code: mapped.code,
                retryable: mapped.retryable,
                requestId: mapped.requestId,
                retryAfterSeconds: mapped.retryAfterSeconds,
                copy: mapped.copy,
              };
        return this.setState({
          ...this.state,
          items: currentItems,
          loadingOlder: false,
          pageError,
        });
      }
      return this.state;
    }
  }

  async retry(): Promise<HistoryViewState> {
    if (this.state.status === "ready" && this.state.pageError !== null) {
      return this.loadOlder();
    }
    return this.loadInitial();
  }

  async ingestLiveMessage(event: MessageNewEvent): Promise<boolean> {
    if (this.disposed || event.conversationId !== this.conversationId) {
      return false;
    }
    const existing = this.itemsById.get(event.messageId);
    if (existing && existing.kind === "decrypted") {
      return false;
    }

    const capturedEpoch = this.epoch;
    const capturedAccount = this.accountId;
    const capturedConv = this.conversationId;
    const converted = await this.decryptSingleItem(event, this.device);

    if (this.isStale(capturedEpoch, capturedAccount, capturedConv)) {
      return false;
    }
    const postAwait = this.itemsById.get(event.messageId);
    if (postAwait && postAwait.kind === "decrypted") {
      return false;
    }

    this.itemsById.set(converted.messageId, converted);
    const items = this.getItems();

    if (this.state.status === "empty") {
      this.setState({
        status: "ready",
        conversationId: capturedConv,
        items,
        hasMore: false,
        nextCursor: null,
        loadingOlder: false,
        pageError: null,
        keyUnavailableBanner: items.some(isKeyUnavailableFailure),
      });
    } else if (this.state.status === "ready") {
      this.setState({
        ...this.state,
        items,
        keyUnavailableBanner: items.some(isKeyUnavailableFailure),
      });
    }
    return true;
  }

  setDevice(device: DecryptCapableDevice | null): void {
    this.device = device;
  }

  switchConversation(
    conversationId: string,
    peerKeys?: { expectedPeerIdentityKey?: string; expectedPeerSenderKey?: string },
  ): void {
    this.epoch += 1;
    this.conversationId = conversationId;
    this.expectedPeerIdentityKey = peerKeys?.expectedPeerIdentityKey;
    this.expectedPeerSenderKey = peerKeys?.expectedPeerSenderKey;
    this.itemsById.clear();
    this.setState({
      status: "idle",
      conversationId,
      items: [],
    });
  }

  switchAccount(accountId: string, device: DecryptCapableDevice | null): void {
    this.epoch += 1;
    this.accountId = accountId;
    this.device = device;
    this.itemsById.clear();
    this.setState({
      status: "idle",
      conversationId: this.conversationId,
      items: [],
    });
  }

  dispose(): void {
    this.disposed = true;
    this.epoch += 1;
    this.itemsById.clear();
    this.listeners.clear();
  }
}
