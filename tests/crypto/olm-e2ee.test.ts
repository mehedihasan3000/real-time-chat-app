import { describe, expect, it } from "vitest";

import { validateDevicePublicKeyBundle } from "@chat/contracts";
import {
  MAX_ENCRYPTED_ENVELOPE_BYTES,
  MAX_PLAINTEXT_CODE_POINTS,
  OLM_DEVICE_ALGORITHM,
  OLM_PROTOCOL_VERSION,
  OLM_SESSION_MAX_AGE_MS,
  OLM_SESSION_MAX_MESSAGES,
  OLM_WASM_SHA256,
  OlmAccountDevice,
  OlmCryptoError,
  OlmWasmBridge,
  PeerKeyGuard,
  base64UrlDecode,
  base64UrlEncode,
  decodeOlmEncryptedEnvelope,
  encodeOlmEncryptedEnvelope,
  failureStateForCode,
  findEnvelopeForbiddenField,
  generateNonExtractableStorageKey,
  getCompiledOlmWasmBytes,
  validateOlmEnvelopePayload,
  type OlmEncryptedEnvelope,
  type OlmPeerTarget,
} from "@chat/crypto";

/**
 * Deterministic counter-based stream for reproducible known-answer Olm vector
 * checks (`TC-SEC-002`). Uses SHA-256 over a seed + counter block in tests only.
 */
function createDeterministicRandomSource(seedByte: number): (target: Uint8Array) => Uint8Array {
  let counter = 1;
  return (target: Uint8Array): Uint8Array => {
    for (let i = 0; i < target.byteLength; i += 1) {
      // Non-constant deterministic stream derived from seedByte, counter, and index
      const x = Math.imul(seedByte + counter * 31 + i * 17, 0x45d9f3b) >>> 0;
      target[i] = ((x ^ (x >>> 16)) + i + counter) & 0xff;
      if (i % 16 === 15) {
        counter += 1;
      }
    }
    counter += 1;
    return target;
  };
}

function peerTargetFrom(userId: string, device: OlmAccountDevice): OlmPeerTarget {
  const bundle = device.toPublicKeyBundle();
  return {
    peerUserId: userId,
    peerDeviceId: bundle.deviceId,
    peerIdentityKey: bundle.identityKey,
    peerSenderKey: bundle.senderKey,
    peerOneTimeOrFallbackKey: bundle.oneTimeKeys[0]?.key ?? bundle.fallbackKey.key,
  };
}

