import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import {
  MESSAGE_ALLOWED_PROTOCOL_VERSION,
  MESSAGE_SCHEMA_VERSION,
  PUBLIC_FIELDS,
  hasOnlyFields,
  successEnvelope,
  validateMessageNewEvent,
  type MessageNewEvent,
} from "@chat/contracts";
import {
  OlmAccountDevice,
  base64UrlDecode,
  base64UrlEncode,
  decryptReceivedEnvelope,
  extractEnvelopeRecipientDeviceId,
  type DecryptCapableDevice,
  type OlmFailureState,
} from "@chat/crypto";

import {
  ReceiveMessageTimeline,
  parseMessageNewEventEnvelope,
  toReceivedMessageViewModel,
  type FailedTimelineMessage,
} from "../../apps/web/src/features/chat/receive.js";
import type { MessageKey } from "../../apps/web/src/i18n/catalog.js";
import { translate, type MessageParams } from "../../apps/web/src/i18n/core.js";

const disposables: OlmAccountDevice[] = [];

async function makeDevice(deviceId: string): Promise<OlmAccountDevice> {
  const device = await OlmAccountDevice.create({ deviceId });
  disposables.push(device);
  return device;
}

function makeEvent(overrides: Partial<MessageNewEvent> = {}): MessageNewEvent {
  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    messageId: "msg_unit_0001",
    conversationId: "conv_unit_0001",
    seq: 1,
    senderUserId: "usr_alice_01",
    senderDeviceId: "dev_alice_01",
    clientMessageId: randomUUID(),
    protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
    encryptedEnvelope: base64UrlEncode(new TextEncoder().encode('{"placeholder":true}')),
    committedAt: "2026-11-19T10:00:00.000Z",
    ...overrides,
  };
}

function mutateCiphertextByte(encodedEnvelope: string): string {
  const decoded = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(base64UrlDecode(encodedEnvelope)),
  ) as Record<string, unknown>;
  const ct = new Uint8Array(base64UrlDecode(String(decoded.ciphertext)));
  ct[ct.length - 1] = (ct[ct.length - 1] ?? 0) ^ 0xff;
  decoded.ciphertext = base64UrlEncode(ct);
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(decoded)));
}

afterEach(() => {
  while (disposables.length > 0) {
    disposables.pop()?.dispose();
  }
});

describe("P2-06 — message:new wire contract & envelope validation", () => {
  it("validates allowlisted MessageNewEvent and rejects forbidden plaintext/extra fields", () => {
    const valid = makeEvent();
    expect(hasOnlyFields(valid, PUBLIC_FIELDS.messageNew)).toBe(true);
    const res = validateMessageNewEvent(valid);
    expect(res.ok).toBe(true);

    const parsedSocket = parseMessageNewEventEnvelope(successEnvelope(valid));
    expect(parsedSocket.ok).toBe(true);

    // Forbidden plaintext or privateKey fields rejected before reaching UI
    const withPlaintext = validateMessageNewEvent({ ...valid, plaintext: "leak" });
    expect(withPlaintext.ok).toBe(false);
    const withPayloadHash = validateMessageNewEvent({ ...valid, payloadHash: "abc" });
    expect(withPayloadHash.ok).toBe(false);

    // Unrecognized protocolVersion is retained for explicit unsupported-version placeholder
    const unknownProto = validateMessageNewEvent({ ...valid, protocolVersion: "olm-v0" });
    expect(unknownProto.ok).toBe(true);

    // Bad socket wrapper fails closed
    expect(parseMessageNewEventEnvelope({ ok: false, requestId: randomUUID() }).ok).toBe(false);
    expect(
      parseMessageNewEventEnvelope({ ok: true, requestId: "not-a-uuid", data: valid }).ok,
    ).toBe(false);
  });
});

