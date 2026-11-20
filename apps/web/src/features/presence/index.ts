import {
  DEFAULT_ACTIVITY_SHARING_ENABLED,
  PRESENCE_SCHEMA_VERSION,
  TYPING_COALESCE_MS,
  TYPING_EXPIRY_MS,
  isErrorCode,
  isOpaqueId,
  validateActivityPreferencesView,
  validateConversationPresenceResponse,
  validatePresenceUpdateEvent,
  validateTypingSignalResponse,
  validateTypingUpdateEvent,
  type ActivityPreferencesView,
  type ConversationPresenceResponse,
  type ConversationPresenceView,
  type Envelope,
  type ErrorCode,
  type PresenceState,
  type PresenceUpdateEvent,
  type TypingSignalRequest,
  type TypingSignalResponse,
  type TypingUpdateEvent,
  type UpdateActivityPreferencesRequest,
} from "@chat/contracts";

/**
 * Presence & typing client and state controller v0 (`P2-12`, `FR-PRES-001`..`004`,
 * `DEC-002`, `DEC-008`, `DEC-015`, `DEC-016`, `DEC-020` §6.3, `ERR-003`).
 */

export class PresenceApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode | "INVALID_RESPONSE",
    public readonly retryable: boolean,
    public readonly requestId: string | null = null,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Presence API request failed with ${code} (${status})`);
    this.name = "PresenceApiError";
  }
}

export interface PresenceClientOptions {
  apiOrigin?: string;
  origin?: string;
  expectedUserId: string;
  getToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
}

export interface PresenceClient {
  getActivityPreferences(): Promise<ActivityPreferencesView>;
  setActivityPreferences(activitySharingEnabled: boolean): Promise<ActivityPreferencesView>;
  getConversationPresence(conversationId: string): Promise<ConversationPresenceResponse>;
  sendTypingSignal(conversationId: string, isTyping: boolean): Promise<TypingSignalResponse>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export type ParsedPresenceUpdateEvent =
  | { ok: true; event: PresenceUpdateEvent }
  | { ok: false; reason: "invalid_envelope" | "invalid_event" };

/** Parses and validates a live Socket.IO `"presence:update"` payload. */
export function parsePresenceUpdateEventEnvelope(rawPayload: unknown): ParsedPresenceUpdateEvent {
  if (!isPlainRecord(rawPayload)) {
    return { ok: false, reason: "invalid_envelope" };
  }
  const candidate = rawPayload.ok === true && "data" in rawPayload ? rawPayload.data : rawPayload;
  const checked = validatePresenceUpdateEvent(candidate);
  if (!checked.ok) {
    return { ok: false, reason: "invalid_event" };
  }
  return { ok: true, event: checked.value };
}

export type ParsedTypingUpdateEvent =
  | { ok: true; event: TypingUpdateEvent }
  | { ok: false; reason: "invalid_envelope" | "invalid_event" };

/** Parses and validates a live Socket.IO `"typing:update"` payload. */
export function parseTypingUpdateEventEnvelope(rawPayload: unknown): ParsedTypingUpdateEvent {
  if (!isPlainRecord(rawPayload)) {
    return { ok: false, reason: "invalid_envelope" };
  }
  const candidate = rawPayload.ok === true && "data" in rawPayload ? rawPayload.data : rawPayload;
  const checked = validateTypingUpdateEvent(candidate);
  if (!checked.ok) {
    return { ok: false, reason: "invalid_event" };
  }
  return { ok: true, event: checked.value };
}

export class HttpPresenceClient implements PresenceClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PresenceClientOptions) {
    const rawOrigin = options.apiOrigin ?? options.origin ?? "";
    this.origin = rawOrigin.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async getActivityPreferences(): Promise<ActivityPreferencesView> {
    const raw = await this.request("/api/v1/me/activity-preferences", { method: "GET" });
    const checked = validateActivityPreferencesView(raw);
    if (!checked.ok || checked.value.userId !== this.options.expectedUserId) {
      throw new PresenceApiError(502, "INVALID_RESPONSE", false);
    }
    return checked.value;
  }

  async setActivityPreferences(activitySharingEnabled: boolean): Promise<ActivityPreferencesView> {
    const payload: UpdateActivityPreferencesRequest = {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      activitySharingEnabled,
    };
    const raw = await this.request("/api/v1/me/activity-preferences", {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    const checked = validateActivityPreferencesView(raw);
    if (!checked.ok || checked.value.userId !== this.options.expectedUserId) {
      throw new PresenceApiError(502, "INVALID_RESPONSE", false);
    }
    return checked.value;
  }

  async getConversationPresence(conversationId: string): Promise<ConversationPresenceResponse> {
    if (!isOpaqueId(conversationId)) {
      throw new PresenceApiError(400, "INVALID_REQUEST", false);
    }
    const raw = await this.request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/presence`,
      { method: "GET" },
    );
    const checked = validateConversationPresenceResponse(raw);
    if (!checked.ok || checked.value.presence.conversationId !== conversationId) {
      throw new PresenceApiError(502, "INVALID_RESPONSE", false);
    }
    return checked.value;
  }

  async sendTypingSignal(conversationId: string, isTyping: boolean): Promise<TypingSignalResponse> {
    if (!isOpaqueId(conversationId)) {
      throw new PresenceApiError(400, "INVALID_REQUEST", false);
    }
    const payload: TypingSignalRequest = {
      schemaVersion: PRESENCE_SCHEMA_VERSION,
      isTyping,
    };
    const raw = await this.request(
      `/api/v1/conversations/${encodeURIComponent(conversationId)}/typing`,
      { method: "POST", body: JSON.stringify(payload) },
    );
    const checked = validateTypingSignalResponse(raw);
    if (!checked.ok || checked.value.typing.conversationId !== conversationId) {
      throw new PresenceApiError(502, "INVALID_RESPONSE", false);
    }
    return checked.value;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const token = await this.options.getToken();
    const headers = new Headers(init.headers ?? {});
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");

    const response = await this.fetchImpl(`${this.origin}${path}`, {
      ...init,
      headers,
      credentials: "omit",
    });

    const retryHeader = response.headers.get("retry-after");
    const retryAfterSeconds = retryHeader ? Number.parseInt(retryHeader, 10) : null;

    let body: Envelope<unknown> | null = null;
    try {
      body = (await response.json()) as Envelope<unknown>;
    } catch {
      body = null;
    }

    if (!response.ok || !body || !body.ok) {
      const code =
        body && !body.ok && isErrorCode(body.error.code) ? body.error.code : "INTERNAL_ERROR";
      const retryable =
        body && !body.ok ? body.error.retryable : response.status >= 500 || response.status === 429;
      const requestId =
        body && !body.ok && typeof body.requestId === "string" ? body.requestId : null;
      throw new PresenceApiError(
        response.status,
        code,
        retryable,
        requestId,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
      );
    }

    return body.data;
  }
}

