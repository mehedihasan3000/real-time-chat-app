import {
  HISTORY_PAGE_DEFAULT,
  isErrorCode,
  type ErrorCode,
  type HistoryMessageItem,
  type MessageNewEvent,
} from "@chat/contracts";
import { decryptReceivedEnvelope, type DecryptCapableDevice } from "@chat/crypto";

import {
  HistoryApiError,
  mergeHistoryMessages,
  type HistoryPageFetcher,
} from "../../features/chat/history";
import type { ReceivedTimelineMessage } from "../../features/chat/receive";
import { errorCopyFor, type ErrorCopy } from "../../i18n/errors";

/**
 * Conversation reconnect synchronization state machine (`P2-08`, `DEC-021` §7.3–§7.4,
 * `FR-CHAT-012`, `FR-HIST-003`, `FR-AUTH-007`, `NFR-REL-002`, `ERR-003`).
 *
 * Implements the normative subscribe-buffer-catch-up-dedupe flow:
 * 1. Enter buffering BEFORE subscribing so live `message:new` events arriving
 *    between `conversation:subscribe` and HTTP catch-up are captured.
 * 2. Paginate ascending HTTP history via `after=lastAppliedSeq` and apply
 *    pages strictly in server `seq` order, deduplicating by `messageId` before
 *    invoking Olm decryption so Ratchet/replay state never corrupts.
 * 3. Drain buffered live events in ascending `seq` order once caught up.
 * 4. If a live event reveals a gap (`event.seq > lastAppliedSeq + 1`), keep it
 *    buffered (NEVER advance the watermark to the highest seen `seq`) and
 *    repeat authenticated HTTP catch-up from `lastAppliedSeq`; advance safely
 *    across permanent gaps only when catch-up persistence confirms absence.
 * 5. Clear protected state immediately and halt syncing on `401` auth/session
 *    revocation (`FR-AUTH-007`), while guarding all async completions with
 *    monotonically checked conversation/account epochs (`ERR-003`).
 */

export type SyncPhase = "idle" | "buffering" | "syncing" | "synced" | "reauth_required" | "error";

export interface SyncFailureInfo {
  code: ErrorCode | "INVALID_RESPONSE" | "OFFLINE" | null;
  retryable: boolean;
  requestId: string | null;
  retryAfterSeconds: number | null;
  copy: ErrorCopy;
}

export interface ConversationSyncSnapshot {
  accountId: string;
  conversationId: string;
  phase: SyncPhase;
  lastAppliedSeq: number;
  bufferedCount: number;
  items: readonly ReceivedTimelineMessage[];
  lastError: SyncFailureInfo | null;
  catchUpRuns: number;
  gapRecoveries: number;
}

export type SyncSnapshotListener = (snapshot: ConversationSyncSnapshot) => void;

export type LiveMessageAction =
  | { action: "ignored" }
  | { action: "wrong_conversation" }
  | { action: "duplicate" }
  | { action: "buffered" }
  | { action: "applied"; item: ReceivedTimelineMessage }
  | { action: "gap_catchup_triggered" };

export interface CatchUpRunResult {
  ok: boolean;
  reauthRequired: boolean;
  stale: boolean;
  appliedCount: number;
  lastAppliedSeq: number;
  error: SyncFailureInfo | null;
}

export interface ConversationCatchUpSynchronizerOptions {
  accountId: string;
  conversationId: string;
  device: DecryptCapableDevice | null;
  historyClient: HistoryPageFetcher;
  pageLimit?: number;
  initialItems?: readonly ReceivedTimelineMessage[];
  initialLastAppliedSeq?: number;
  expectedPeerIdentityKey?: string;
  expectedPeerSenderKey?: string;
  maxCatchUpPages?: number;
  maxGapRecoveryPasses?: number;
  maxBufferedEvents?: number;
  onReauthRequired?: (code: "UNAUTHENTICATED" | "SESSION_REVOKED") => void;
}

function mapSyncFailure(error: unknown): SyncFailureInfo {
  if (error instanceof HistoryApiError) {
    const stableCode = isErrorCode(error.code) ? error.code : null;
    return {
      code: error.code,
      retryable: error.retryable,
      requestId: error.requestId,
      retryAfterSeconds: error.retryAfterSeconds,
      copy: errorCopyFor(error.code === "OFFLINE" ? "TEMPORARILY_UNAVAILABLE" : stableCode),
    };
  }
  return {
    code: null,
    retryable: true,
    requestId: null,
    retryAfterSeconds: null,
    copy: errorCopyFor(null),
  };
}

