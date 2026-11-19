import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  RECONNECT_BACKOFF_SCHEDULE_MS,
  RECONNECT_JITTER_RATIO,
  SOCKET_SUBSCRIBE_EVENT,
  SOCKET_UNSUBSCRIBE_EVENT,
  decodeHistoryAfterReference,
  validateConversationSubscribePayload,
  type HistoryMessageItem,
  type HistoryPageResponse,
} from "@chat/contracts";
import { OlmAccountDevice } from "@chat/crypto";

import {
  HistoryApiError,
  type HistoryFetchPageInput,
  type HistoryPageFetcher,
} from "../../apps/web/src/features/chat/history.js";
import {
  ConversationCatchUpSynchronizer,
  RealtimeClient,
  computeReconnectDelayMs,
  type RealtimeSocketTransport,
} from "../../apps/web/src/lib/realtime/index.js";

const disposables: Array<{ dispose(): void }> = [];

async function makeDevice(deviceId: string): Promise<OlmAccountDevice> {
  const device = await OlmAccountDevice.create({ deviceId });
  disposables.push(device);
  return device;
}

function makeWireMessage(
  seq: number,
  conversationId: string,
  senderUserId: string,
  senderDeviceId: string,
  encryptedEnvelope: string,
): HistoryMessageItem {
  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    messageId: `msg_${conversationId}_${seq}`,
    conversationId,
    seq,
    senderUserId,
    senderDeviceId,
    clientMessageId: randomUUID(),
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    encryptedEnvelope,
    committedAt: new Date(Date.UTC(2026, 10, 19, 14, 0, seq)).toISOString(),
  };
}

class MemoryTransportDouble implements RealtimeSocketTransport {
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  connected = false;
  subscribeAckHandler?: (payload: unknown, ack?: (body: unknown) => void) => void;
  refreshAckHandler?: (payload: unknown, ack?: (body: unknown) => void) => void;
  connectBehavior?: () => void;

  on(event: string, listener: (...args: unknown[]) => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, payload: unknown, ack?: (body: unknown) => void): void {
    this.emitted.push({ event, payload });
    if (event === SOCKET_SUBSCRIBE_EVENT && this.subscribeAckHandler) {
      this.subscribeAckHandler(payload, ack);
      return;
    }
    if (event === SOCKET_SUBSCRIBE_EVENT) {
      const convId = (payload as { conversationId?: string })?.conversationId ?? "conv_unit";
      ack?.({ ok: true, data: { conversationId: convId, subscribed: true } });
      return;
    }
    if (event === "auth:refresh" && this.refreshAckHandler) {
      this.refreshAckHandler(payload, ack);
      return;
    }
    if (event === "auth:refresh" || event === SOCKET_UNSUBSCRIBE_EVENT) {
      ack?.({ ok: true, data: { ok: true } });
    }
  }