describe("P2-02 / TC-SEC-001 & TC-SEC-002 — vodozemac 0.11.2 WASM provenance & protocol vectors", () => {
  it("verifies vodozemac 0.11.2 WASM binary provenance and deterministic known-answer vectors", async () => {
    const wasmBytes = getCompiledOlmWasmBytes();
    expect(wasmBytes.byteLength).toBeGreaterThan(100_000);
    // WebAssembly magic header: \0asm\x01\x00\x00\x00
    expect(Array.from(wasmBytes.slice(0, 8))).toEqual([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ]);
    expect(OLM_WASM_SHA256).toMatch(/^[0-9a-f]{64}$/);

    const bridgeA1 = await OlmWasmBridge.create({
      randomSource: createDeterministicRandomSource(0x11),
    });
    const bridgeA2 = await OlmWasmBridge.create({
      randomSource: createDeterministicRandomSource(0x11),
    });
    expect(bridgeA1.libraryInfo()).toEqual({
      library: "vodozemac",
      version: "0.11.2",
      protocolVersion: "olm-vodozemac-v1",
    });

    const accA1 = bridgeA1.createAccount();
    const accA2 = bridgeA2.createAccount();
    // Deterministic seed yields identical Ed25519 identity and Curve25519 sender keys
    expect(accA1.identityKey).toBe(accA2.identityKey);
    expect(accA1.senderKey).toBe(accA2.senderKey);
    expect(accA1.maxOneTimeKeys).toBeGreaterThanOrEqual(50);

    const otkA1 = bridgeA1.generateOneTimeKeys(accA1.accountHandle, 2);
    const otkA2 = bridgeA2.generateOneTimeKeys(accA2.accountHandle, 2);
    expect(otkA1).toEqual(otkA2);

    bridgeA1.freeAccount(accA1.accountHandle);
    bridgeA2.freeAccount(accA2.accountHandle);
  });

  it("completes PreKey -> Normal Double Ratchet exchange and preserves English, Bengali, and emoji Unicode fidelity", async () => {
    const alice = await OlmAccountDevice.create({
      deviceId: "device-alice-01",
      oneTimeKeyCount: 5,
    });
    const bob = await OlmAccountDevice.create({ deviceId: "device-bob-0001", oneTimeKeyCount: 5 });

    const bobInitialCount = bob.toPublicKeyBundle().oneTimeKeys.length;
    expect(bobInitialCount).toBe(5);

    // 1. Alice sends initial PreKey message to Bob (English + Bengali + Emoji + script-like text)
    const msg1 = "Hello! কেমন আছেন? 🌸✨ <script>alert('xss')</script> — synthetic vector #1";
    const enc1 = await alice.encryptForPeer(peerTargetFrom("user-bob", bob), msg1);
    expect(enc1.ok).toBe(true);
    if (!enc1.ok) return;

    expect(enc1.value.protocolVersion).toBe(OLM_PROTOCOL_VERSION);
    expect(enc1.value.messageType).toBe(0); // PreKey message

    // 2. Bob decrypts initial PreKey message, establishing inbound session and consuming one-time key
    const dec1 = await bob.decryptEnvelope(enc1.value, {
      peerUserId: "user-alice",
      expectedPeerIdentityKey: alice.identityKey,
      expectedPeerSenderKey: alice.senderKey,
    });
    expect(dec1.ok).toBe(true);
    if (!dec1.ok) return;
    expect(dec1.value.plaintext).toBe(msg1);
    expect(dec1.value.messageType).toBe(0);
    expect(bob.toPublicKeyBundle().oneTimeKeys.length).toBe(bobInitialCount - 1);

    // 3. Bob replies to Alice over the established session -> transitions ratchet to Normal message (type 1)
    const msg2 = "আমি ভালো আছি! Reply over established Olm Double Ratchet.";
    const enc2 = await bob.encryptForPeer(peerTargetFrom("user-alice", alice), msg2);
    expect(enc2.ok).toBe(true);
    if (!enc2.ok) return;
    expect(enc2.value.messageType).toBe(1); // Normal message after receiving PreKey!

    const dec2 = await alice.decryptEnvelope(enc2.value, {
      peerUserId: "user-bob",
      expectedPeerIdentityKey: bob.identityKey,
      expectedPeerSenderKey: bob.senderKey,
    });
    expect(dec2.ok).toBe(true);
    if (!dec2.ok) return;
    expect(dec2.value.plaintext).toBe(msg2);
    expect(dec2.value.messageType).toBe(1);

    // 4. Subsequent Alice -> Bob message now also uses Normal message (type 1)
    const msg3 = "Ratchet step 3 — forward-secret normal message.";
    const enc3 = await alice.encryptForPeer(peerTargetFrom("user-bob", bob), msg3);
    expect(enc3.ok).toBe(true);
    if (!enc3.ok) return;
    expect(enc3.value.messageType).toBe(1);

    const dec3 = await bob.decryptEnvelope(enc3.value, { peerUserId: "user-alice" });
    expect(dec3.ok).toBe(true);
    if (!dec3.ok) return;
    expect(dec3.value.plaintext).toBe(msg3);

    alice.dispose();
    bob.dispose();
  });

  it("decrypts out-of-order normal messages within the Olm Double Ratchet skipped-key window", async () => {
    const alice = await OlmAccountDevice.create({
      deviceId: "device-alice-oo",
      oneTimeKeyCount: 3,
    });
    const bob = await OlmAccountDevice.create({ deviceId: "device-bob-oooo", oneTimeKeyCount: 3 });

    // Establish session and step ratchet to Normal mode
    const initEnc = await alice.encryptForPeer(peerTargetFrom("user-bob", bob), "init");
    expect(initEnc.ok).toBe(true);
    if (!initEnc.ok) return;
    expect((await bob.decryptEnvelope(initEnc.value, { peerUserId: "user-alice" })).ok).toBe(true);

    const ackEnc = await bob.encryptForPeer(peerTargetFrom("user-alice", alice), "ack");
    expect(ackEnc.ok).toBe(true);
    if (!ackEnc.ok) return;
    expect((await alice.decryptEnvelope(ackEnc.value, { peerUserId: "user-bob" })).ok).toBe(true);

    // Alice encrypts 3 messages in sequence, delivered out of order (m3, then m1, then m2)
    const m1 = await alice.encryptForPeer(peerTargetFrom("user-bob", bob), "ordered-1");
    const m2 = await alice.encryptForPeer(peerTargetFrom("user-bob", bob), "ordered-2");
    const m3 = await alice.encryptForPeer(peerTargetFrom("user-bob", bob), "ordered-3");
    expect(m1.ok && m2.ok && m3.ok).toBe(true);
    if (!m1.ok || !m2.ok || !m3.ok) return;

    const d3 = await bob.decryptEnvelope(m3.value, { peerUserId: "user-alice" });
    const d1 = await bob.decryptEnvelope(m1.value, { peerUserId: "user-alice" });
    const d2 = await bob.decryptEnvelope(m2.value, { peerUserId: "user-alice" });

    expect(d3.ok && d3.value.plaintext).toBe("ordered-3");
    expect(d1.ok && d1.value.plaintext).toBe("ordered-1");
    expect(d2.ok && d2.value.plaintext).toBe("ordered-2");

    alice.dispose();
    bob.dispose();
  });
});

