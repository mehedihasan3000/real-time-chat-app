import { io, type Socket } from "socket.io-client";

import {
  SCHEMA_VERSION,
  SOCKET_NAMESPACE,
  SOCKET_SESSION_EXPIRED,
  SOCKET_SUBSCRIBE_EVENT,
  SOCKET_UNSUBSCRIBE_EVENT,
  isErrorCode,
  type ErrorCode,
} from "@chat/contracts";
import type { DecryptCapableDevice } from "@chat/crypto";

import {
  HistoryApiError,
  HistoryClient,
  type HistoryPageFetcher,
} from "../../features/chat/history";
import { parseMessageNewEventEnvelope } from "../../features/chat/receive";
import { errorCopyFor } from "../../i18n/errors";
import { computeReconnectDelayMs, type ReconnectBackoffOptions } from "./backoff";
import {
  ConversationCatchUpSynchronizer,
  type CatchUpRunResult,
  type ConversationSyncSnapshot,
  type SyncFailureInfo,
} from "./sync";

/**
 * Resilient Socket.IO `/v1` realtime client (`P2-08`, `DEC-019`, `DEC-021` §7.4,
 * `FR-AUTH-007`, `FR-CHAT-012`, `FR-HIST-003`, `NFR-REL-003`, `INT-003`–`INT-004`).
 *
 * - Keeps 5-minute EdDSA JWTs strictly in memory (`currentToken`), never in
 *   `localStorage`, `sessionStorage`, IndexedDB, or cookies.
 * - Uses bounded `NFR-REL-003` reconnect backoff (`1/2/4/8/16/30s` cap ±20% jitter)
 *   for transient transport drops and backend restarts.
 * - Executes `beginSubscribeBuffer()` -> `conversation:subscribe` -> HTTP ascending
 *   `after=lastAppliedSeq` catch-up -> ordered drain & deduplication on every
 *   (re)connect and conversation switch.
 * - Transitions immediately to `reauth_required` on `session:expired`, failed
 *   `auth:refresh`, `SESSION_REVOKED`, or `401` catch-up, stopping reconnect timers
 *   and disabling protected actions (`FR-AUTH-007`).
 */

export type RealtimeConnectionStatus =
  "disconnected" | "connecting" | "reconnecting" | "syncing" | "connected" | "reauth_required";

export type ReauthReason = "UNAUTHENTICATED" | "SESSION_REVOKED" | "TOKEN_REFRESH_FAILED";

export interface RealtimeSocketTransport {
  readonly connected: boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  off?(event: string, listener: (...args: unknown[]) => void): void;
  emit(event: string, payload: unknown, ack?: (body: unknown) => void): void;
  connect(): void;
  disconnect(): void;
  removeAllListeners?(): void;
}

export interface CreateSocketTransportParams {
  apiOrigin: string;
  token: string;
  extraHeaders?: Record<string, string>;
  transports?: Array<"websocket" | "polling">;
}

export type RealtimeSocketFactory = (
  params: CreateSocketTransportParams,
) => RealtimeSocketTransport;

export type RealtimeTokenProvider = (options?: {
  forceRefresh?: boolean;
}) => Promise<string | null> | string | null;

export interface RealtimeClientOptions {
  apiOrigin: string;
  accountId: string;
  conversationId: string;
  device: DecryptCapableDevice | null;
  tokenProvider: RealtimeTokenProvider;
  historyClient?: HistoryPageFetcher;
  fetchImpl?: typeof fetch;
  isOnline?: () => boolean;
  socketFactory?: RealtimeSocketFactory;
  extraHeaders?: Record<string, string>;
  transports?: Array<"websocket" | "polling">;
  refreshIntervalMs?: number;
  ackTimeoutMs?: number;
  pageLimit?: number;
  maxCatchUpPages?: number;
  maxGapRecoveryPasses?: number;
  maxBufferedEvents?: number;
  backoffOptions?: ReconnectBackoffOptions;
  expectedPeerIdentityKey?: string;
  expectedPeerSenderKey?: string;
  onReauthRequired?: (reason: ReauthReason) => void;
}