export interface PresenceControllerSnapshot {
  conversationId: string;
  currentUserId: string;
  peerUserId: string;
  peerStatus: PresenceState;
  peerTyping: boolean;
  peerTypingExpiresAt: string | null;
  activitySharingEnabled: boolean;
  localTypingActive: boolean;
  coalescedOutboundCount: number;
  emittedOutboundSignals: number;
  lastErrorCode: ErrorCode | "INVALID_RESPONSE" | null;
}

export interface PresenceAndTypingControllerOptions {
  conversationId: string;
  currentUserId: string;
  peerUserId: string;
  client: PresenceClient;
  typingExpiryMs?: number;
  typingCoalesceMs?: number;
  now?: () => number;
  onStateChange?: (snapshot: PresenceControllerSnapshot) => void;
}

/**
 * Manages conversation-scoped peer presence (`online | offline | unknown`),
 * 5-second auto-expiring peer typing state, 2-second coalesced outbound typing
 * signals, immediate clear on stop/disconnect/reconnect/block/preference-off,
 * and `ERR-003` stale-context isolation (`P2-12`).
 */
export class PresenceAndTypingController {
  private conversationId: string;
  private currentUserId: string;
  private peerUserId: string;
  private peerStatus: PresenceState = "unknown";
  private peerTyping = false;
  private peerTypingExpiresAt: string | null = null;
  private activitySharingEnabled: boolean = DEFAULT_ACTIVITY_SHARING_ENABLED;
  private localTypingActive = false;
  private lastOutboundSignalAtMs: number | null = null;
  private coalescedOutboundCount = 0;
  private emittedOutboundSignals = 0;
  private lastErrorCode: ErrorCode | "INVALID_RESPONSE" | null = null;