describe("P2-06 — packages/crypto/src/envelope decryptReceivedEnvelope (TC-CHAT-008, FR-CHAT-014, NFR-REC-002)", () => {
  it("preserves exact Bengali, English, emoji ZWJ, mixed-script, and script-like plaintext without normalization or mutation", async () => {
    const alice = await makeDevice("dev_alice_unicode");
    const bob = await makeDevice("dev_bob_unicode");
    const bobBundle = bob.toPublicKeyBundle();

    const samples = [
      // Bengali conjuncts, combining marks, ZWNJ/ZWJ, mixed English, emoji ZWJ sequence
      "আমি বাংলায় কথা বলি — ক্ষ, জ্ঞ, য়, র‍্যাপিড, NFD-e\u0301 vs NFC-\u00e9 🇧🇩👨‍👩‍👧‍👦💬🔐",
      // Hostile script/HTML/URL payloads must survive verbatim as inert text (no lossy stripping)
      `<script>alert("xss")</script><img src=x onerror="evil()" /><svg onload=alert(1)>javascript:alert(2)`,
      // Exact empty-line and whitespace preservation
      "Line 1\n\tIndented line 2\n  Trailing spaces  ",
    ];

    for (let i = 0; i < samples.length; i += 1) {
      const text = samples[i]!;
      const encrypted = await alice.encryptForPeer(
        {
          peerUserId: "usr_bob_01",
          peerDeviceId: bob.deviceId,
          peerIdentityKey: bob.identityKey,
          peerSenderKey: bob.senderKey,
          peerOneTimeOrFallbackKey: bobBundle.oneTimeKeys[0]!.key,
        },
        text,
      );
      expect(encrypted.ok).toBe(true);
      if (!encrypted.ok) continue;

      expect(extractEnvelopeRecipientDeviceId(encrypted.value.encryptedEnvelope)).toBe(
        bob.deviceId,
      );
      expect(encrypted.value.encryptedEnvelope).not.toContain("বাংলা");
      expect(encrypted.value.encryptedEnvelope).not.toContain("<script>");

      const event = makeEvent({
        messageId: `msg_unicode_${i + 1}`,
        seq: i + 1,
        senderDeviceId: alice.deviceId,
        encryptedEnvelope: encrypted.value.encryptedEnvelope,
      });

      const decrypted = await decryptReceivedEnvelope(bob, event);
      expect(decrypted.ok).toBe(true);
      if (!decrypted.ok) continue;
      // Strict code-unit-for-code-unit equality (zero Unicode normalization side effect)
      expect(decrypted.plaintext).toBe(text);
      expect(decrypted.eligibleForDeliveryReceipt).toBe(true);
      expect(decrypted.eligibleForReadReceipt).toBe(true);
    }
  });

  it("fails closed with explicit non-receipt-eligible states on tamper, missing key, downgrade, replay, and key mismatch", async () => {
    const alice = await makeDevice("dev_alice_faults");
    const bob = await makeDevice("dev_bob_faults");
    const carol = await makeDevice("dev_carol_faults");
    const bobBundle = bob.toPublicKeyBundle();

    const enc1 = await alice.encryptForPeer(
      {
        peerUserId: "usr_bob_01",
        peerDeviceId: bob.deviceId,
        peerIdentityKey: bob.identityKey,
        peerSenderKey: bob.senderKey,
        peerOneTimeOrFallbackKey: bobBundle.oneTimeKeys[0]!.key,
      },
      "Original authentic message",
    );
    expect(enc1.ok).toBe(true);
    if (!enc1.ok) return;

    // 1. Tampered ciphertext byte -> tampered-envelope (non-recoverable, no receipt)
    const tamperedEvent = makeEvent({
      messageId: "msg_tampered",
      seq: 1,
      senderDeviceId: alice.deviceId,
      encryptedEnvelope: mutateCiphertextByte(enc1.value.encryptedEnvelope),
    });
    const tamperedRes = await decryptReceivedEnvelope(bob, tamperedEvent);
    expect(tamperedRes.ok).toBe(false);
    if (!tamperedRes.ok) {
      expect(tamperedRes.failureState).toBe("tampered-envelope");
      expect(tamperedRes.recoverable).toBe(false);
      expect(tamperedRes.eligibleForDeliveryReceipt).toBe(false);
      expect(tamperedRes.eligibleForReadReceipt).toBe(false);
    }

    // 2. Outer senderDeviceId mismatch -> tampered-envelope
    const mismatchSenderEvent = makeEvent({
      messageId: "msg_sender_mismatch",
      seq: 2,
      senderDeviceId: "dev_spoofed_99",
      encryptedEnvelope: enc1.value.encryptedEnvelope,
    });
    const mismatchRes = await decryptReceivedEnvelope(bob, mismatchSenderEvent);
    expect(mismatchRes.ok).toBe(false);
    if (!mismatchRes.ok) {
      expect(mismatchRes.failureState).toBe("tampered-envelope");
      expect(mismatchRes.eligibleForDeliveryReceipt).toBe(false);
    }

    // 3. Protocol version downgrade -> unsupported-version
    const downgradeEvent = makeEvent({
      messageId: "msg_downgrade",
      seq: 3,
      senderDeviceId: alice.deviceId,
      protocolVersion: "olm-v0",
      encryptedEnvelope: enc1.value.encryptedEnvelope,
    });
    const downgradeRes = await decryptReceivedEnvelope(bob, downgradeEvent);
    expect(downgradeRes.ok).toBe(false);
    if (!downgradeRes.ok) {
      expect(downgradeRes.failureState).toBe("unsupported-version");
      expect(downgradeRes.recoverable).toBe(false);
      expect(downgradeRes.eligibleForDeliveryReceipt).toBe(false);
    }

    // 4. Missing local device / wrong recipient device -> missing-key (recoverable, no receipt)
    const validEvent = makeEvent({
      messageId: "msg_valid_1",
      seq: 4,
      senderDeviceId: alice.deviceId,
      encryptedEnvelope: enc1.value.encryptedEnvelope,
    });
    const noDeviceRes = await decryptReceivedEnvelope(null, validEvent);
    expect(noDeviceRes.ok).toBe(false);
    if (!noDeviceRes.ok) {
      expect(noDeviceRes.failureState).toBe("missing-key");
      expect(noDeviceRes.recoverable).toBe(true);
      expect(noDeviceRes.eligibleForDeliveryReceipt).toBe(false);
    }

    const wrongDeviceRes = await decryptReceivedEnvelope(carol, validEvent);
    expect(wrongDeviceRes.ok).toBe(false);
    if (!wrongDeviceRes.ok) {
      expect(wrongDeviceRes.failureState).toBe("missing-key");
      expect(wrongDeviceRes.eligibleForDeliveryReceipt).toBe(false);
    }

    // 5. Legitimate decrypt succeeds, then a DIFFERENT messageId replaying the same Olm messageIndex fails
    const okRes = await decryptReceivedEnvelope(bob, validEvent);
    expect(okRes.ok).toBe(true);

    const replayEvent = makeEvent({
      messageId: "msg_replayed_new_id",
      seq: 5,
      senderDeviceId: alice.deviceId,
      encryptedEnvelope: enc1.value.encryptedEnvelope,
    });
    const replayRes = await decryptReceivedEnvelope(bob, replayEvent);
    expect(replayRes.ok).toBe(false);
    if (!replayRes.ok) {
      expect(replayRes.failureState).toBe("replayed-message");
      expect(replayRes.recoverable).toBe(false);
      expect(replayRes.eligibleForDeliveryReceipt).toBe(false);
    }

    // 6. Peer identity key mismatch -> peer-key-blocked
    const enc2 = await alice.encryptForPeer(
      {
        peerUserId: "usr_bob_01",
        peerDeviceId: bob.deviceId,
        peerIdentityKey: bob.identityKey,
        peerSenderKey: bob.senderKey,
      },
      "Second message with key check",
    );
    expect(enc2.ok).toBe(true);
    if (!enc2.ok) return;
    const keyMismatchRes = await decryptReceivedEnvelope(
      bob,
      makeEvent({
        messageId: "msg_key_mismatch",
        seq: 6,
        senderDeviceId: alice.deviceId,
        encryptedEnvelope: enc2.value.encryptedEnvelope,
      }),
      { expectedPeerIdentityKey: carol.identityKey },
    );
    expect(keyMismatchRes.ok).toBe(false);
    if (!keyMismatchRes.ok) {
      expect(keyMismatchRes.failureState).toBe("peer-key-blocked");
      expect(keyMismatchRes.recoverable).toBe(true);
      expect(keyMismatchRes.eligibleForDeliveryReceipt).toBe(false);
    }
  });
});