export interface RealtimeClientSnapshot {
  connectionStatus: RealtimeConnectionStatus;
  reconnectAttempt: number;
  nextRetryDelayMs: number | null;
  activeConversationId: string;
  subscribedConversationId: string | null;
  protectedActionsBlocked: boolean;
  reauthReason: ReauthReason | null;
  lastError: SyncFailureInfo | null;
  sync: ConversationSyncSnapshot;
}

export type RealtimeClientListener = (snapshot: RealtimeClientSnapshot) => void;

interface AckEnvelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string; retryable?: boolean };
}

export function createSocketIoTransport(
  params: CreateSocketTransportParams,
): RealtimeSocketTransport {
  const socket: Socket = io(`${params.apiOrigin}${SOCKET_NAMESPACE}`, {
    auth: { token: params.token },
    transports: params.transports ?? ["websocket", "polling"],
    ...(params.extraHeaders ? { extraHeaders: params.extraHeaders } : {}),
    autoConnect: false,
    reconnection: false,
  });

  return {
    get connected() {
      return socket.connected;
    },
    on(event, listener) {
      socket.on(event, listener);
    },
    off(event, listener) {
      socket.off(event, listener);
    },
    emit(event, payload, ack) {
      if (ack) {
        socket.emit(event, payload, ack);
      } else {
        socket.emit(event, payload);
      }
    },
    connect() {
      socket.connect();
    },
    disconnect() {
      socket.disconnect();
    },
    removeAllListeners() {
      socket.removeAllListeners();
    },
  };
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof timer === "object" && timer !== null) {
    (timer as { unref?: () => void }).unref?.();
  }
}

function parseAckEnvelope(raw: unknown): AckEnvelope | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.ok !== "boolean") return null;
  return {
    ok: rec.ok,
    ...(typeof rec.data === "object" && rec.data !== null
      ? { data: rec.data as Record<string, unknown> }
      : {}),
    ...(typeof rec.error === "object" && rec.error !== null
      ? { error: rec.error as AckEnvelope["error"] }
      : {}),
  };
}

export class RealtimeClient {
  private readonly apiOrigin: string;
  private accountId: string;
  private activeConversationId: string;
  private tokenProvider: RealtimeTokenProvider;
  private readonly socketFactory: RealtimeSocketFactory;
  private readonly extraHeaders?: Record<string, string>;
  private readonly transports?: Array<"websocket" | "polling">;
  private readonly refreshIntervalMs: number;
  private readonly ackTimeoutMs: number;
  private readonly backoffOptions: ReconnectBackoffOptions;
  private readonly onReauthRequiredCallback?: (reason: ReauthReason) => void;

  private readonly synchronizer: ConversationCatchUpSynchronizer;
  private readonly unsubSynchronizer: () => void;
  private readonly listeners = new Set<RealtimeClientListener>();

  private transport: RealtimeSocketTransport | null = null;
  private currentToken: string | null = null;
  private connectionStatus: RealtimeConnectionStatus = "disconnected";
  private reconnectAttempt = 0;
  private nextRetryDelayMs: number | null = null;
  private subscribedConversationId: string | null = null;
  private reauthReason: ReauthReason | null = null;
  private lastError: SyncFailureInfo | null = null;

  private connectionGeneration = 0;
  private intentDisconnected = true;
  private disposed = false;
  private handshakingWithFreshToken = false;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private initialAttemptWaiter: ((snapshot: RealtimeClientSnapshot) => void) | null = null;