  trigger(event: string, ...args: unknown[]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      handler(...args);
    }
  }

  connect(): void {
    if (this.connectBehavior) {
      this.connectBehavior();
      return;
    }
    queueMicrotask(() => {
      this.connected = true;
      this.trigger("connect");
    });
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.trigger("disconnect", "io client disconnect");
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

afterEach(() => {
  while (disposables.length > 0) {
    disposables.pop()?.dispose();
  }
});

describe("P2-08 — reconnect backoff bounds & subscribe contract validation (NFR-REL-003, INT-001)", () => {
  it("computes 1/2/4/8/16/30s bounded backoff with symmetric ±20% jitter", () => {
    expect(RECONNECT_BACKOFF_SCHEDULE_MS).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(RECONNECT_JITTER_RATIO).toBe(0.2);

    const expectedBases = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
    expectedBases.forEach((base, attempt) => {
      expect(computeReconnectDelayMs(attempt, { random: () => 0.5 })).toBe(base);
      expect(computeReconnectDelayMs(attempt, { random: () => 0 })).toBe(Math.round(base * 0.8));
      expect(computeReconnectDelayMs(attempt, { random: () => 1 })).toBe(Math.round(base * 1.2));
    });
  });

  it("validates conversation:subscribe payloads strictly and rejects bad schemaVersion, negative seq, or operator keys", () => {
    expect(
      validateConversationSubscribePayload({
        schemaVersion: 1,
        conversationId: "conv_123",
        data: { conversationId: "conv_123", lastAppliedSeq: 4 },
      }),
    ).toEqual({
      ok: true,
      value: {
        schemaVersion: 1,
        conversationId: "conv_123",
        lastAppliedSeq: 4,
      },
    });

    expect(
      validateConversationSubscribePayload({
        schemaVersion: 2,
        conversationId: "conv_123",
        data: {},
      }),
    ).toMatchObject({ ok: false, code: "UNSUPPORTED_SCHEMA_VERSION" });

    expect(
      validateConversationSubscribePayload({
        schemaVersion: 1,
        conversationId: "conv_123",
        data: { lastAppliedSeq: -1 },
      }),
    ).toMatchObject({ ok: false, code: "INVALID_REQUEST" });

    expect(
      validateConversationSubscribePayload({
        schemaVersion: 1,
        conversationId: "conv_a",
        data: { conversationId: "conv_b" },
      }),
    ).toMatchObject({ ok: false, code: "INVALID_REQUEST" });

    expect(
      validateConversationSubscribePayload({
        schemaVersion: 1,
        conversationId: "conv_a",
        data: { $gt: "" },
      }),
    ).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });
});

describe("P2-08 — DEC-021 §7.3–§7.4 subscribe-buffer-catch-up-dedupe state machine", () => {
  it("buffers live events between subscribe and catch-up, paginates after=lastAppliedSeq, and deduplicates without double Olm decrypt", async () => {
    const alice = await makeDevice("dev_unit_alice_01");
    const bob = await makeDevice("dev_unit_bob_02");
    const preKey = bob.toPublicKeyBundle().oneTimeKeys[0]!.key;

    const encrypt = async (seq: number, text: string) => {
      const res = await alice.encryptForPeer(
        {
          peerUserId: "usr_bob",
          peerDeviceId: bob.deviceId,
          peerIdentityKey: bob.identityKey,
          peerSenderKey: bob.senderKey,
          peerOneTimeOrFallbackKey: preKey,
        },
        text,
      );
      if (!res.ok) throw new Error(res.code);
      return makeWireMessage(
        seq,
        "conv_race",
        "usr_alice",
        alice.deviceId,
        res.value.encryptedEnvelope,
      );
    };

    const m1 = await encrypt(1, "Msg 1 initial");
    const m2 = await encrypt(2, "Msg 2 missed offline");
    const m3 = await encrypt(3, "Msg 3 missed offline");
    const m4 = await encrypt(4, "Msg 4 arrived during subscribe/catch-up race");
    const m5 = await encrypt(5, "Msg 5 live during pagination page 1->2");

    let releasePage1!: () => void;
    const page1Gate = new Promise<void>((resolve) => {
      releasePage1 = resolve;
    });
    const fetchCalls: string[] = [];

    const fetcher: HistoryPageFetcher = {
      async fetchPage(input: HistoryFetchPageInput): Promise<HistoryPageResponse> {
        fetchCalls.push(String(input.after ?? ""));
        const decoded = decodeHistoryAfterReference(input.after, input.conversationId);
        const afterSeq = decoded.ok && decoded.value ? decoded.value.seq : 0;
        if (afterSeq === 1) {
          await page1Gate;
          return {
            items: [m2, m3],
            nextCursor: Buffer.from(
              JSON.stringify({ v: 1, conversationId: input.conversationId, seq: 3 }),
            ).toString("base64url"),
            hasMore: true,
            latestSeq: 5,
          };
        }
        return {
          // Intentionally overlap m4 (already buffered) and omit m5 (only delivered live mid-page)
          items: [m4],
          nextCursor: null,
          hasMore: false,
          latestSeq: 5,
        };
      },
    };

    const synchronizer = new ConversationCatchUpSynchronizer({
      accountId: "usr_bob",
      conversationId: "conv_race",
      device: bob,
      historyClient: fetcher,
      pageLimit: 2,
    });
    disposables.push(synchronizer);

    // Steady-state message 1 applied first
    const r1 = await synchronizer.onLiveMessage(m1);
    expect(r1.action).toBe("applied");
    expect(synchronizer.getLastAppliedSeq()).toBe(1);

    // Reconnect starts: buffer enabled BEFORE subscribe
    synchronizer.beginSubscribeBuffer();
    const catchUpPromise = synchronizer.runCatchUp();

    // Live m4 arrives AFTER subscribe and BEFORE page 1 returns!
    const r4 = await synchronizer.onLiveMessage(m4);
    expect(r4.action).toBe("buffered");
    // Watermark must NEVER jump to max seen (4) while m2/m3 are still unfetched!
    expect(synchronizer.getLastAppliedSeq()).toBe(1);

    // Live m5 also arrives while paginated catch-up is mid-flight, plus duplicate m4
    const r5 = await synchronizer.onLiveMessage(m5);
    const r4Dup = await synchronizer.onLiveMessage(m4);
    expect(r5.action).toBe("buffered");
    expect(r4Dup.action).toBe("buffered");

    releasePage1();
    const syncResult = await catchUpPromise;
    expect(syncResult.ok).toBe(true);
    expect(fetchCalls[0]).toBe("1");

    const items = synchronizer.getItems();
    expect(items.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(items.every((item) => item.kind === "decrypted")).toBe(true);
    expect(synchronizer.getLastAppliedSeq()).toBe(5);
    expect(synchronizer.getSnapshot().bufferedCount).toBe(0);

    // Replay of already-decrypted m2 never re-calls Olm decrypt or fails as REPLAYED_MESSAGE
    const replay = await synchronizer.onLiveMessage(m2);
    expect(replay.action).toBe("duplicate");
    expect(synchronizer.getItems().map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("holds watermark on live gap (event.seq > lastAppliedSeq + 1), triggers catch-up, and converges across permanent seq gaps", async () => {
    const alice = await makeDevice("dev_gap_alice");
    const bob = await makeDevice("dev_gap_bob");
    const preKey = bob.toPublicKeyBundle().oneTimeKeys[0]!.key;

    const encrypt = async (seq: number, text: string) => {
      const res = await alice.encryptForPeer(
        {
          peerUserId: "usr_bob",
          peerDeviceId: bob.deviceId,
          peerIdentityKey: bob.identityKey,
          peerSenderKey: bob.senderKey,
          peerOneTimeOrFallbackKey: preKey,
        },
        text,
      );
      if (!res.ok) throw new Error(res.code);
      return makeWireMessage(
        seq,
        "conv_gap",
        "usr_alice",
        alice.deviceId,
        res.value.encryptedEnvelope,
      );
    };

    const m1 = await encrypt(1, "Seq 1");
    const m2 = await encrypt(2, "Seq 2 (live delivery dropped)");
    // seq 3 is a permanent write-abort gap (never stored)
    const m4 = await encrypt(4, "Seq 4 arrived out-of-order");

    const persisted = [m1, m2, m4];
    const observedAfterQueries: string[] = [];

    const fetcher: HistoryPageFetcher = {
      async fetchPage(input) {
        observedAfterQueries.push(String(input.after ?? ""));
        const decoded = decodeHistoryAfterReference(input.after, input.conversationId);
        const afterSeq = decoded.ok && decoded.value ? decoded.value.seq : 0;
        return {
          items: persisted.filter((m) => m.seq > afterSeq),
          nextCursor: null,
          hasMore: false,
          latestSeq: 4,
        };
      },
    };

    const synchronizer = new ConversationCatchUpSynchronizer({
      accountId: "usr_bob",
      conversationId: "conv_gap",
      device: bob,
      historyClient: fetcher,
    });
    disposables.push(synchronizer);

    await synchronizer.onLiveMessage(m1);
    expect(synchronizer.getLastAppliedSeq()).toBe(1);

    // Incoming m4 reveals gap (4 > 1 + 1); watermark stays 1 until catch-up finishes
    const outcome = await synchronizer.onLiveMessage(m4);
    expect(outcome.action).toBe("gap_catchup_triggered");
    expect(observedAfterQueries).toEqual(["1"]);
    expect(synchronizer.getItems().map((item) => item.seq)).toEqual([1, 2, 4]);
    expect(synchronizer.getSnapshot().gapRecoveries).toBe(1);
    expect(synchronizer.getLastAppliedSeq()).toBe(4);
  });

  it("discards stale catch-up completions on conversation or account switch (ERR-003)", async () => {
    const alice = await makeDevice("dev_err3_alice");
    const bob = await makeDevice("dev_err3_bob");
    const preKey = bob.toPublicKeyBundle().oneTimeKeys[0]!.key;
    const enc = await alice.encryptForPeer(
      {
        peerUserId: "usr_bob",
        peerDeviceId: bob.deviceId,
        peerIdentityKey: bob.identityKey,
        peerSenderKey: bob.senderKey,
        peerOneTimeOrFallbackKey: preKey,
      },
      "Stale conv A secret",
    );
    if (!enc.ok) throw new Error(enc.code);
    const convAItem = makeWireMessage(
      1,
      "conv_a",
      "usr_alice",
      alice.deviceId,
      enc.value.encryptedEnvelope,
    );

    let resolveConvA!: () => void;
    const convAGate = new Promise<void>((resolve) => {
      resolveConvA = resolve;
    });

    const fetcher: HistoryPageFetcher = {
      async fetchPage(input) {
        if (input.conversationId === "conv_a") {
          await convAGate;
          return { items: [convAItem], nextCursor: null, hasMore: false, latestSeq: 1 };
        }
        return { items: [], nextCursor: null, hasMore: false, latestSeq: 0 };
      },
    };

    const synchronizer = new ConversationCatchUpSynchronizer({
      accountId: "usr_bob",
      conversationId: "conv_a",
      device: bob,
      historyClient: fetcher,
    });
    disposables.push(synchronizer);

    const convASync = synchronizer.runCatchUp();
    // Switch conversation before slow HTTP response for conv_a returns
    synchronizer.switchConversation("conv_b");
    resolveConvA();

    const staleOutcome = await convASync;
    expect(staleOutcome.stale).toBe(true);
    expect(synchronizer.getSnapshot().conversationId).toBe("conv_b");
    expect(synchronizer.getItems()).toHaveLength(0);
  });
});

describe("P2-08 — RealtimeClient expired/revoked session & protected-action gating (FR-AUTH-007)", () => {
  it("transitions to reauth_required on session:expired, failed auth:refresh, or HTTP 401 and stops reconnect loops and protected actions", async () => {
    const bob = await makeDevice("dev_reauth_bob");
    const transports: MemoryTransportDouble[] = [];
    let tokenCalls = 0;

    const fetcher: HistoryPageFetcher = {
      async fetchPage() {
        return { items: [], nextCursor: null, hasMore: false, latestSeq: 0 };
      },
    };

    const client = new RealtimeClient({
      apiOrigin: "https://api.example.test",
      accountId: "usr_bob",
      conversationId: "conv_reauth",
      device: bob,
      tokenProvider: () => {
        tokenCalls += 1;
        return `tok_${tokenCalls}`;
      },
      historyClient: fetcher,
      backoffOptions: { scheduleMs: [25], jitterRatio: 0 },
      socketFactory: () => {
        const transport = new MemoryTransportDouble();
        transports.push(transport);
        return transport;
      },
    });
    disposables.push(client);

    const initial = await client.connect();
    expect(initial.connectionStatus).toBe("connected");
    expect(transports).toHaveLength(1);

    // Server emits session:expired
    transports[0]!.trigger("session:expired", { ok: false, error: { code: "SESSION_REVOKED" } });
    const afterExpiry = client.getSnapshot();
    expect(afterExpiry.connectionStatus).toBe("reauth_required");
    expect(afterExpiry.protectedActionsBlocked).toBe(true);
    expect(afterExpiry.reauthReason).toBe("SESSION_REVOKED");

    // Verify no reconnect storm or protected calls execute after session expiry
    await new Promise((r) => setTimeout(r, 80));
    expect(transports).toHaveLength(1);
    expect(await client.triggerCatchUp()).toBeNull();
    expect(await client.refreshAuthNow()).toBe(false);
    expect(await client.switchConversation("conv_other")).toBe(false);
    expect((await client.connect()).connectionStatus).toBe("reauth_required");
    expect(transports).toHaveLength(1);

    // Explicit reauthentication restores capability cleanly
    client.reauthenticate(() => "tok_fresh_after_login");
    expect(client.getSnapshot().connectionStatus).toBe("disconnected");
    const reconnected = await client.connect();
    expect(reconnected.connectionStatus).toBe("connected");
    expect(transports).toHaveLength(2);

    // HTTP 401 SESSION_REVOKED during manual catch-up also transitions to reauth_required
    const fetcher401: HistoryPageFetcher = {
      async fetchPage() {
        throw new HistoryApiError(401, "SESSION_REVOKED", false);
      },
    };
    const client401 = new RealtimeClient({
      apiOrigin: "https://api.example.test",
      accountId: "usr_bob",
      conversationId: "conv_reauth",
      device: bob,
      tokenProvider: () => "tok_401",
      historyClient: fetcher401,
      socketFactory: () => new MemoryTransportDouble(),
    });
    disposables.push(client401);

    const snap401 = await client401.connect();
    expect(snap401.connectionStatus).toBe("reauth_required");
    expect(snap401.protectedActionsBlocked).toBe(true);
  });
});