  private contextEpoch = 0;
  private peerTypingTimer: ReturnType<typeof setTimeout> | null = null;
  private localIdleStopTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly typingExpiryMs: number;
  private readonly typingCoalesceMs: number;
  private readonly now: () => number;

  constructor(private readonly options: PresenceAndTypingControllerOptions) {
    this.conversationId = options.conversationId;
    this.currentUserId = options.currentUserId;
    this.peerUserId = options.peerUserId;
    this.typingExpiryMs = options.typingExpiryMs ?? TYPING_EXPIRY_MS;
    this.typingCoalesceMs = options.typingCoalesceMs ?? TYPING_COALESCE_MS;
    this.now = options.now ?? (() => Date.now());
  }

  getSnapshot(): PresenceControllerSnapshot {
    return {
      conversationId: this.conversationId,
      currentUserId: this.currentUserId,
      peerUserId: this.peerUserId,
      peerStatus: this.peerStatus,
      peerTyping: this.peerTyping,
      peerTypingExpiresAt: this.peerTypingExpiresAt,
      activitySharingEnabled: this.activitySharingEnabled,
      localTypingActive: this.localTypingActive,
      coalescedOutboundCount: this.coalescedOutboundCount,
      emittedOutboundSignals: this.emittedOutboundSignals,
      lastErrorCode: this.lastErrorCode,
    };
  }

  private emit(): void {
    this.options.onStateChange?.(this.getSnapshot());
  }

  private clearPeerTypingTimer(): void {
    if (this.peerTypingTimer !== null) {
      clearTimeout(this.peerTypingTimer);
      this.peerTypingTimer = null;
    }
  }

  private clearLocalIdleStopTimer(): void {
    if (this.localIdleStopTimer !== null) {
      clearTimeout(this.localIdleStopTimer);
      this.localIdleStopTimer = null;
    }
  }

  private schedulePeerTypingExpiry(expiresAt: string | null): void {
    this.clearPeerTypingTimer();
    if (!this.peerTyping) return;
    const targetMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    const rawDelay = Number.isFinite(targetMs) ? targetMs - this.now() : this.typingExpiryMs;
    const delayMs = Math.max(0, Math.min(this.typingExpiryMs, rawDelay));
    const epoch = this.contextEpoch;
    this.peerTypingTimer = setTimeout(() => {
      this.peerTypingTimer = null;
      if (epoch !== this.contextEpoch) return;
      this.peerTyping = false;
      this.peerTypingExpiresAt = null;
      this.emit();
    }, delayMs);
  }

  private scheduleLocalIdleStop(): void {
    this.clearLocalIdleStopTimer();
    const epoch = this.contextEpoch;
    this.localIdleStopTimer = setTimeout(() => {
      this.localIdleStopTimer = null;
      if (epoch !== this.contextEpoch) return;
      void this.notifyLocalComposerStop();
    }, this.typingExpiryMs);
  }

