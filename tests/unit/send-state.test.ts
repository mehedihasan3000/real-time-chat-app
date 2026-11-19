import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  type MessageSendInput,
  type MessageSendResponse,
} from "@chat/contracts";
import {
  MessageSendApiError,
  type PreparedEncryptedSend,
} from "../../apps/web/src/features/chat/send.js";
import {
  buildSendStateBanners,
  toSendStateItemViewModel,
} from "../../apps/web/src/features/chat/send-state.js";
import { translate } from "../../apps/web/src/i18n/core.js";
import {
  InMemoryOutboxStorageAdapter,
  OUTBOX_BACKOFF_SCHEDULE_MS,
  OUTBOX_MAX_AUTO_ATTEMPTS,
  OUTBOX_MAX_RETRY_WINDOW_MS,
  SendOutboxCoordinator,
  assertValidOutboxRecord,
  computeBackoffDelayMs,
  createQueuedOutboxEntry,
  markAttemptOutcomeFailure,
  markAttemptStarted,
  markAttemptSucceeded,
  markManualRetry,
  reconcileOutboxAfterReload,
  type OutboxRecord,
  type PreparedMessageSender,
} from "../../apps/web/src/lib/outbox/index.js";

function makeValidEnvelope(seed = "1", senderDeviceId = "dev-alice-01"): string {
  const payload = {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    senderDeviceId,
    recipientDeviceId: "dev-bob-01",
    senderIdentityKey: "a".repeat(43),
    senderCurve25519Key: "b".repeat(43),
    sessionId: "session-unit-01",
    messageIndex: 0,
    messageType: 0,
    ciphertext: Buffer.from(`unit-ciphertext-sample-${seed}-0123456789abcdef`, "utf8").toString(
      "base64url",
    ),
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function makePrepared(
  conversationId = "conv_a",
  clientMessageId = randomUUID(),
  seed = "1",
): PreparedEncryptedSend {
  const request: MessageSendInput = {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    clientMessageId,
    senderDeviceId: "dev-alice-01",
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    encryptedEnvelope: makeValidEnvelope(seed),
  };
  return { conversationId, payload: request };
}

function makeAck(prepared: PreparedEncryptedSend, seq = 1): MessageSendResponse {
  return {
    idempotent: false,
    message: {
      messageId: `msg_${seq}`,
      conversationId: prepared.conversationId,
      seq,
      senderUserId: "user-a",
      senderDeviceId: prepared.payload.senderDeviceId,
      clientMessageId: prepared.payload.clientMessageId,
      protocolVersion: prepared.payload.protocolVersion,
      committedAt: "2026-02-01T12:00:01.000Z",
      schemaVersion: 1,
    },
  };
}

describe("P2-05 unit — outbox state machine, backoff, 10-attempt/24h cap & reload recovery", () => {
  it("computes bounded exponential backoff with ±20% jitter and honors Retry-After floor", () => {
    const mid = OUTBOX_BACKOFF_SCHEDULE_MS.map((_, i) =>
      computeBackoffDelayMs({ autoAttemptNumber: i + 1, randomValue: 0.5 }),
    );
    expect(mid).toEqual([...OUTBOX_BACKOFF_SCHEDULE_MS]);

    expect(computeBackoffDelayMs({ autoAttemptNumber: 2, randomValue: 0 })).toBe(4_000);
    expect(computeBackoffDelayMs({ autoAttemptNumber: 2, randomValue: 1 })).toBe(6_000);
    expect(
      computeBackoffDelayMs({ autoAttemptNumber: 1, retryAfterSeconds: 45, randomValue: 0.5 }),
    ).toBe(45_000);
  });

  it("stops automatic retries at 10 attempts or 24h elapsed and allows manual retry preserving exact logical ID", () => {
    const startMs = 1_000_000;
    const prepared = makePrepared();
    let entry = createQueuedOutboxEntry({
      accountId: "user-a",
      conversationId: prepared.conversationId,
      payload: prepared.payload,
      payloadHash: "hash-01",
      nowMs: startMs,
    });

    const netErr = new MessageSendApiError(0, "NETWORK_ERROR", true, "unknown");
    let clock = startMs;
    for (let i = 1; i <= OUTBOX_MAX_AUTO_ATTEMPTS; i += 1) {
      entry = markAttemptStarted(entry, clock);
      entry = markAttemptOutcomeFailure(entry, netErr, {
        nowMs: clock,
        online: true,
        randomValue: 0.5,
      });
      clock += 60_000;
    }

    expect(entry.status).toBe("failed");
    expect(entry.failureReason).toBe("attempts_exhausted");
    expect(entry.attemptCount).toBe(OUTBOX_MAX_AUTO_ATTEMPTS);
    expect(entry.nextAttemptAtMs).toBeNull();

    // 24-hour cap reached even with only 2 attempts
    let agedEntry = createQueuedOutboxEntry({
      accountId: "user-a",
      conversationId: prepared.conversationId,
      payload: prepared.payload,
      payloadHash: "hash-02",
      nowMs: startMs,
    });
    agedEntry = markAttemptStarted(agedEntry, startMs);
    agedEntry = markAttemptOutcomeFailure(agedEntry, netErr, {
      nowMs: startMs + OUTBOX_MAX_RETRY_WINDOW_MS + 1,
      online: true,
      randomValue: 0.5,
    });
    expect(agedEntry.status).toBe("failed");
    expect(agedEntry.failureReason).toBe("attempts_exhausted");

    // Manual retry preserves exact clientMessageId, senderDeviceId & encryptedEnvelope
    const retried = markManualRetry(entry, clock);
    expect(retried.status).toBe("queued");
    expect(retried.clientMessageId).toBe(prepared.payload.clientMessageId);
    expect(retried.payload.encryptedEnvelope).toBe(prepared.payload.encryptedEnvelope);
    expect(retried.attemptCount).toBe(OUTBOX_MAX_AUTO_ATTEMPTS);
    expect(retried.autoAttemptsUsed).toBe(0);

    // Non-retryable conflict must never permit manual retry
    let conflictEntry = createQueuedOutboxEntry({
      accountId: "user-a",
      conversationId: prepared.conversationId,
      payload: makePrepared().payload,
      payloadHash: "hash-03",
      nowMs: startMs,
    });
    conflictEntry = markAttemptStarted(conflictEntry, startMs);
    conflictEntry = markAttemptOutcomeFailure(
      conflictEntry,
      new MessageSendApiError(409, "IDEMPOTENCY_CONFLICT", false, "failed"),
      { nowMs: startMs },
    );
    expect(conflictEntry.status).toBe("failed");
    expect(conflictEntry.failureReason).toBe("conflict");
    expect(() => markManualRetry(conflictEntry, startMs + 1000)).toThrow(/not permitted/i);
  });

  it("rejects plaintext/secret fields and turns mid-flight sending into unknown on reload", () => {
    const prepared = makePrepared();
    const base = createQueuedOutboxEntry({
      accountId: "user-a",
      conversationId: prepared.conversationId,
      payload: prepared.payload,
      payloadHash: "hash-04",
      nowMs: 10_000,
    });

    expect(() =>
      assertValidOutboxRecord({ ...base, plaintext: "leak" } as unknown as OutboxRecord),
    ).toThrow(/Forbidden/);
    expect(() =>
      assertValidOutboxRecord({ ...base, privateKey: "secret" } as unknown as OutboxRecord),
    ).toThrow(/Forbidden/);

    const sending = markAttemptStarted(base, 10_100);
    const acked = markAttemptSucceeded(base, makeAck(prepared, 4), 10_200);
    expect(acked.status).toBe("sent");
    expect(acked.committedSeq).toBe(4);

    const reconciled = reconcileOutboxAfterReload([sending, acked], 15_000);
    expect(reconciled[0]!.status).toBe("unknown");
    expect(reconciled[0]!.clientMessageId).toBe(sending.clientMessageId);
    expect(reconciled[0]!.payload.encryptedEnvelope).toBe(sending.payload.encryptedEnvelope);
    expect(reconciled[0]!.nextAttemptAtMs).toBe(15_000);
    expect(reconciled[1]!.status).toBe("sent");
  });
});

describe("P2-05 unit — SendOutboxCoordinator disconnect, storage failures & ERR-003 stale safety", () => {
  it("queues offline without false sent indicator, surfaces storage failures, and discards on device revocation", async () => {
    const storage = new InMemoryOutboxStorageAdapter();
    let now = 50_000;
    const sendSpy = vi.fn(async (prep: PreparedEncryptedSend) => makeAck(prep, 1));
    const coordinator = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: "conv_ab",
      sender: { sendPrepared: sendSpy },
      storage,
      online: false,
      nowMs: () => now,
      random: () => 0.5,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });

    const prep1 = makePrepared("conv_ab");
    const offlineEntry = await coordinator.submitPrepared(prep1);
    expect(offlineEntry.status).toBe("queued");
    expect(sendSpy).not.toHaveBeenCalled();

    // Reconnect confirms via original logical ID
    now += 1000;
    await coordinator.setOnline(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot().entriesForActiveConversation[0]!.status).toBe("sent");

    // Simulate storage unavailability -> explicit notice, never crashes or claims persistence
    storage.setAvailable(false);
    await coordinator.setOnline(false);
    await coordinator.submitPrepared(makePrepared("conv_ab"));
    expect(coordinator.getSnapshot().storageAvailable).toBe(false);
    expect(coordinator.getSnapshot().storageNoticeCode).toBe("STORAGE_UNAVAILABLE");

    // Device revocation moves pending items to device_revoked
    storage.setAvailable(true);
    await coordinator.onDeviceRevoked();
    const pendingItems = coordinator
      .getSnapshot()
      .entriesForActiveConversation.filter((e) => e.status === "failed");
    expect(pendingItems).toHaveLength(1);
    expect(pendingItems[0]!.failureReason).toBe("device_revoked");

    // External eviction across reload detects cleared local storage
    const freshStorage = new InMemoryOutboxStorageAdapter();
    const coord2 = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: "conv_ab",
      sender: { sendPrepared: sendSpy },
      storage: freshStorage,
      online: false,
      nowMs: () => now,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });
    await coord2.submitPrepared(makePrepared("conv_ab"));
    expect(coord2.hasPendingEntries()).toBe(true);
    freshStorage.simulateExternalEviction("user-a");
    await coord2.reconcileAfterReload();
    expect(coord2.getSnapshot().storageNoticeCode).toBe("STORAGE_CLEARED");
    expect(coord2.getSnapshot().entriesForActiveConversation).toHaveLength(0);
  });

  it("drops late/canceled completions on account switch or discard cleanly (ERR-003)", async () => {
    const createDeferredSender = () => {
      let resolveReq!: (res: MessageSendResponse) => void;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const sender: PreparedMessageSender = {
        sendPrepared: () => {
          markStarted();
          return new Promise<MessageSendResponse>((resolve) => {
            resolveReq = resolve;
          });
        },
      };
      return { sender, started, resolve: (res: MessageSendResponse) => resolveReq(res) };
    };

    const delayed = createDeferredSender();
    const delayedPrep = makePrepared("conv_ab");
    const coordinator = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: "conv_ab",
      sender: delayed.sender,
      online: true,
      nowMs: () => 10_000,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });

    const inFlight = coordinator.submitPrepared(delayedPrep);
    await delayed.started;
    // Account switches before delayed HTTP ack arrives
    await coordinator.switchAccount("user-b", "conv_bc");
    delayed.resolve(makeAck(delayedPrep, 1));
    await inFlight;

    expect(coordinator.getSnapshot().accountId).toBe("user-b");
    expect(coordinator.getSnapshot().allEntries).toHaveLength(0);

    // Conversation isolation: item submitted to conv_1 is not shown while viewing conv_2
    const convDeferred = createDeferredSender();
    const coordConv = new SendOutboxCoordinator({
      accountId: "user-a",
      activeConversationId: "conv_1",
      sender: convDeferred.sender,
      online: true,
      nowMs: () => 20_000,
      scheduleTimer: () => 0,
      cancelTimer: () => {},
    });
    const prepConv1 = makePrepared("conv_1");
    const p1 = coordConv.submitPrepared(prepConv1);
    await convDeferred.started;
    coordConv.setActiveConversation("conv_2");
    convDeferred.resolve(makeAck(prepConv1, 7));
    await p1;

    expect(coordConv.getSnapshot().entriesForActiveConversation).toHaveLength(0);
    coordConv.setActiveConversation("conv_1");
    expect(coordConv.getSnapshot().entriesForActiveConversation).toHaveLength(1);
    expect(coordConv.getSnapshot().entriesForActiveConversation[0]!.committedSeq).toBe(7);
  });
});