export class ConversationCatchUpSynchronizer {
  private accountId: string;
  private conversationId: string;
  private device: DecryptCapableDevice | null;
  private readonly historyClient: HistoryPageFetcher;
  private readonly pageLimit: number;
  private expectedPeerIdentityKey?: string;
  private expectedPeerSenderKey?: string;
  private readonly maxCatchUpPages: number;
  private readonly maxGapRecoveryPasses: number;
  private readonly maxBufferedEvents: number;
  private readonly onReauthRequired?: (code: "UNAUTHENTICATED" | "SESSION_REVOKED") => void;

  private epoch = 0;
  private disposed = false;
  private phase: SyncPhase = "idle";
  private buffering = false;
  private lastAppliedSeq = 0;
  private lastError: SyncFailureInfo | null = null;
  private catchUpRuns = 0;
  private gapRecoveries = 0;
  private bufferOverflowed = false;
  private syncAgainRequested = false;
  private syncInFlight: Promise<CatchUpRunResult> | null = null;
  private liveApplyChain: Promise<void> = Promise.resolve();

  private readonly itemsById = new Map<string, ReceivedTimelineMessage>();
  private readonly bufferedLiveEvents = new Map<string, MessageNewEvent>();
  private readonly listeners = new Set<SyncSnapshotListener>();

  constructor(options: ConversationCatchUpSynchronizerOptions) {
    this.accountId = options.accountId;
    this.conversationId = options.conversationId;
    this.device = options.device;
    this.historyClient = options.historyClient;
    this.pageLimit = options.pageLimit ?? HISTORY_PAGE_DEFAULT;
    this.expectedPeerIdentityKey = options.expectedPeerIdentityKey;
    this.expectedPeerSenderKey = options.expectedPeerSenderKey;
    this.maxCatchUpPages = Math.max(1, options.maxCatchUpPages ?? 100);
    this.maxGapRecoveryPasses = Math.max(1, options.maxGapRecoveryPasses ?? 3);
    this.maxBufferedEvents = Math.max(10, options.maxBufferedEvents ?? 500);
    this.onReauthRequired = options.onReauthRequired;

    if (options.initialItems && options.initialItems.length > 0) {
      this.seedInitialHistory(options.initialItems, options.initialLastAppliedSeq);
    } else if (
      typeof options.initialLastAppliedSeq === "number" &&
      Number.isSafeInteger(options.initialLastAppliedSeq) &&
      options.initialLastAppliedSeq >= 0
    ) {
      this.lastAppliedSeq = options.initialLastAppliedSeq;
    }
  }

  getSnapshot(): ConversationSyncSnapshot {
    return {
      accountId: this.accountId,
      conversationId: this.conversationId,
      phase: this.phase,
      lastAppliedSeq: this.lastAppliedSeq,
      bufferedCount: this.bufferedLiveEvents.size,
      items: this.getItems(),
      lastError: this.lastError,
      catchUpRuns: this.catchUpRuns,
      gapRecoveries: this.gapRecoveries,
    };
  }

  getItems(): ReceivedTimelineMessage[] {
    return mergeHistoryMessages([], [...this.itemsById.values()], this.conversationId);
  }

  getLastAppliedSeq(): number {
    return this.lastAppliedSeq;
  }