  async loadInitialState(): Promise<PresenceControllerSnapshot> {
    const epoch = this.contextEpoch;
    try {
      const [prefs, presenceRes] = await Promise.all([
        this.options.client.getActivityPreferences(),
        this.options.client.getConversationPresence(this.conversationId),
      ]);
      if (epoch !== this.contextEpoch) return this.getSnapshot();
      this.activitySharingEnabled = prefs.activitySharingEnabled;
      this.applyConversationPresenceView(presenceRes.presence);
      this.lastErrorCode = null;
      this.emit();
    } catch (error) {
      if (epoch !== this.contextEpoch) return this.getSnapshot();
      if (error instanceof PresenceApiError) {
        this.lastErrorCode = error.code;
        this.emit();
      }
    }
    return this.getSnapshot();
  }

  async setActivitySharing(enabled: boolean): Promise<PresenceControllerSnapshot> {
    const epoch = this.contextEpoch;
    try {
      const updated = await this.options.client.setActivityPreferences(enabled);
      if (epoch !== this.contextEpoch) return this.getSnapshot();
      this.activitySharingEnabled = updated.activitySharingEnabled;
      if (!enabled) {
        this.peerStatus = "unknown";
        this.peerTyping = false;
        this.peerTypingExpiresAt = null;
        this.localTypingActive = false;
        this.clearPeerTypingTimer();
        this.clearLocalIdleStopTimer();
      } else {
        const refreshed = await this.options.client.getConversationPresence(this.conversationId);
        if (epoch !== this.contextEpoch) return this.getSnapshot();
        this.applyConversationPresenceView(refreshed.presence);
      }
      this.lastErrorCode = null;
      this.emit();
    } catch (error) {
      if (epoch !== this.contextEpoch) return this.getSnapshot();
      if (error instanceof PresenceApiError) {
        this.lastErrorCode = error.code;
        this.emit();
      }
    }
    return this.getSnapshot();
  }

  private applyConversationPresenceView(view: ConversationPresenceView): void {
    if (view.conversationId !== this.conversationId || view.peerUserId !== this.peerUserId) {
      return;
    }
    if (!this.activitySharingEnabled) {
      this.peerStatus = "unknown";
      this.peerTyping = false;
      this.peerTypingExpiresAt = null;
      this.clearPeerTypingTimer();
      return;
    }
    this.peerStatus = view.status;
    if (view.status === "online" && view.typing) {
      this.peerTyping = true;
      this.peerTypingExpiresAt = view.typingExpiresAt;
      this.schedulePeerTypingExpiry(view.typingExpiresAt);
    } else {
      this.peerTyping = false;
      this.peerTypingExpiresAt = null;
      this.clearPeerTypingTimer();
    }
  }

  applyPresenceUpdateEvent(rawPayload: unknown): boolean {
    const parsed = parsePresenceUpdateEventEnvelope(rawPayload);
    if (!parsed.ok) return false;
    const { event } = parsed;
    if (event.conversationId !== this.conversationId || event.userId !== this.peerUserId) {
      return false;
    }
    this.peerStatus = this.activitySharingEnabled ? event.status : "unknown";
    if (this.peerStatus !== "online") {
      this.peerTyping = false;
      this.peerTypingExpiresAt = null;
      this.clearPeerTypingTimer();
    }
    this.emit();
    return true;
  }

  applyTypingUpdateEvent(rawPayload: unknown): boolean {
    const parsed = parseTypingUpdateEventEnvelope(rawPayload);
    if (!parsed.ok) return false;
    const { event } = parsed;
    if (event.conversationId !== this.conversationId || event.userId !== this.peerUserId) {
      return false;
    }
    if (!this.activitySharingEnabled || this.peerStatus === "offline" || !event.isTyping) {
      this.peerTyping = false;
      this.peerTypingExpiresAt = null;
      this.clearPeerTypingTimer();
      this.emit();
      return true;
    }
    this.peerTyping = true;
    this.peerTypingExpiresAt = event.expiresAt;
    this.schedulePeerTypingExpiry(event.expiresAt);
    this.emit();
    return true;
  }