describe("P2-05 unit — localized EN/BN view models (FR-CHAT-007, ERR-002)", () => {
  it("maps every outbox status & error reason to reviewed EN/BN copy without block disclosure or raw errors", () => {
    const prepared = makePrepared("conv_ab");
    const base = createQueuedOutboxEntry({
      accountId: "user-a",
      conversationId: prepared.conversationId,
      payload: prepared.payload,
      payloadHash: "hash-ui",
      nowMs: 1_000,
    });

    const unknownOnline = markAttemptOutcomeFailure(
      markAttemptStarted(base, 1_000),
      new MessageSendApiError(503, "TEMPORARILY_UNAVAILABLE", true, "unknown"),
      { nowMs: 1_000, online: true, randomValue: 0.5 },
    );
    const queuedRetry = markAttemptOutcomeFailure(
      markAttemptStarted(base, 1_000),
      new MessageSendApiError(429, "RATE_LIMITED", true, "retryable_rejected", null, 12),
      { nowMs: 1_000, online: true, randomValue: 0.5 },
    );
    const unavailableBlocked = markAttemptOutcomeFailure(
      markAttemptStarted(base, 1_000),
      new MessageSendApiError(403, "UNAVAILABLE", false, "failed"),
      { nowMs: 1_000, online: true },
    );

    for (const locale of ["en", "bn"] as const) {
      const vmUnknown = toSendStateItemViewModel(unknownOnline, {
        online: true,
        locale,
        nowMs: 1_000,
      });
      expect(vmUnknown.isIndeterminate).toBe(true);
      expect(translate(locale, vmUnknown.statusLabelKey).length).toBeGreaterThan(0);

      const vmRetry = toSendStateItemViewModel(queuedRetry, {
        online: true,
        locale,
        nowMs: 1_000,
      });
      const retryDesc = translate(locale, vmRetry.descriptionKey, vmRetry.descriptionParams);
      expect(retryDesc).not.toContain("{delay}");
      expect(retryDesc).not.toContain("{attempt}");

      const vmUnavail = toSendStateItemViewModel(unavailableBlocked, {
        online: true,
        locale,
        nowMs: 1_000,
      });
      const unavailText = `${translate(locale, vmUnavail.titleKey)} ${translate(locale, vmUnavail.descriptionKey)}`;
      expect(unavailText.toLowerCase()).not.toContain("block");
    }

    const banners = buildSendStateBanners({
      accountId: "user-a",
      activeConversationId: "conv_ab",
      online: false,
      storageAvailable: false,
      storageNoticeCode: "STORAGE_UNAVAILABLE",
      entriesForActiveConversation: [],
      allEntries: [],
    });
    expect(banners).toHaveLength(2);
    expect(translate("en", banners[0]!.titleKey)).toBe("Connection interrupted");
    expect(translate("bn", banners[1]!.descriptionKey)).toContain("রিলোড");
  });
});