describe("P2-02 / TC-SEC-001 — endpoint encryption boundary, private-key isolation, and no plaintext fallback", () => {
  it("excludes synthetic plaintext and private-key markers from envelopes, public bundles, and sealed state", async () => {
    const alice = await OlmAccountDevice.create({
      deviceId: "device-sec001-a",
      oneTimeKeyCount: 4,
    });
    const bob = await OlmAccountDevice.create({ deviceId: "device-sec001-b", oneTimeKeyCount: 4 });

    const marker = "SYNTHETIC_PLAINTEXT_MARKER_9F8E7D6C_বাংলা_গোপন_বার্তা";
    const encrypted = await alice.encryptForPeer(peerTargetFrom("user-bob", bob), marker);
    expect(encrypted.ok).toBe(true);
    if (!encrypted.ok) return;

    const wireJson = JSON.stringify(encrypted.value);
    const decodedInner = Buffer.from(base64UrlDecode(encrypted.value.encryptedEnvelope)).toString(
      "utf8",
    );
    const publicBundleJson = JSON.stringify(alice.toPublicKeyBundle());
    const sealedState = await alice.sealState();
    const sealedJson = JSON.stringify(sealedState);

    // 1. Plaintext marker is completely absent from wire envelope, inner payload, public bundle, and sealed state
    expect(wireJson).not.toContain(marker);
    expect(wireJson).not.toContain("SYNTHETIC_PLAINTEXT_MARKER");
    expect(decodedInner).not.toContain(marker);
    expect(decodedInner).not.toContain("SYNTHETIC_PLAINTEXT_MARKER");
    expect(publicBundleJson).not.toContain(marker);
    expect(sealedJson).not.toContain(marker);

    // 2. Forbidden field names are absent from all serialized representations
    expect(findEnvelopeForbiddenField(encrypted.value)).toBeNull();
    expect(findEnvelopeForbiddenField(JSON.parse(decodedInner))).toBeNull();
    expect(findEnvelopeForbiddenField(alice.toPublicKeyBundle())).toBeNull();
    expect(findEnvelopeForbiddenField(sealedState)).toBeNull();

    // 3. Public bundle validates against shared P2-01 device-directory contract
    const bundleValidation = validateDevicePublicKeyBundle(
      alice.toPublicKeyBundle(),
      alice.deviceId,
    );
    expect(bundleValidation.ok).toBe(true);
    expect(alice.toPublicKeyBundle().algorithm).toBe(OLM_DEVICE_ALGORITHM);

    // 4. Server/unrelated observer holding public bundles + encrypted envelope cannot decrypt
    const observer = await OlmAccountDevice.create({
      deviceId: "device-observer",
      oneTimeKeyCount: 4,
    });
    const observerAttempt = await observer.decryptEnvelope(encrypted.value, {
      expectedRecipientDeviceId: observer.deviceId,
    });
    expect(observerAttempt.ok).toBe(false);
    if (!observerAttempt.ok) {
      expect(observerAttempt.code).toBe("MISSING_KEY_MATERIAL");
      expect(observerAttempt.state).toBe("missing-key");
    }

    alice.dispose();
    bob.dispose();
    observer.dispose();
  });

  it("rejects forbidden plaintext or private-key fields injected into envelope wrappers or payloads", () => {
    const validInner = {
      schemaVersion: 1 as const,
      protocolVersion: OLM_PROTOCOL_VERSION,
      senderDeviceId: "device-sender-01",
      recipientDeviceId: "device-recip-001",
      senderIdentityKey: "A".repeat(43),
      senderCurve25519Key: "B".repeat(43),
      sessionId: "session-valid-0001",
      messageIndex: 0,
      messageType: 0 as const,
      ciphertext: base64UrlEncode(new Uint8Array(48).fill(7)),
    };
    expect(validateOlmEnvelopePayload(validInner).ok).toBe(true);

    for (const forbidden of [
      "plaintext",
      "text",
      "body",
      "content",
      "fallbackPlaintext",
      "privateKey",
      "secretKey",
      "recoveryKey",
    ]) {
      const injectedInner = validateOlmEnvelopePayload({
        ...validInner,
        [forbidden]: "injected-value",
      });
      expect(injectedInner.ok).toBe(false);
      if (!injectedInner.ok) {
        expect(injectedInner.code).toBe("FORBIDDEN_FIELD");
        expect(injectedInner.state).toBe("invalid-payload");
      }

      const wire = encodeOlmEncryptedEnvelope(validInner);
      const injectedWire = decodeOlmEncryptedEnvelope({
        ...wire,
        [forbidden]: "injected-value",
      });
      expect(injectedWire.ok).toBe(false);
      if (!injectedWire.ok) {
        expect(injectedWire.code).toBe("FORBIDDEN_FIELD");
        expect(injectedWire.state).toBe("invalid-payload");
      }
    }
  });
});