  constructor(options: RealtimeClientOptions) {
    this.apiOrigin = options.apiOrigin;
    this.accountId = options.accountId;
    this.activeConversationId = options.conversationId;
    this.tokenProvider = options.tokenProvider;
    this.socketFactory = options.socketFactory ?? createSocketIoTransport;
    this.extraHeaders = options.extraHeaders;
    this.transports = options.transports;
    this.refreshIntervalMs = Math.max(100, options.refreshIntervalMs ?? 4 * 60 * 1000);
    this.ackTimeoutMs = Math.max(250, options.ackTimeoutMs ?? 10_000);
    this.backoffOptions = options.backoffOptions ?? {};
    this.onReauthRequiredCallback = options.onReauthRequired;

    const historyClient: HistoryPageFetcher =
      options.historyClient ??
      new HistoryClient({
        apiOrigin: options.apiOrigin,
        fetchImpl: options.fetchImpl,
        isOnline: options.isOnline,
        getToken: () => this.resolveTokenForHttp(),
      });

    this.synchronizer = new ConversationCatchUpSynchronizer({
      accountId: options.accountId,
      conversationId: options.conversationId,
      device: options.device,
      historyClient,
      pageLimit: options.pageLimit,
      maxCatchUpPages: options.maxCatchUpPages,
      maxGapRecoveryPasses: options.maxGapRecoveryPasses,
      maxBufferedEvents: options.maxBufferedEvents,
      expectedPeerIdentityKey: options.expectedPeerIdentityKey,
      expectedPeerSenderKey: options.expectedPeerSenderKey,
    });

    this.unsubSynchronizer = this.synchronizer.subscribe((syncSnapshot) => {
      if (
        syncSnapshot.phase === "reauth_required" &&
        this.connectionStatus !== "reauth_required" &&
        !this.disposed
      ) {
        const reason: ReauthReason =
          syncSnapshot.lastError?.code === "UNAUTHENTICATED"
            ? "UNAUTHENTICATED"
            : "SESSION_REVOKED";
        this.transitionToReauthRequired(reason);
        return;
      }
      if (syncSnapshot.phase === "error" && syncSnapshot.lastError) {
        this.lastError = syncSnapshot.lastError;
      }
      this.emit();
    });
  }

  getSynchronizer(): ConversationCatchUpSynchronizer {
    return this.synchronizer;
  }

  getSnapshot(): RealtimeClientSnapshot {
    return {
      connectionStatus: this.connectionStatus,
      reconnectAttempt: this.reconnectAttempt,
      nextRetryDelayMs: this.nextRetryDelayMs,
      activeConversationId: this.activeConversationId,
      subscribedConversationId: this.subscribedConversationId,
      protectedActionsBlocked: this.disposed || this.connectionStatus === "reauth_required",
      reauthReason: this.reauthReason,
      lastError: this.lastError,
      sync: this.synchronizer.getSnapshot(),
    };
  }