describe("P2-06 — ReceiveMessageTimeline & EN/BN view-models (ERR-003, FR-CHAT-014)", () => {
  it("deduplicates repeated messageIds, orders by ascending seq, scopes by conversation, and cancels stale async decryptions on account switch", async () => {
    const alice = await makeDevice("dev_alice_timeline");
    const bob = await makeDevice("dev_bob_timeline");
    const bobBundle = bob.toPublicKeyBundle();

    const enc1 = await alice.encryptForPeer(
      {
        peerUserId: "usr_bob_01",
        peerDeviceId: bob.deviceId,
        peerIdentityKey: bob.identityKey,
        peerSenderKey: bob.senderKey,
        peerOneTimeOrFallbackKey: bobBundle.oneTimeKeys[0]!.key,
      },
      "First by seq",
    );
    const enc2 = await alice.encryptForPeer(
      {
        peerUserId: "usr_bob_01",
        peerDeviceId: bob.deviceId,
        peerIdentityKey: bob.identityKey,
        peerSenderKey: bob.senderKey,
      },
      "Second by seq",
    );
    expect(enc1.ok && enc2.ok).toBe(true);
    if (!enc1.ok || !enc2.ok) return;

    const timeline = new ReceiveMessageTimeline({
      accountId: "usr_bob_01",
      conversationId: "conv_ab_01",
      device: bob,
    });

    const event1 = makeEvent({
      messageId: "msg_seq_1",
      conversationId: "conv_ab_01",
      seq: 1,
      senderDeviceId: alice.deviceId,
      encryptedEnvelope: enc1.value.encryptedEnvelope,
    });
    const event2 = makeEvent({
      messageId: "msg_seq_2",
      conversationId: "conv_ab_01",
      seq: 2,
      senderDeviceId: alice.deviceId,
      encryptedEnvelope: enc2.value.encryptedEnvelope,
    });

    // Wrong conversation event is ignored without mutating timeline
    const wrongConv = await timeline.ingestSocketMessageNew(
      successEnvelope(makeEvent({ conversationId: "conv_other_99", messageId: "msg_wrong" })),
    );
    expect(wrongConv).toEqual({ applied: false, reason: "wrong_conversation" });
    expect(timeline.getItems()).toHaveLength(0);

    // Out-of-order ingest (seq 2 before seq 1) sorts deterministically by ascending seq
    const firstApplied = await timeline.ingestSocketMessageNew(successEnvelope(event1));
    expect(firstApplied.applied).toBe(true);

    // Duplicate delivery of msg_seq_1 is deduplicated BEFORE re-decrypting (no false replay error)
    const duplicate = await timeline.ingestSocketMessageNew(successEnvelope(event1));
    expect(duplicate.applied).toBe(false);
    if (!duplicate.applied) expect(duplicate.reason).toBe("duplicate");

    const secondApplied = await timeline.ingestSocketMessageNew(successEnvelope(event2));
    expect(secondApplied.applied).toBe(true);
    expect(timeline.getItems().map((item) => item.seq)).toEqual([1, 2]);

    // ERR-003 stale completion guard: slow decrypt resolves AFTER account switch -> discarded!
    let resolveSlow!: (v: Awaited<ReturnType<OlmAccountDevice["decryptEnvelope"]>>) => void;
    const slowDevice: DecryptCapableDevice = {
      deviceId: bob.deviceId,
      decryptEnvelope: () =>
        new Promise((resolve) => {
          resolveSlow = resolve;
        }),
    };
    const staleTimeline = new ReceiveMessageTimeline({
      accountId: "usr_bob_01",
      conversationId: "conv_ab_01",
      device: slowDevice,
    });

    const enc3 = await alice.encryptForPeer(
      {
        peerUserId: "usr_bob_01",
        peerDeviceId: bob.deviceId,
        peerIdentityKey: bob.identityKey,
        peerSenderKey: bob.senderKey,
      },
      "Stale account secret",
    );
    expect(enc3.ok).toBe(true);
    if (!enc3.ok) return;

    const pending = staleTimeline.ingestMessageEvent(
      makeEvent({
        messageId: "msg_stale_3",
        conversationId: "conv_ab_01",
        seq: 3,
        senderDeviceId: alice.deviceId,
        encryptedEnvelope: enc3.value.encryptedEnvelope,
      }),
    );

    // Switch account BEFORE slow decrypt settles
    staleTimeline.switchAccount("usr_charlie_02", null);
    resolveSlow({
      ok: true,
      value: {
        plaintext: "Stale account secret",
        sessionId: "sess_12345678",
        senderDeviceId: alice.deviceId,
        recipientDeviceId: bob.deviceId,
        senderIdentityKey: alice.identityKey,
        senderCurve25519Key: alice.senderKey,
        messageType: 1,
        messageIndex: 2,
        protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
      },
    });

    const staleOutcome = await pending;
    expect(staleOutcome).toEqual({ applied: false, reason: "stale_context" });
    expect(staleTimeline.getItems()).toHaveLength(0);
    staleTimeline.dispose();
    timeline.dispose();
  });

  it("maps every OlmFailureState to localized EN and BN placeholders with receipt eligibility strictly false", () => {
    const allStates: OlmFailureState[] = [
      "missing-key",
      "tampered-envelope",
      "unsupported-version",
      "replayed-message",
      "session-rollback",
      "peer-key-blocked",
      "crypto-unavailable",
      "invalid-payload",
    ];

    for (const locale of ["en", "bn"] as const) {
      const t = (key: MessageKey, params?: MessageParams) => translate(locale, key, params);
      const fmt = (input: Date | string | number) => String(input);

      for (const state of allStates) {
        const failed: FailedTimelineMessage = {
          kind: "decryption_failed",
          messageId: `msg_${state}`,
          conversationId: "conv_01",
          seq: 1,
          senderUserId: "usr_a",
          senderDeviceId: "dev_a_1234",
          committedAt: "2026-11-19T10:00:00.000Z",
          protocolVersion: MESSAGE_ALLOWED_PROTOCOL_VERSION,
          failureState: state,
          code: "TAMPERED_ENVELOPE",
          recoverable: state === "missing-key" || state === "peer-key-blocked",
          canEmitDeliveryReceipt: false,
          canEmitReadReceipt: false,
        };
        const vm = toReceivedMessageViewModel(failed, t, fmt);
        expect(vm.kind).toBe("decryption_failed");
        expect(vm.text).toBeNull();
        expect(vm.statusBadge.length).toBeGreaterThan(0);
        expect(vm.placeholderTitle?.length ?? 0).toBeGreaterThan(0);
        expect(vm.placeholderDescription?.length ?? 0).toBeGreaterThan(0);
        expect(vm.canEmitDeliveryReceipt).toBe(false);
        expect(vm.canEmitReadReceipt).toBe(false);
      }
    }
  });
});