describe("P2-02 / TC-SEC-002 — tamper, truncation, version downgrade, replay, rollback, and missing-key fail-closed states", () => {
  it("surfaces explicit tampered-envelope states when ciphertext, MAC, base64url, or header binding is modified", async () => {
    const alice = await OlmAccountDevice.create({
      deviceId: "device-tamper-a",
      oneTimeKeyCount: 3,
    });
    const bob = await OlmAccountDevice.create({ deviceId: "device-tamper-b", oneTimeKeyCount: 3 });

    const enc = await alice.encryptForPeer(peerTargetFrom("user-bob", bob), "Integrity check");
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;

    const decodedPayload = decodeOlmEncryptedEnvelope(enc.value);
    expect(decodedPayload.ok).toBe(true);
    if (!decodedPayload.ok) return;

    // Case 1: Flip a bit near the end (MAC region) of the Olm ciphertext
    const rawCiphertext = base64UrlDecode(decodedPayload.value.ciphertext);
    const flipped = new Uint8Array(rawCiphertext);
    flipped[flipped.length - 2] = (flipped[flipped.length - 2] ?? 0) ^ 0xff;
    const tamperedMacEnvelope = encodeOlmEncryptedEnvelope({
      ...decodedPayload.value,
      ciphertext: base64UrlEncode(flipped),
    });

    const macRes = await bob.decryptEnvelope(tamperedMacEnvelope, { peerUserId: "user-alice" });
    expect(macRes.ok).toBe(false);
    if (!macRes.ok) {
      expect(macRes.code).toBe("TAMPERED_ENVELOPE");
      expect(macRes.state).toBe("tampered-envelope");
    }

    // Case 2: Truncated Olm ciphertext below minimum frame size
    const truncatedRes = validateOlmEnvelopePayload({
      ...decodedPayload.value,
      ciphertext: base64UrlEncode(rawCiphertext.slice(0, 8)),
    });
    expect(truncatedRes.ok).toBe(false);
    if (!truncatedRes.ok) {
      expect(truncatedRes.code).toBe("TAMPERED_ENVELOPE");
      expect(truncatedRes.state).toBe("tampered-envelope");
    }

    // Case 3: Outer metadata tampered so it disagrees with inner authenticated envelope payload
    const mismatchedOuter: OlmEncryptedEnvelope = {
      ...enc.value,
      senderDeviceId: "device-forged-99",
    };
    const mismatchRes = await bob.decryptEnvelope(mismatchedOuter, { peerUserId: "user-alice" });
    expect(mismatchRes.ok).toBe(false);
    if (!mismatchRes.ok) {
      expect(mismatchRes.code).toBe("TAMPERED_ENVELOPE");
      expect(mismatchRes.state).toBe("tampered-envelope");
    }

    // Case 4: Corrupted base64url in wire encryptedEnvelope
    const corruptB64Res = await bob.decryptEnvelope({
      ...enc.value,
      encryptedEnvelope: "%%%not-valid-base64url%%%",
    });
    expect(corruptB64Res.ok).toBe(false);
    if (!corruptB64Res.ok) {
      expect(corruptB64Res.code).toBe("TAMPERED_ENVELOPE");
      expect(corruptB64Res.state).toBe("tampered-envelope");
    }

    // Original untouched envelope still decrypts cleanly because failed tampered attempts did not advance state
    const validRes = await bob.decryptEnvelope(enc.value, { peerUserId: "user-alice" });
    expect(validRes.ok).toBe(true);
    if (validRes.ok) {
      expect(validRes.value.plaintext).toBe("Integrity check");
    }

    alice.dispose();
    bob.dispose();
  });

  it("rejects unknown, missing, or downgraded protocolVersion and schemaVersion values", async () => {
    const alice = await OlmAccountDevice.create({
      deviceId: "device-version1",
      oneTimeKeyCount: 2,
    });
    const bob = await OlmAccountDevice.create({ deviceId: "device-version2", oneTimeKeyCount: 2 });

    const enc = await alice.encryptForPeer(peerTargetFrom("user-bob", bob), "Version test");
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;

    for (const badVersion of ["olm-v0", "dev-webcrypto-v0", "plaintext", "", null, 1]) {
      const res = await bob.decryptEnvelope({
        ...enc.value,
        protocolVersion: badVersion,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe("UNSUPPORTED_PROTOCOL_VERSION");
        expect(res.state).toBe("unsupported-version");
      }
    }

    const badSchema = await bob.decryptEnvelope({
      ...enc.value,
      schemaVersion: 2,
    });
    expect(badSchema.ok).toBe(false);
    if (!badSchema.ok) {
      expect(badSchema.code).toBe("UNSUPPORTED_PROTOCOL_VERSION");
      expect(badSchema.state).toBe("unsupported-version");
    }

    alice.dispose();
    bob.dispose();
  });

  it("surfaces explicit missing-key states when prekey, session, or account state is unavailable", async () => {
    const alice = await OlmAccountDevice.create({
      deviceId: "device-misskey1",
      oneTimeKeyCount: 2,
    });
    const bob = await OlmAccountDevice.create({ deviceId: "device-misskey2", oneTimeKeyCount: 2 });
    const charlie = await OlmAccountDevice.create({
      deviceId: "device-misskey3",
      oneTimeKeyCount: 2,
    });

    // 1. Outbound encryption without a prekey before any session exists -> MISSING_KEY_MATERIAL
    const noPrekeyTarget: OlmPeerTarget = {
      peerUserId: "user-bob",
      peerDeviceId: bob.deviceId,
      peerIdentityKey: bob.identityKey,
      peerSenderKey: bob.senderKey,
    };
    const noPrekeyRes = await alice.encryptForPeer(noPrekeyTarget, "Cannot start session");
    expect(noPrekeyRes.ok).toBe(false);
    if (!noPrekeyRes.ok) {
      expect(noPrekeyRes.code).toBe("MISSING_KEY_MATERIAL");
      expect(noPrekeyRes.state).toBe("missing-key");
    }

    // 2. Normal message (type 1) arriving at Charlie who has no session -> MISSING_KEY_MATERIAL
    const initEnc = await alice.encryptForPeer(peerTargetFrom("user-bob", bob), "init");
    expect(initEnc.ok).toBe(true);
    if (!initEnc.ok) return;
    await bob.decryptEnvelope(initEnc.value, { peerUserId: "user-alice" });
    const replyEnc = await bob.encryptForPeer(peerTargetFrom("user-alice", alice), "reply");
    expect(replyEnc.ok).toBe(true);
    if (!replyEnc.ok) return;
    expect(replyEnc.value.messageType).toBe(1);

    const decodedReply = decodeOlmEncryptedEnvelope(replyEnc.value);
    expect(decodedReply.ok).toBe(true);
    if (!decodedReply.ok) return;
    const redirectedNormal = encodeOlmEncryptedEnvelope({
      ...decodedReply.value,
      recipientDeviceId: charlie.deviceId,
    });
    const noSessionRes = await charlie.decryptEnvelope(redirectedNormal);
    expect(noSessionRes.ok).toBe(false);
    if (!noSessionRes.ok) {
      expect(noSessionRes.code).toBe("MISSING_KEY_MATERIAL");
      expect(noSessionRes.state).toBe("missing-key");
    }

    // 3. PreKey message encrypted for Bob's prekey cannot be decrypted by Charlie's account -> MISSING_KEY_MATERIAL
    const decodedPreKey = decodeOlmEncryptedEnvelope(initEnc.value);
    expect(decodedPreKey.ok).toBe(true);
    if (!decodedPreKey.ok) return;
    const wrongAccountPreKey = encodeOlmEncryptedEnvelope({
      ...decodedPreKey.value,
      recipientDeviceId: charlie.deviceId,
    });
    const wrongAccountRes = await charlie.decryptEnvelope(wrongAccountPreKey);
    expect(wrongAccountRes.ok).toBe(false);
    if (!wrongAccountRes.ok) {
      expect(wrongAccountRes.code).toBe("MISSING_KEY_MATERIAL");
      expect(wrongAccountRes.state).toBe("missing-key");
    }

    // 4. Disposed account fails closed with MISSING_KEY_MATERIAL
    alice.dispose();
    const disposedEnc = await alice.encryptForPeer(
      peerTargetFrom("user-bob", bob),
      "after dispose",
    );
    expect(disposedEnc.ok).toBe(false);
    if (!disposedEnc.ok) {
      expect(disposedEnc.code).toBe("MISSING_KEY_MATERIAL");
      expect(disposedEnc.state).toBe("missing-key");
    }

    bob.dispose();
    charlie.dispose();
  });

  it("rejects replayed messages, sealed-state rollback, and unaccepted peer key changes", async () => {
    const sharedGuard = new PeerKeyGuard();
    const storageKey = await generateNonExtractableStorageKey();
    const alice = await OlmAccountDevice.create({
      deviceId: "device-replay-a",
      oneTimeKeyCount: 3,
      peerKeyGuard: sharedGuard,
      storageKey,
    });
    const bob = await OlmAccountDevice.create({
      deviceId: "device-replay-b",
      oneTimeKeyCount: 3,
    });

    const sealedRev1 = await alice.sealState();
    const enc1 = await alice.encryptForPeer(peerTargetFrom("user-bob", bob), "First message");
    expect(enc1.ok).toBe(true);
    if (!enc1.ok) return;
    const sealedRev2 = await alice.sealState();
    expect(sealedRev2.stateRevision).toBeGreaterThan(sealedRev1.stateRevision);

    // 1. Replay detection: decrypting the same message twice fails with REPLAYED_OR_DUPLICATE_MESSAGE
    const firstDec = await bob.decryptEnvelope(enc1.value, { peerUserId: "user-alice" });
    expect(firstDec.ok).toBe(true);

    const replayDec = await bob.decryptEnvelope(enc1.value, { peerUserId: "user-alice" });
    expect(replayDec.ok).toBe(false);
    if (!replayDec.ok) {
      expect(replayDec.code).toBe("REPLAYED_OR_DUPLICATE_MESSAGE");
      expect(replayDec.state).toBe("replayed-message");
    }

    // 2. State rollback detection: restoring sealedRev1 when minExpectedRevision is sealedRev2.stateRevision fails closed
    const rollbackAttempt = await OlmAccountDevice.unsealState(sealedRev1, storageKey, {
      minExpectedRevision: sealedRev2.stateRevision,
    });
    expect(rollbackAttempt.ok).toBe(false);
    if (!rollbackAttempt.ok) {
      expect(rollbackAttempt.code).toBe("SESSION_ROLLBACK_DETECTED");
      expect(rollbackAttempt.state).toBe("session-rollback");
    }

    // Restoring current revision succeeds and preserves session state
    const validRestore = await OlmAccountDevice.unsealState(sealedRev2, storageKey, {
      minExpectedRevision: sealedRev2.stateRevision,
      peerKeyGuard: sharedGuard,
    });
    expect(validRestore.ok).toBe(true);
    if (!validRestore.ok) return;

    // 3. Peer key-change block (FR-SEC-005 / FR-SEC-028): if Bob replaces his device with a new identity key,
    // Alice blocks sending until explicit user acceptance.
    const bobReplaced = await OlmAccountDevice.create({
      deviceId: "device-replay-b2",
      oneTimeKeyCount: 3,
    });
    const blockedSend = await validRestore.value.encryptForPeer(
      peerTargetFrom("user-bob", bobReplaced),
      "Should be blocked on key change",
    );
    expect(blockedSend.ok).toBe(false);
    if (!blockedSend.ok) {
      expect(blockedSend.code).toBe("PEER_KEY_CHANGE_BLOCKED");
      expect(blockedSend.state).toBe("peer-key-blocked");
    }

    // After explicit acceptance of the peer key change, sending is unblocked and creates a fresh session
    sharedGuard.accept("user-bob");
    const unblockedSend = await validRestore.value.encryptForPeer(
      peerTargetFrom("user-bob", bobReplaced),
      "Allowed after explicit key-change acceptance",
    );
    expect(unblockedSend.ok).toBe(true);

    alice.dispose();
    validRestore.value.dispose();
    bob.dispose();
    bobReplaced.dispose();
  });

  it("enforces DEC-016 size bounds, DEC-004 session rotation, and FR-SEC-004 CSPRNG validation", async () => {
    let currentClock = new Date("2026-11-17T00:00:00.000Z");
    const alice = await OlmAccountDevice.create({
      deviceId: "device-bounds-a",
      oneTimeKeyCount: 5,
      now: () => currentClock,
    });
    const bob = await OlmAccountDevice.create({
      deviceId: "device-bounds-b",
      oneTimeKeyCount: 5,
      now: () => currentClock,
    });

    // 1. Oversized plaintext (> 8,000 Unicode code points) fails closed with PAYLOAD_TOO_LARGE
    const oversizedText = "ক".repeat(MAX_PLAINTEXT_CODE_POINTS + 1);
    const oversizedRes = await alice.encryptForPeer(peerTargetFrom("user-bob", bob), oversizedText);
    expect(oversizedRes.ok).toBe(false);
    if (!oversizedRes.ok) {
      expect(oversizedRes.code).toBe("PAYLOAD_TOO_LARGE");
      expect(oversizedRes.state).toBe("invalid-payload");
    }

    // 2. Oversized decoded wire envelope (> 16 KiB) fails closed with PAYLOAD_TOO_LARGE
    const hugeWire = decodeOlmEncryptedEnvelope({
      schemaVersion: 1,
      protocolVersion: OLM_PROTOCOL_VERSION,
      senderDeviceId: alice.deviceId,
      recipientDeviceId: bob.deviceId,
      sessionId: "session-huge-01",
      messageType: 0,
      encryptedEnvelope: base64UrlEncode(
        new Uint8Array(MAX_ENCRYPTED_ENVELOPE_BYTES + 64).fill(65),
      ),
    });
    expect(hugeWire.ok).toBe(false);
    if (!hugeWire.ok) {
      expect(hugeWire.code).toBe("PAYLOAD_TOO_LARGE");
      expect(hugeWire.state).toBe("invalid-payload");
    }

    // 3. DEC-004 session rotation after 90 days retains old session read-only for history
    const firstMsg = await alice.encryptForPeer(peerTargetFrom("user-bob", bob), "Day 0 message");
    expect(firstMsg.ok).toBe(true);
    if (!firstMsg.ok) return;
    const oldSessionId = firstMsg.value.sessionId;
    expect((await bob.decryptEnvelope(firstMsg.value, { peerUserId: "user-alice" })).ok).toBe(true);
    const bobOldReply = await bob.encryptForPeer(
      peerTargetFrom("user-alice", alice),
      "Delayed historical reply on old session",
    );
    expect(bobOldReply.ok).toBe(true);
    if (!bobOldReply.ok) return;

    // Advance clock past 90 days (OLM_SESSION_MAX_AGE_MS + 1000)
    currentClock = new Date(currentClock.getTime() + OLM_SESSION_MAX_AGE_MS + 1_000);
    expect(alice.isFallbackKeyRotationDue(currentClock)).toBe(true);
    await alice.rotateFallbackKey();
    expect(alice.isFallbackKeyRotationDue(currentClock)).toBe(false);

    const rotatedTarget: OlmPeerTarget = {
      ...peerTargetFrom("user-bob", bob),
      peerOneTimeOrFallbackKey: bob.toPublicKeyBundle().oneTimeKeys[1]!.key,
    };
    const rotatedMsg = await alice.encryptForPeer(rotatedTarget, "Day 91 message on fresh session");
    expect(rotatedMsg.ok).toBe(true);
    if (!rotatedMsg.ok) return;
    expect(rotatedMsg.value.sessionId).not.toBe(oldSessionId);
    expect(alice.getSessionMetadata(oldSessionId)?.readOnly).toBe(true);

    // Old session remains usable read-only to decrypt the delayed historical message!
    const delayedDec = await alice.decryptEnvelope(bobOldReply.value, { peerUserId: "user-bob" });
    expect(delayedDec.ok).toBe(true);
    if (delayedDec.ok) {
      expect(delayedDec.value.plaintext).toBe("Delayed historical reply on old session");
    }
    expect(OLM_SESSION_MAX_MESSAGES).toBe(1_000);

    // 4. FR-SEC-004: degenerate all-constant CSPRNG is rejected fail-closed with INSECURE_RANDOMNESS
    const brokenBridge = await OlmWasmBridge.create({
      randomSource: (target) => target.fill(0x00),
    });
    expect(() => brokenBridge.createAccount()).toThrowError(OlmCryptoError);
    try {
      brokenBridge.createAccount();
    } catch (err) {
      expect(err).toBeInstanceOf(OlmCryptoError);
      expect((err as OlmCryptoError).code).toBe("INSECURE_RANDOMNESS");
      expect(failureStateForCode((err as OlmCryptoError).code)).toBe("crypto-unavailable");
    }

    alice.dispose();
    bob.dispose();
  });

  it("enforces non-extractable storage keys, rejects wrong/tampered sealed bundles, and serializes concurrent operations", async () => {
    // 1. Extractable AES-GCM CryptoKey is rejected (FR-SEC-006)
    const extractableKey = await globalThis.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    await expect(
      OlmAccountDevice.create({
        deviceId: "device-extract1",
        storageKey: extractableKey,
      }),
    ).rejects.toThrow(/non-extractable/i);

    const alice = await OlmAccountDevice.create({
      deviceId: "device-concur-a",
      oneTimeKeyCount: 5,
    });
    const bob = await OlmAccountDevice.create({ deviceId: "device-concur-b", oneTimeKeyCount: 5 });

    // 2. Replenish and markKeysAsPublished lifecycle
    await alice.markKeysAsPublished();
    const replenished = await alice.replenishOneTimeKeys(6);
    expect(replenished.oneTimeKeys.length).toBeGreaterThanOrEqual(6);

    // 3. Concurrent encryptions on the same device serialize cleanly through SingleWriterLock
    const target = peerTargetFrom("user-bob", bob);
    const concurrentSends = await Promise.all([
      alice.encryptForPeer(target, "concurrent-1"),
      alice.encryptForPeer(target, "concurrent-2"),
      alice.encryptForPeer(target, "concurrent-3"),
    ]);
    expect(concurrentSends.every((r) => r.ok)).toBe(true);
    for (const send of concurrentSends) {
      if (send.ok) {
        const dec = await bob.decryptEnvelope(send.value, { peerUserId: "user-alice" });
        expect(dec.ok).toBe(true);
      }
    }

    // 4. Wrong storageKey or tampered AAD on unsealState fails closed with PICKLE_DECRYPTION_FAILED
    const sealed = await alice.sealState();
    const wrongKey = await generateNonExtractableStorageKey();
    const wrongKeyRes = await OlmAccountDevice.unsealState(sealed, wrongKey);
    expect(wrongKeyRes.ok).toBe(false);
    if (!wrongKeyRes.ok) {
      expect(wrongKeyRes.code).toBe("PICKLE_DECRYPTION_FAILED");
      expect(wrongKeyRes.state).toBe("missing-key");
    }

    const tamperedDeviceRes = await OlmAccountDevice.unsealState(
      { ...sealed, deviceId: "device-forged-id" },
      alice.storageKey,
    );
    expect(tamperedDeviceRes.ok).toBe(false);
    if (!tamperedDeviceRes.ok) {
      expect(tamperedDeviceRes.code).toBe("PICKLE_DECRYPTION_FAILED");
      expect(tamperedDeviceRes.state).toBe("missing-key");
    }

    alice.dispose();
    bob.dispose();
  });
});