  subscribe(listener: RealtimeClientListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    if (this.disposed) return;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private isReauthRequired(): boolean {
    return this.connectionStatus === "reauth_required";
  }

  private settleInitialAttempt(): void {
    if (!this.initialAttemptWaiter) return;
    const resolve = this.initialAttemptWaiter;
    this.initialAttemptWaiter = null;
    resolve(this.getSnapshot());
  }

  private async resolveTokenForHttp(): Promise<string> {
    if (this.disposed || this.connectionStatus === "reauth_required") {
      throw new HistoryApiError(401, "SESSION_REVOKED", false);
    }
    if (this.currentToken) {
      return this.currentToken;
    }
    const fetched = await this.tokenProvider({ forceRefresh: false });
    if (!fetched) {
      this.transitionToReauthRequired("TOKEN_REFRESH_FAILED");
      throw new HistoryApiError(401, "SESSION_REVOKED", false);
    }
    this.currentToken = fetched;
    return fetched;
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private teardownTransport(): void {
    this.stopRefreshTimer();
    this.subscribedConversationId = null;
    if (this.transport) {
      const target = this.transport;
      this.transport = null;
      target.removeAllListeners?.();
      target.disconnect();
    }
  }

  private emitAck(
    target: RealtimeSocketTransport,
    event: string,
    payload: unknown,
    capturedGeneration: number,
  ): Promise<AckEnvelope | null> {
    return new Promise((resolve) => {
      if (this.disposed || this.connectionGeneration !== capturedGeneration || !target.connected) {
        resolve(null);
        return;
      }

      let finished = false;
      const done = (result: AckEnvelope | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        target.off?.("disconnect", onDisconnect);
        resolve(result);
      };

      const onDisconnect = () => done(null);
      const timer = setTimeout(() => done(null), this.ackTimeoutMs);
      unrefTimer(timer);

      target.on("disconnect", onDisconnect);
      target.emit(event, payload, (rawAck: unknown) => {
        done(parseAckEnvelope(rawAck));
      });
    });
  }

  private async openConnectionAttempt(forceRefresh: boolean): Promise<void> {
    if (this.disposed || this.isReauthRequired() || this.intentDisconnected) {
      this.settleInitialAttempt();
      return;
    }

    this.teardownTransport();
    const token = await this.tokenProvider({ forceRefresh });
    if (this.disposed || this.intentDisconnected || this.isReauthRequired()) {
      this.settleInitialAttempt();
      return;
    }
    if (!token) {
      this.transitionToReauthRequired("TOKEN_REFRESH_FAILED");
      return;
    }
    this.currentToken = token;

    this.connectionGeneration += 1;
    const capturedGen = this.connectionGeneration;
    this.connectionStatus = this.reconnectAttempt > 0 ? "reconnecting" : "connecting";
    this.emit();

    const socket = this.socketFactory({
      apiOrigin: this.apiOrigin,
      token,
      extraHeaders: this.extraHeaders,
      transports: this.transports,
    });
    this.transport = socket;

    socket.on("connect", () => {
      if (
        this.disposed ||
        capturedGen !== this.connectionGeneration ||
        this.connectionStatus === "reauth_required"
      ) {
        return;
      }
      this.reconnectAttempt = 0;
      this.nextRetryDelayMs = null;
      this.handshakingWithFreshToken = false;
      this.lastError = null;

      this.stopRefreshTimer();
      this.refreshTimer = setInterval(() => {
        void this.refreshAuthNow();
      }, this.refreshIntervalMs);
      unrefTimer(this.refreshTimer);

      void this.performSubscribeAndSync(capturedGen).finally(() => {
        if (capturedGen === this.connectionGeneration) {
          this.settleInitialAttempt();
        }
      });
    });

    socket.on("message:new", (rawPayload: unknown) => {
      if (
        this.disposed ||
        capturedGen !== this.connectionGeneration ||
        this.connectionStatus === "reauth_required"
      ) {
        return;
      }
      const parsed = parseMessageNewEventEnvelope(rawPayload);
      if (!parsed.ok) return;
      void this.synchronizer.onLiveMessage(parsed.event);
    });

    socket.on(SOCKET_SESSION_EXPIRED, () => {
      if (this.disposed || capturedGen !== this.connectionGeneration) return;
      this.transitionToReauthRequired("SESSION_REVOKED");
    });

    socket.on("connect_error", (rawErr: unknown) => {
      if (
        this.disposed ||
        capturedGen !== this.connectionGeneration ||
        this.connectionStatus === "reauth_required"
      ) {
        return;
      }
      const reasonText =
        typeof (rawErr as { message?: unknown } | null)?.message === "string"
          ? ((rawErr as { message: string }).message ?? "")
          : "";

      if (reasonText === "SESSION_REVOKED") {
        this.transitionToReauthRequired("SESSION_REVOKED");
        return;
      }
      if (reasonText === "UNAUTHENTICATED") {
        if (!this.handshakingWithFreshToken) {
          this.handshakingWithFreshToken = true;
          this.teardownTransport();
          void this.openConnectionAttempt(true);
          return;
        }
        this.transitionToReauthRequired("UNAUTHENTICATED");
        return;
      }
      if (reasonText === "UNTRUSTED_ORIGIN") {
        this.intentDisconnected = true;
        this.teardownTransport();
        this.connectionStatus = "disconnected";
        this.lastError = {
          code: "FORBIDDEN",
          retryable: false,
          requestId: null,
          retryAfterSeconds: null,
          copy: errorCopyFor("FORBIDDEN"),
        };
        this.emit();
        this.settleInitialAttempt();
        return;
      }

      this.teardownTransport();
      if (!this.intentDisconnected) {
        this.scheduleReconnect("TEMPORARILY_UNAVAILABLE");
      }
      this.settleInitialAttempt();
    });

    socket.on("disconnect", () => {
      if (this.disposed || capturedGen !== this.connectionGeneration) return;
      this.stopRefreshTimer();
      this.subscribedConversationId = null;

      if (this.connectionStatus === "reauth_required") {
        this.settleInitialAttempt();
        return;
      }
      if (this.intentDisconnected) {
        this.connectionStatus = "disconnected";
        this.emit();
        this.settleInitialAttempt();
        return;
      }

      this.teardownTransport();
      this.scheduleReconnect("TEMPORARILY_UNAVAILABLE");
      this.settleInitialAttempt();
    });

    socket.connect();
  }

  private scheduleReconnect(code: ErrorCode = "TEMPORARILY_UNAVAILABLE"): void {
    if (this.disposed || this.intentDisconnected || this.connectionStatus === "reauth_required") {
      return;
    }
    this.stopReconnectTimer();
    const delayMs = computeReconnectDelayMs(this.reconnectAttempt, this.backoffOptions);
    this.reconnectAttempt += 1;
    this.nextRetryDelayMs = delayMs;
    this.connectionStatus = "reconnecting";
    this.lastError = {
      code,
      retryable: true,
      requestId: null,
      retryAfterSeconds: Math.max(1, Math.round(delayMs / 1000)),
      copy: errorCopyFor(code),
    };
    this.emit();

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (
        !this.disposed &&
        !this.intentDisconnected &&
        this.connectionStatus !== "reauth_required"
      ) {
        void this.openConnectionAttempt(false);
      }
    }, delayMs);
  }