  /**
   * Sends a coalesced (`<= 1 / 2s`) typing start signal for active composer input,
   * never emitting while `activitySharingEnabled` is disabled (`FR-PRES-003`..`004`).
   */
  async notifyLocalComposerInput(): Promise<{ sent: boolean; coalesced: boolean }> {
    if (!this.activitySharingEnabled) {
      this.localTypingActive = false;
      this.clearLocalIdleStopTimer();
      this.emit();
      return { sent: false, coalesced: false };
    }
    const nowMs = this.now();
    this.localTypingActive = true;
    this.scheduleLocalIdleStop();

    if (
      this.lastOutboundSignalAtMs !== null &&
      nowMs - this.lastOutboundSignalAtMs < this.typingCoalesceMs
    ) {
      this.coalescedOutboundCount += 1;
      this.emit();
      return { sent: false, coalesced: true };
    }

    const epoch = this.contextEpoch;
    this.lastOutboundSignalAtMs = nowMs;
    try {
      await this.options.client.sendTypingSignal(this.conversationId, true);
      if (epoch !== this.contextEpoch) return { sent: false, coalesced: false };
      this.emittedOutboundSignals += 1;
      this.lastErrorCode = null;
      this.emit();
      return { sent: true, coalesced: false };
    } catch (error) {
      if (epoch !== this.contextEpoch) return { sent: false, coalesced: false };
      if (error instanceof PresenceApiError) {
        this.lastErrorCode = error.code;
        this.emit();
      }
      return { sent: false, coalesced: false };
    }
  }

  /**
   * Immediately clears local typing and sends an un-coalesced stop signal when
   * active (`FR-PRES-003`: explicit stop clears promptly).
   */
  async notifyLocalComposerStop(): Promise<void> {
    const wasActive = this.localTypingActive;
    this.localTypingActive = false;
    this.clearLocalIdleStopTimer();
    this.emit();

    if (!wasActive || !this.activitySharingEnabled) return;
    const epoch = this.contextEpoch;
    try {
      await this.options.client.sendTypingSignal(this.conversationId, false);
      if (epoch !== this.contextEpoch) return;
      this.emittedOutboundSignals += 1;
      this.lastErrorCode = null;
      this.emit();
    } catch (error) {
      if (epoch !== this.contextEpoch) return;
      if (error instanceof PresenceApiError) {
        this.lastErrorCode = error.code;
        this.emit();
      }
    }
  }

  /**
   * Clears stale peer and local typing indicators immediately on socket disconnect
   * (`FR-PRES-003`).
   */
  handleTransportDisconnect(): void {
    this.clearPeerTypingTimer();
    this.clearLocalIdleStopTimer();
    this.peerTyping = false;
    this.peerTypingExpiresAt = null;
    this.localTypingActive = false;
    this.emit();
  }

  /**
   * Clears stale indicators without replaying old typing signals and refreshes
   * authoritative peer presence snapshot after reconnect (`FR-PRES-001`, `FR-PRES-003`).
   */
  async handleTransportReconnect(): Promise<PresenceControllerSnapshot> {
    this.handleTransportDisconnect();
    return this.loadInitialState();
  }

  /** Switches active conversation or account safely under `ERR-003`. */
  switchContext(next: { conversationId: string; currentUserId: string; peerUserId: string }): void {
    this.contextEpoch += 1;
    this.clearPeerTypingTimer();
    this.clearLocalIdleStopTimer();
    this.conversationId = next.conversationId;
    this.currentUserId = next.currentUserId;
    this.peerUserId = next.peerUserId;
    this.peerStatus = "unknown";
    this.peerTyping = false;
    this.peerTypingExpiresAt = null;
    this.localTypingActive = false;
    this.lastOutboundSignalAtMs = null;
    this.coalescedOutboundCount = 0;
    this.emittedOutboundSignals = 0;
    this.lastErrorCode = null;
    this.emit();
  }

  dispose(): void {
    this.contextEpoch += 1;
    this.clearPeerTypingTimer();
    this.clearLocalIdleStopTimer();
  }
}