  subscribe(listener: SyncSnapshotListener): () => void {
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

  private isStale(
    capturedEpoch: number,
    capturedAccountId: string,
    capturedConversationId: string,
  ): boolean {
    return (
      this.disposed ||
      this.phase === "reauth_required" ||
      this.epoch !== capturedEpoch ||
      this.accountId !== capturedAccountId ||
      this.conversationId !== capturedConversationId
    );
  }

  /**
   * Pre-seed items loaded before reconnect catch-up (e.g. from `HistoryController`).
   */
  seedInitialHistory(items: readonly ReceivedTimelineMessage[], confirmedWatermark?: number): void {
    if (this.disposed || this.phase === "reauth_required") return;
    let highestSeedSeq = this.lastAppliedSeq;
    for (const item of items) {
      if (item.conversationId !== this.conversationId) continue;
      const existing = this.itemsById.get(item.messageId);
      if (existing && existing.kind === "decrypted" && item.kind !== "decrypted") {
        continue;
      }
      this.itemsById.set(item.messageId, item);
      if (item.seq > highestSeedSeq) {
        highestSeedSeq = item.seq;
      }
    }
    if (
      typeof confirmedWatermark === "number" &&
      Number.isSafeInteger(confirmedWatermark) &&
      confirmedWatermark > highestSeedSeq
    ) {
      highestSeedSeq = confirmedWatermark;
    }
    this.lastAppliedSeq = Math.max(this.lastAppliedSeq, highestSeedSeq);
    this.emit();
  }

  /**
   * Enter live-event buffering mode BEFORE emitting `conversation:subscribe`
   * so no event arriving between subscription and HTTP catch-up can be lost.
   */
  beginSubscribeBuffer(): void {
    if (this.disposed || this.phase === "reauth_required") return;
    this.buffering = true;
    this.lastError = null;
    if (!this.syncInFlight) {
      this.phase = "buffering";
      this.emit();
    }
  }

  private async decryptSingleItem(
    rawItem: HistoryMessageItem | MessageNewEvent,
    device: DecryptCapableDevice | null,
  ): Promise<ReceivedTimelineMessage> {
    const result = await decryptReceivedEnvelope(device, rawItem, {
      peerUserId: rawItem.senderUserId,
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

  private bufferEvent(event: MessageNewEvent): void {
    if (!this.bufferedLiveEvents.has(event.messageId)) {
      if (this.bufferedLiveEvents.size >= this.maxBufferedEvents) {
        // Bound in-memory buffer under reconnect burst; fall back to HTTP after-watermark sweep.
        this.bufferedLiveEvents.clear();
        this.bufferOverflowed = true;
      } else {
        this.bufferedLiveEvents.set(event.messageId, event);
      }
    }
    if (this.syncInFlight) {
      this.syncAgainRequested = true;
    }
  }

  private async applySingleSerialized(
    event: MessageNewEvent,
  ): Promise<LiveMessageAction | { action: "gap_catchup_needed" }> {
    if (this.disposed || this.phase === "reauth_required") {
      return { action: "ignored" };
    }
    if (event.conversationId !== this.conversationId) {
      return { action: "wrong_conversation" };
    }
    const preExisting = this.itemsById.get(event.messageId);
    if (preExisting && preExisting.kind === "decrypted") {
      return { action: "duplicate" };
    }
    if (this.buffering || this.syncInFlight !== null) {
      this.bufferEvent(event);
      this.emit();
      return { action: "buffered" };
    }
    if (event.seq > this.lastAppliedSeq + 1) {
      // Gap detected: buffer event without raising watermark and trigger catch-up outside liveApplyChain.
      this.bufferEvent(event);
      this.gapRecoveries += 1;
      this.emit();
      return { action: "gap_catchup_needed" };
    }

    const capturedEpoch = this.epoch;
    const capturedAccountId = this.accountId;
    const capturedConversationId = this.conversationId;
    const converted = await this.decryptSingleItem(event, this.device);
    if (this.isStale(capturedEpoch, capturedAccountId, capturedConversationId)) {
      return { action: "ignored" };
    }
    const postAwaitExisting = this.itemsById.get(converted.messageId);
    if (postAwaitExisting && postAwaitExisting.kind === "decrypted") {
      return { action: "duplicate" };
    }
    this.itemsById.set(converted.messageId, converted);
    if (converted.seq > this.lastAppliedSeq && converted.seq <= this.lastAppliedSeq + 1) {
      this.lastAppliedSeq = converted.seq;
    }
    if (!this.buffering && !this.syncInFlight && this.phase !== "error") {
      this.phase = "synced";
    }
    this.emit();
    return { action: "applied", item: converted };
  }

  /**
   * Handle an incoming live `message:new` event according to `DEC-021` §7.4.
   */
  async onLiveMessage(event: MessageNewEvent): Promise<LiveMessageAction> {
    if (this.disposed || this.phase === "reauth_required") {
      return { action: "ignored" };
    }
    if (event.conversationId !== this.conversationId) {
      return { action: "wrong_conversation" };
    }
    const existing = this.itemsById.get(event.messageId);
    if (existing && existing.kind === "decrypted") {
      return { action: "duplicate" };
    }
    if (this.buffering || this.syncInFlight !== null) {
      this.bufferEvent(event);
      this.emit();
      return { action: "buffered" };
    }

    const nextOperation = this.liveApplyChain.then(() => this.applySingleSerialized(event));
    this.liveApplyChain = nextOperation.then(
      () => undefined,
      () => undefined,
    );
    const actionResult = await nextOperation;

    if (actionResult.action === "gap_catchup_needed") {
      await this.runCatchUp();
      return { action: "gap_catchup_triggered" };
    }
    return actionResult;
  }

  /**
   * Execute paginated ascending `after` catch-up and drain buffered live events.
   */
  async runCatchUp(): Promise<CatchUpRunResult> {
    if (this.disposed) {
      return {
        ok: false,
        reauthRequired: false,
        stale: true,
        appliedCount: 0,
        lastAppliedSeq: this.lastAppliedSeq,
        error: this.lastError,
      };
    }
    if (this.phase === "reauth_required") {
      return {
        ok: false,
        reauthRequired: true,
        stale: false,
        appliedCount: 0,
        lastAppliedSeq: this.lastAppliedSeq,
        error: this.lastError,
      };
    }
    if (this.syncInFlight) {
      this.syncAgainRequested = true;
      return this.syncInFlight;
    }

    this.buffering = true;
    this.syncAgainRequested = false;
    this.phase = "syncing";
    this.lastError = null;
    this.emit();

    const runPromise = this.executeCatchUpLoop();
    this.syncInFlight = runPromise;
    try {
      return await runPromise;
    } finally {
      if (this.syncInFlight === runPromise) {
        this.syncInFlight = null;
      }
    }
  }

  private async applyPersistedItem(
    rawItem: HistoryMessageItem,
    capturedEpoch: number,
    capturedAccountId: string,
    capturedConversationId: string,
    capturedDevice: DecryptCapableDevice | null,
  ): Promise<{ fresh: boolean; appliedNew: boolean }> {
    if (this.isStale(capturedEpoch, capturedAccountId, capturedConversationId)) {
      return { fresh: false, appliedNew: false };
    }
    if (rawItem.conversationId !== capturedConversationId) {
      return { fresh: true, appliedNew: false };
    }

    const existing = this.itemsById.get(rawItem.messageId);
    if (existing && existing.kind === "decrypted") {
      this.lastAppliedSeq = Math.max(this.lastAppliedSeq, rawItem.seq);
      return { fresh: true, appliedNew: false };
    }

    const converted = await this.decryptSingleItem(rawItem, capturedDevice);
    if (this.isStale(capturedEpoch, capturedAccountId, capturedConversationId)) {
      return { fresh: false, appliedNew: false };
    }
    const postAwait = this.itemsById.get(converted.messageId);
    if (postAwait && postAwait.kind === "decrypted") {
      this.lastAppliedSeq = Math.max(this.lastAppliedSeq, postAwait.seq);
      return { fresh: true, appliedNew: false };
    }

    this.itemsById.set(converted.messageId, converted);
    this.lastAppliedSeq = Math.max(this.lastAppliedSeq, converted.seq);
    return { fresh: true, appliedNew: true };
  }

  private async executeCatchUpLoop(): Promise<CatchUpRunResult> {
    const capturedEpoch = this.epoch;
    const capturedAccountId = this.accountId;
    const capturedConversationId = this.conversationId;
    const capturedDevice = this.device;

    // Ensure any prior steady-state Olm decryption settles before catch-up reads watermark.
    await this.liveApplyChain.catch(() => undefined);
    if (this.isStale(capturedEpoch, capturedAccountId, capturedConversationId)) {
      this.buffering = false;
      return {
        ok: false,
        reauthRequired: this.phase === "reauth_required",
        stale: true,
        appliedCount: 0,
        lastAppliedSeq: this.lastAppliedSeq,
        error: this.lastError,
      };
    }

    let appliedCount = 0;

    try {
      for (let gapPass = 0; gapPass < this.maxGapRecoveryPasses; gapPass += 1) {
        this.syncAgainRequested = false;
        this.bufferOverflowed = false;

        let afterRef = String(this.lastAppliedSeq);
        let sawAnyPersistedItemInPass = false;

        for (let pageIdx = 0; pageIdx < this.maxCatchUpPages; pageIdx += 1) {
          const prevWatermark = this.lastAppliedSeq;
          const page = await this.historyClient.fetchPage({
            conversationId: capturedConversationId,
            after: afterRef,
            limit: this.pageLimit,
          });
          if (this.isStale(capturedEpoch, capturedAccountId, capturedConversationId)) {
            return {
              ok: false,
              reauthRequired: this.phase === "reauth_required",
              stale: true,
              appliedCount,
              lastAppliedSeq: this.lastAppliedSeq,
              error: this.lastError,
            };
          }

          for (const rawItem of page.items) {
            const outcome = await this.applyPersistedItem(
              rawItem,
              capturedEpoch,
              capturedAccountId,
              capturedConversationId,
              capturedDevice,
            );
            if (!outcome.fresh) {
              return {
                ok: false,
                reauthRequired: this.phase === "reauth_required",
                stale: true,
                appliedCount,
                lastAppliedSeq: this.lastAppliedSeq,
                error: this.lastError,
              };
            }
            if (outcome.appliedNew) {
              appliedCount += 1;
            }
            sawAnyPersistedItemInPass = true;
          }

          if (!page.hasMore) {
            break;
          }

          const lastSeqInPage =
            page.items.length > 0 ? page.items[page.items.length - 1]!.seq : prevWatermark;
          if (!page.nextCursor || lastSeqInPage <= prevWatermark) {
            throw new HistoryApiError(502, "INVALID_RESPONSE", false);
          }
          afterRef = page.nextCursor;
        }

        // Drain buffered live events strictly in ascending server seq order.
        const sortedBuffer = [...this.bufferedLiveEvents.values()].sort((a, b) => {
          if (a.seq !== b.seq) return a.seq - b.seq;
          return a.messageId.localeCompare(b.messageId);
        });

        let detectedBufferedGap = false;
        const confirmedEmptyAtWatermark = !sawAnyPersistedItemInPass;
        const isLastAllowedPass = gapPass >= this.maxGapRecoveryPasses - 1;

        for (const bufferedEvent of sortedBuffer) {
          if (this.isStale(capturedEpoch, capturedAccountId, capturedConversationId)) {
            return {
              ok: false,
              reauthRequired: this.phase === "reauth_required",
              stale: true,
              appliedCount,
              lastAppliedSeq: this.lastAppliedSeq,
              error: this.lastError,
            };
          }

          const existing = this.itemsById.get(bufferedEvent.messageId);
          if (existing && existing.kind === "decrypted") {
            this.bufferedLiveEvents.delete(bufferedEvent.messageId);
            this.lastAppliedSeq = Math.max(this.lastAppliedSeq, existing.seq);
            continue;
          }

          const isNextOrPast = bufferedEvent.seq <= this.lastAppliedSeq + 1;
          const confirmedPermanentGapDrain =
            confirmedEmptyAtWatermark && gapPass > 0 && isLastAllowedPass;

          if (!isNextOrPast && !confirmedPermanentGapDrain) {
            // Buffer reveals an unfetched earlier seq range; re-run catch-up from lastAppliedSeq.
            this.gapRecoveries += 1;
            detectedBufferedGap = true;
            break;
          }

          const outcome = await this.applyPersistedItem(
            bufferedEvent,
            capturedEpoch,
            capturedAccountId,
            capturedConversationId,
            capturedDevice,
          );
          if (!outcome.fresh) {
            return {
              ok: false,
              reauthRequired: this.phase === "reauth_required",
              stale: true,
              appliedCount,
              lastAppliedSeq: this.lastAppliedSeq,
              error: this.lastError,
            };
          }
          if (outcome.appliedNew) {
            appliedCount += 1;
          }
          this.bufferedLiveEvents.delete(bufferedEvent.messageId);
        }

        if (!detectedBufferedGap && !this.bufferOverflowed && !this.syncAgainRequested) {
          break;
        }
      }

      if (this.isStale(capturedEpoch, capturedAccountId, capturedConversationId)) {
        return {
          ok: false,
          reauthRequired: this.phase === "reauth_required",
          stale: true,
          appliedCount,
          lastAppliedSeq: this.lastAppliedSeq,
          error: this.lastError,
        };
      }

      this.buffering = false;
      this.syncAgainRequested = false;
      this.phase = "synced";
      this.lastError = null;
      this.catchUpRuns += 1;
      this.emit();

      return {
        ok: true,
        reauthRequired: false,
        stale: false,
        appliedCount,
        lastAppliedSeq: this.lastAppliedSeq,
        error: null,
      };
    } catch (error) {
      if (this.isStale(capturedEpoch, capturedAccountId, capturedConversationId)) {
        return {
          ok: false,
          reauthRequired: this.phase === "reauth_required",
          stale: true,
          appliedCount,
          lastAppliedSeq: this.lastAppliedSeq,
          error: this.lastError,
        };
      }

      if (
        error instanceof HistoryApiError &&
        (error.code === "UNAUTHENTICATED" || error.code === "SESSION_REVOKED")
      ) {
        this.enterReauthRequired(error.code);
        return {
          ok: false,
          reauthRequired: true,
          stale: false,
          appliedCount: 0,
          lastAppliedSeq: 0,
          error: this.lastError,
        };
      }

      const mapped = mapSyncFailure(error);
      this.buffering = false;
      this.syncAgainRequested = false;

      if (
        error instanceof HistoryApiError &&
        (error.code === "FORBIDDEN" || error.code === "NOT_FOUND" || error.code === "BLOCKED")
      ) {
        this.itemsById.clear();
        this.bufferedLiveEvents.clear();
      }

      this.phase = "error";
      this.lastError = mapped;
      this.emit();

      return {
        ok: false,
        reauthRequired: false,
        stale: false,
        appliedCount,
        lastAppliedSeq: this.lastAppliedSeq,
        error: mapped,
      };
    }
  }

  /**
   * Transition to explicit reauthentication-required (`FR-AUTH-007`), discarding
   * buffered/protected in-memory timeline state and invalidating pending async work.
   */
  enterReauthRequired(code: "UNAUTHENTICATED" | "SESSION_REVOKED" = "SESSION_REVOKED"): void {
    if (this.disposed) return;
    this.epoch += 1;
    this.buffering = false;
    this.syncAgainRequested = false;
    this.bufferedLiveEvents.clear();
    this.itemsById.clear();
    this.lastAppliedSeq = 0;
    this.phase = "reauth_required";
    this.lastError = {
      code,
      retryable: false,
      requestId: null,
      retryAfterSeconds: null,
      copy: errorCopyFor(code),
    };
    this.emit();
    this.onReauthRequired?.(code);
  }

  /**
   * Clear `reauth_required` after the user completes fresh sign-in.
   */
  resetAfterReauthentication(): void {
    if (this.disposed) return;
    this.epoch += 1;
    this.buffering = false;
    this.syncAgainRequested = false;
    this.bufferedLiveEvents.clear();
    this.itemsById.clear();
    this.lastAppliedSeq = 0;
    this.lastError = null;
    this.phase = "idle";
    this.emit();
  }

  setDevice(device: DecryptCapableDevice | null): void {
    this.device = device;
  }

  switchConversation(
    conversationId: string,
    peerKeys?: { expectedPeerIdentityKey?: string; expectedPeerSenderKey?: string },
  ): void {
    if (this.disposed) return;
    this.epoch += 1;
    this.conversationId = conversationId;
    this.expectedPeerIdentityKey = peerKeys?.expectedPeerIdentityKey;
    this.expectedPeerSenderKey = peerKeys?.expectedPeerSenderKey;
    this.buffering = false;
    this.syncAgainRequested = false;
    this.bufferedLiveEvents.clear();
    this.itemsById.clear();
    this.lastAppliedSeq = 0;
    this.lastError = null;
    this.phase = this.phase === "reauth_required" ? "reauth_required" : "idle";
    this.emit();
  }

  switchAccount(accountId: string, device: DecryptCapableDevice | null): void {
    if (this.disposed) return;
    this.epoch += 1;
    this.accountId = accountId;
    this.device = device;
    this.buffering = false;
    this.syncAgainRequested = false;
    this.bufferedLiveEvents.clear();
    this.itemsById.clear();
    this.lastAppliedSeq = 0;
    this.lastError = null;
    this.phase = "idle";
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    this.epoch += 1;
    this.buffering = false;
    this.bufferedLiveEvents.clear();
    this.itemsById.clear();
    this.listeners.clear();
  }
}