  private async performSubscribeAndSync(capturedGeneration: number): Promise<void> {
    const socket = this.transport;
    const convId = this.activeConversationId;
    if (
      this.disposed ||
      !socket ||
      !socket.connected ||
      capturedGeneration !== this.connectionGeneration ||
      this.connectionStatus === "reauth_required"
    ) {
      return;
    }

    this.connectionStatus = "syncing";
    this.emit();

    // Critical DEC-021 §7.4 ordering: start buffering live message:new events BEFORE emitting subscribe.
    this.synchronizer.beginSubscribeBuffer();

    const ack = await this.emitAck(
      socket,
      SOCKET_SUBSCRIBE_EVENT,
      {
        schemaVersion: SCHEMA_VERSION,
        conversationId: convId,
        data: {
          conversationId: convId,
          lastAppliedSeq: this.synchronizer.getLastAppliedSeq(),
        },
      },
      capturedGeneration,
    );

    if (
      this.disposed ||
      capturedGeneration !== this.connectionGeneration ||
      this.isReauthRequired()
    ) {
      return;
    }

    if (!ack) {
      // Transport dropped or timed out mid-subscribe; if still connected, retry bounded reconnect.
      if (this.transport?.connected && !this.intentDisconnected) {
        this.teardownTransport();
        this.scheduleReconnect("TEMPORARILY_UNAVAILABLE");
      }
      return;
    }

    if (!ack.ok) {
      const code = ack.error?.code;
      if (code === "SESSION_REVOKED" || code === "UNAUTHENTICATED") {
        this.transitionToReauthRequired(code);
        return;
      }
      if (code === "RATE_LIMITED") {
        this.teardownTransport();
        this.scheduleReconnect("RATE_LIMITED");
        return;
      }
      const mappedCode: ErrorCode = isErrorCode(code) ? code : "FORBIDDEN";
      this.lastError = {
        code: mappedCode,
        retryable: Boolean(ack.error?.retryable),
        requestId: null,
        retryAfterSeconds: null,
        copy: errorCopyFor(mappedCode),
      };
      this.subscribedConversationId = null;
      this.connectionStatus = "disconnected";
      this.emit();
      return;
    }

    this.subscribedConversationId = convId;
    const syncResult = await this.synchronizer.runCatchUp();
    if (
      this.disposed ||
      capturedGeneration !== this.connectionGeneration ||
      this.isReauthRequired()
    ) {
      return;
    }
    if (syncResult.reauthRequired) {
      this.transitionToReauthRequired("SESSION_REVOKED");
      return;
    }

    if (this.transport?.connected) {
      this.connectionStatus = "connected";
      this.lastError = syncResult.error;
      this.emit();
    }
  }

  private transitionToReauthRequired(reason: ReauthReason): void {
    if (this.disposed) return;
    const alreadyInReauth = this.connectionStatus === "reauth_required";
    this.intentDisconnected = true;
    this.connectionGeneration += 1;
    this.stopReconnectTimer();
    this.teardownTransport();
    this.currentToken = null;
    this.reconnectAttempt = 0;
    this.nextRetryDelayMs = null;
    this.connectionStatus = "reauth_required";
    this.reauthReason = reason;
    const errorCode: "UNAUTHENTICATED" | "SESSION_REVOKED" =
      reason === "UNAUTHENTICATED" ? "UNAUTHENTICATED" : "SESSION_REVOKED";
    this.lastError = {
      code: errorCode,
      retryable: false,
      requestId: null,
      retryAfterSeconds: null,
      copy: errorCopyFor(errorCode),
    };
    this.synchronizer.enterReauthRequired(errorCode);
    this.emit();
    this.settleInitialAttempt();
    if (!alreadyInReauth) {
      this.onReauthRequiredCallback?.(reason);
    }
  }

  /**
   * Open authenticated `/v1` socket connection, subscribe, and catch up retained history.
   */
  async connect(): Promise<RealtimeClientSnapshot> {
    if (this.disposed || this.connectionStatus === "reauth_required") {
      return this.getSnapshot();
    }
    if (this.transport?.connected) {
      return this.getSnapshot();
    }

    this.stopReconnectTimer();
    this.intentDisconnected = false;
    this.handshakingWithFreshToken = false;

    const settledPromise = new Promise<RealtimeClientSnapshot>((resolve) => {
      this.initialAttemptWaiter = resolve;
    });
    await this.openConnectionAttempt(false);
    return settledPromise;
  }

  /**
   * Proactively refresh the in-memory JWT and reauthenticate the live socket (`INT-003`).
   */
  async refreshAuthNow(): Promise<boolean> {
    if (this.disposed || this.isReauthRequired()) {
      return false;
    }
    const fresh = await this.tokenProvider({ forceRefresh: true });
    if (this.disposed || this.isReauthRequired()) {
      return false;
    }
    if (!fresh) {
      this.transitionToReauthRequired("TOKEN_REFRESH_FAILED");
      return false;
    }
    this.currentToken = fresh;

    const socket = this.transport;
    if (!socket || !socket.connected) {
      return true;
    }

    const ack = await this.emitAck(
      socket,
      "auth:refresh",
      { token: fresh },
      this.connectionGeneration,
    );
    if (!ack) {
      return false;
    }
    if (!ack.ok) {
      const code = ack.error?.code;
      if (code === "UNAUTHENTICATED") {
        this.transitionToReauthRequired("UNAUTHENTICATED");
      } else if (code === "SESSION_REVOKED" || !ack.error?.retryable) {
        this.transitionToReauthRequired("SESSION_REVOKED");
      }
      return false;
    }
    return true;
  }

  /**
   * Manually trigger catch-up from the current `lastAppliedSeq` watermark (blocked on `reauth_required`).
   */
  async triggerCatchUp(): Promise<CatchUpRunResult | null> {
    if (this.disposed || this.connectionStatus === "reauth_required") {
      return null;
    }
    const result = await this.synchronizer.runCatchUp();
    if (result.ok && this.transport?.connected && this.connectionStatus === "connected") {
      this.lastError = null;
      this.emit();
    }
    return result;
  }

  /**
   * Switch active conversation (`ERR-003` epoch isolation + resubscribe + catch-up).
   */
  async switchConversation(
    conversationId: string,
    peerKeys?: { expectedPeerIdentityKey?: string; expectedPeerSenderKey?: string },
  ): Promise<boolean> {
    if (this.disposed || this.connectionStatus === "reauth_required") {
      return false;
    }

    const prevSubscribed = this.subscribedConversationId;
    this.activeConversationId = conversationId;
    this.subscribedConversationId = null;
    this.synchronizer.switchConversation(conversationId, peerKeys);

    const socket = this.transport;
    const capturedGen = this.connectionGeneration;
    if (socket && socket.connected) {
      if (prevSubscribed && prevSubscribed !== conversationId) {
        socket.emit(SOCKET_UNSUBSCRIBE_EVENT, {
          schemaVersion: SCHEMA_VERSION,
          conversationId: prevSubscribed,
          data: { conversationId: prevSubscribed },
        });
      }
      await this.performSubscribeAndSync(capturedGen);
      return !this.isReauthRequired();
    }

    this.emit();
    return true;
  }

  /**
   * Switch active authenticated account (`ERR-003` full token and state reset).
   */
  switchAccount(
    accountId: string,
    device: DecryptCapableDevice | null,
    tokenProvider?: RealtimeTokenProvider,
  ): void {
    if (this.disposed) return;
    this.intentDisconnected = true;
    this.connectionGeneration += 1;
    this.stopReconnectTimer();
    this.teardownTransport();
    this.currentToken = null;
    this.accountId = accountId;
    if (tokenProvider) {
      this.tokenProvider = tokenProvider;
    }
    this.reconnectAttempt = 0;
    this.nextRetryDelayMs = null;
    this.reauthReason = null;
    this.lastError = null;
    this.connectionStatus = "disconnected";
    this.synchronizer.switchAccount(accountId, device);
    this.emit();
  }

  /**
   * Clear `reauth_required` once the user has reauthenticated with a fresh session.
   */
  reauthenticate(tokenProvider?: RealtimeTokenProvider): void {
    if (this.disposed) return;
    if (tokenProvider) {
      this.tokenProvider = tokenProvider;
    }
    this.reauthReason = null;
    this.lastError = null;
    this.reconnectAttempt = 0;
    this.nextRetryDelayMs = null;
    this.currentToken = null;
    this.connectionStatus = "disconnected";
    this.synchronizer.resetAfterReauthentication();
    this.emit();
  }

  /**
   * Notify client that the session expired/revoked externally (e.g., sibling HTTP 401 or user logout).
   */
  handleSessionInvalidated(reason: ReauthReason = "SESSION_REVOKED"): void {
    this.transitionToReauthRequired(reason);
  }

  disconnect(): void {
    if (this.disposed) return;
    this.intentDisconnected = true;
    this.connectionGeneration += 1;
    this.stopReconnectTimer();
    this.teardownTransport();
    this.currentToken = null;
    this.reconnectAttempt = 0;
    this.nextRetryDelayMs = null;
    if (this.connectionStatus !== "reauth_required") {
      this.connectionStatus = "disconnected";
    }
    this.emit();
    this.settleInitialAttempt();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.intentDisconnected = true;
    this.connectionGeneration += 1;
    this.stopReconnectTimer();
    this.teardownTransport();
    this.currentToken = null;
    this.unsubSynchronizer();
    this.synchronizer.dispose();
    this.settleInitialAttempt();
    this.listeners.clear();
  }
}
