import {
  DEVICE_KEY_SCHEMA_VERSION,
  FALLBACK_KEY_MAX_AGE_DAYS,
  ONE_TIME_KEYS_MAX,
  ONE_TIME_KEYS_MIN,
  isDeviceId,
  validateDevicePublicKeyBundle,
  type DevicePublicKey,
  type DevicePublicKeyBundle,
} from "@chat/contracts";
import { base64UrlDecode, base64UrlEncode, newDeviceId, randomBytes } from "../device/encoding.js";
import { DEFAULT_ONE_TIME_KEY_COUNT, assertNoForbiddenFields } from "../device/identity.js";
import { PeerKeyGuard, canSendToPeer, type PeerKeyState } from "../device/peer-trust.js";
import {
  OLM_ENVELOPE_SCHEMA_VERSION,
  OLM_MESSAGE_TYPE_PREKEY,
  OLM_PROTOCOL_VERSION,
  assertSupportedProtocolVersion,
  assertValidPlaintext,
  decodeOlmEncryptedEnvelope,
  encodeOlmEncryptedEnvelope,
  findEnvelopeForbiddenField,
  type OlmEncryptedEnvelope,
  type OlmEnvelopePayload,
  type OlmMessageType,
} from "./envelope.js";
import { OlmCryptoError, olmFailure, type OlmResult } from "./errors.js";
import { OlmWasmBridge, type OlmWasmBridgeOptions } from "./wasm-bridge.js";

/**
 * Olm account, session, and envelope encryption/decryption manager
 * (P2-02, DEC-018, DEC-002, DEC-004, FR-CHAT-002, FR-CHAT-014, FR-SEC-001..006, FR-SEC-028).
 *
 * Enforces:
 * - Olm (Double Ratchet) via `vodozemac` 0.11.2 WASM (`packages/crypto/wasm/`)
 * - No raw private key exports to JavaScript (`FR-SEC-002`)
 * - Non-extractable Web Crypto AES-256-GCM wrapping of account/session pickles (`FR-SEC-006`)
 * - Single-writer lock serialization for concurrent operations (`DEC-002` §4.1)
 * - Session rotation policy (`DEC-004` §4.4): fresh session after 90 days or 1,000 messages,
 *   or after repeated decryption failures, retaining old sessions read-only for history
 * - Replay and state-rollback detection (`TC-SEC-002`, `DEC-018`)
 * - Peer key-change block integration (`FR-SEC-005`, `FR-SEC-028`)
 * - Fail-closed behavior with zero plaintext fallback (`FR-SEC-028`)
 */

export const OLM_DEVICE_ALGORITHM = "olm-vodozemac-v1" as const;

/** DEC-004 session rotation limits: 90 days or 1,000 outbound messages. */
export const OLM_SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const OLM_SESSION_MAX_MESSAGES = 1_000;
export const OLM_MAX_CONSECUTIVE_DECRYPT_FAILURES = 3;

export interface SingleWriterLock {
  acquire<T>(lockName: string, operation: () => Promise<T>): Promise<T>;
}

/**
 * Default in-process + optional Web Locks single-writer lock (`DEC-002` §4.1).
 * Fails closed (`LOCK_UNAVAILABLE`) if a required lock fails.
 */
export class InProcessSingleWriterLock implements SingleWriterLock {
  private readonly queues = new Map<string, Promise<unknown>>();

  async acquire<T>(lockName: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(lockName) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(
      lockName,
      previous.then(() => gate),
    );
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(lockName) === gate) {
        this.queues.delete(lockName);
      }
    }
  }
}

/**
 * Sealed account/session state encrypted at rest with a non-extractable
 * AES-256-GCM `CryptoKey` (`DEC-002` §4.5, `FR-SEC-006`).
 */
export interface SealedOlmStateBundle {
  schemaVersion: 1;
  protocolVersion: typeof OLM_PROTOCOL_VERSION;
  deviceId: string;
  identityKey: string;
  senderKey: string;
  stateRevision: number;
  sealedAt: string;
  iv: string;
  ciphertext: string;
}

export interface OlmSessionMetadata {
  sessionId: string;
  peerUserId: string;
  peerDeviceId: string;
  peerIdentityKey: string;
  peerSenderKey: string;
  createdAt: string;
  outboundMessageCount: number;
  inboundMessageCount: number;
  consecutiveDecryptFailures: number;
  readOnly: boolean;
  seenMessageIndices: number[];
}

export interface OlmPeerTarget {
  peerUserId: string;
  peerDeviceId: string;
  peerIdentityKey: string;
  peerSenderKey: string;
  /** Required when establishing a new outbound session (`PreKey` message). */
  peerOneTimeOrFallbackKey?: string;
}

export interface OlmDecryptContext {
  expectedRecipientDeviceId?: string;
  peerUserId?: string;
  expectedPeerIdentityKey?: string;
  expectedPeerSenderKey?: string;
}

export interface OlmDecryptedMessage {
  plaintext: string;
  sessionId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  senderIdentityKey: string;
  senderCurve25519Key: string;
  messageType: OlmMessageType;
  messageIndex: number;
  protocolVersion: typeof OLM_PROTOCOL_VERSION;
}

export interface CreateOlmAccountDeviceOptions extends OlmWasmBridgeOptions {
  deviceId?: string;
  oneTimeKeyCount?: number;
  now?: () => Date;
  lock?: SingleWriterLock;
  peerKeyGuard?: PeerKeyGuard;
  storageKey?: CryptoKey;
}

interface InternalSessionState {
  handle: number;
  meta: OlmSessionMetadata;
  seenIndices: Set<number>;
}

interface SealedInnerPayload {
  schemaVersion: 1;
  protocolVersion: typeof OLM_PROTOCOL_VERSION;
  deviceId: string;
  identityKey: string;
  senderKey: string;
  stateRevision: number;
  pickleKeyBase64Url: string;
  accountPickle: string;
  fallbackKey: DevicePublicKey;
  fallbackPublishedAt: string;
  oneTimeKeys: DevicePublicKey[];
  sessions: Array<{
    pickle: string;
    meta: OlmSessionMetadata;
  }>;
}

export async function generateNonExtractableStorageKey(): Promise<CryptoKey> {
  return globalThis.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export function assertStorageKeyNonExtractable(key: CryptoKey): void {
  if (key.extractable) {
    throw new OlmCryptoError(
      "MISSING_KEY_MATERIAL",
      "IndexedDB Olm storage CryptoKey must be non-extractable (FR-SEC-006).",
    );
  }
}

export class OlmAccountDevice {
  private disposed = false;
  private stateRevision = 1;
  private lastKnownSavedRevision = 0;
  private fallbackKey: DevicePublicKey;
  private fallbackPublishedAt: string;
  private oneTimeKeys: DevicePublicKey[];
  private readonly sessionsById = new Map<string, InternalSessionState>();
  private readonly activeOutboundByPeerDevice = new Map<string, string>();

  private constructor(
    private readonly bridge: OlmWasmBridge,
    private accountHandle: number,
    readonly deviceId: string,
    readonly identityKey: string,
    readonly senderKey: string,
    readonly maxOneTimeKeys: number,
    readonly storageKey: CryptoKey,
    private readonly lock: SingleWriterLock,
    readonly peerKeyGuard: PeerKeyGuard,
    private readonly now: () => Date,
    initialFallbackKey: DevicePublicKey,
    initialFallbackPublishedAt: string,
    initialOneTimeKeys: DevicePublicKey[],
  ) {
    this.fallbackKey = initialFallbackKey;
    this.fallbackPublishedAt = initialFallbackPublishedAt;
    this.oneTimeKeys = initialOneTimeKeys;
  }

  static async create(options: CreateOlmAccountDeviceOptions = {}): Promise<OlmAccountDevice> {
    const deviceId = options.deviceId ?? newDeviceId();
    if (!isDeviceId(deviceId)) {
      throw new OlmCryptoError(
        "INVALID_ENVELOPE",
        "deviceId must be an opaque 8–128 character identifier.",
      );
    }
    const oneTimeKeyCount = options.oneTimeKeyCount ?? DEFAULT_ONE_TIME_KEY_COUNT;
    if (
      !Number.isInteger(oneTimeKeyCount) ||
      oneTimeKeyCount < ONE_TIME_KEYS_MIN ||
      oneTimeKeyCount > ONE_TIME_KEYS_MAX
    ) {
      throw new OlmCryptoError(
        "INVALID_ENVELOPE",
        `oneTimeKeyCount must be ${ONE_TIME_KEYS_MIN}..${ONE_TIME_KEYS_MAX}.`,
      );
    }

    const storageKey = options.storageKey ?? (await generateNonExtractableStorageKey());
    assertStorageKeyNonExtractable(storageKey);

    const bridge = await OlmWasmBridge.create(options);
    const account = bridge.createAccount();
    const oneTimeKeys = bridge.generateOneTimeKeys(account.accountHandle, oneTimeKeyCount);
    const fallbackKey = bridge.generateFallbackKey(account.accountHandle);
    const nowFn = options.now ?? (() => new Date());
    const nowIso = nowFn().toISOString();

    const device = new OlmAccountDevice(
      bridge,
      account.accountHandle,
      deviceId,
      account.identityKey,
      account.senderKey,
      account.maxOneTimeKeys,
      storageKey,
      options.lock ?? new InProcessSingleWriterLock(),
      options.peerKeyGuard ?? new PeerKeyGuard(undefined, nowFn),
      nowFn,
      fallbackKey,
      nowIso,
      oneTimeKeys,
    );
    // Validate public bundle shape upfront.
    device.toPublicKeyBundle();
    return device;
  }

  private assertActive(): void {
    if (this.disposed || this.accountHandle <= 0) {
      throw new OlmCryptoError(
        "MISSING_KEY_MATERIAL",
        "Olm device account state is unavailable or has been disposed.",
      );
    }
  }

  get libraryInfo() {
    this.assertActive();
    return this.bridge.libraryInfo();
  }

  get currentRevision(): number {
    return this.stateRevision;
  }

  /**
   * Public-only key bundle for publication to the P2-01 device directory.
   * Never includes private keys or pickle state (`FR-SEC-002`, `TC-SEC-001`).
   */
  toPublicKeyBundle(): DevicePublicKeyBundle {
    this.assertActive();
    const bundle: DevicePublicKeyBundle = {
      schemaVersion: DEVICE_KEY_SCHEMA_VERSION,
      algorithm: OLM_DEVICE_ALGORITHM,
      deviceId: this.deviceId,
      identityKey: this.identityKey,
      senderKey: this.senderKey,
      oneTimeKeys: this.oneTimeKeys.map((k) => ({ ...k })),
      fallbackKey: { ...this.fallbackKey },
    };
    assertNoForbiddenFields(bundle);
    const validated = validateDevicePublicKeyBundle(bundle, this.deviceId);
    if (!validated.ok) {
      throw new OlmCryptoError("INVALID_ENVELOPE", validated.message);
    }
    return validated.value;
  }

  /**
   * Mark current one-time and fallback prekeys as published on the Olm account.
   */
  async markKeysAsPublished(): Promise<void> {
    await this.lock.acquire(`olm:${this.deviceId}`, async () => {
      this.assertActive();
      this.bridge.markKeysAsPublished(this.accountHandle);
      this.stateRevision += 1;
    });
  }

  /**
   * Replenish one-time prekeys in the WASM Olm account (`DEC-004` §4.4).
   */
  async replenishOneTimeKeys(count = DEFAULT_ONE_TIME_KEY_COUNT): Promise<DevicePublicKeyBundle> {
    return this.lock.acquire(`olm:${this.deviceId}`, async () => {
      this.assertActive();
      if (!Number.isInteger(count) || count < ONE_TIME_KEYS_MIN || count > ONE_TIME_KEYS_MAX) {
        throw new OlmCryptoError(
          "INVALID_ENVELOPE",
          `oneTimeKeyCount must be ${ONE_TIME_KEYS_MIN}..${ONE_TIME_KEYS_MAX}.`,
        );
      }
      this.oneTimeKeys = this.bridge.generateOneTimeKeys(this.accountHandle, count);
      this.stateRevision += 1;
      return this.toPublicKeyBundle();
    });
  }

  /**
   * Rotate the fallback prekey (`DEC-004` §4.4: every 30 days and after use).
   */
  async rotateFallbackKey(): Promise<DevicePublicKey> {
    return this.lock.acquire(`olm:${this.deviceId}`, async () => {
      this.assertActive();
      this.fallbackKey = this.bridge.generateFallbackKey(this.accountHandle);
      this.fallbackPublishedAt = this.now().toISOString();
      this.stateRevision += 1;
      return { ...this.fallbackKey };
    });
  }

  isFallbackKeyRotationDue(at: Date = this.now()): boolean {
    const publishedMs = Date.parse(this.fallbackPublishedAt);
    const maxAgeMs = FALLBACK_KEY_MAX_AGE_DAYS * 86_400_000;
    return at.getTime() - publishedMs >= maxAgeMs;
  }

  private isSessionRotationDue(meta: OlmSessionMetadata, now: Date): boolean {
    if (meta.readOnly) return true;
    if (meta.outboundMessageCount >= OLM_SESSION_MAX_MESSAGES) return true;
    if (meta.consecutiveDecryptFailures >= OLM_MAX_CONSECUTIVE_DECRYPT_FAILURES) return true;
    const createdMs = Date.parse(meta.createdAt);
    if (now.getTime() - createdMs >= OLM_SESSION_MAX_AGE_MS) return true;
    return false;
  }

  private assertPeerAllowedForSend(target: OlmPeerTarget): PeerKeyState {
    if (!target.peerUserId || !isDeviceId(target.peerDeviceId)) {
      throw new OlmCryptoError(
        "PEER_KEY_MISMATCH",
        "Peer user ID and valid device ID are required.",
      );
    }
    const existing = this.peerKeyGuard.get(target.peerUserId);
    if (!existing) {
      const obs = this.peerKeyGuard.observe(target.peerUserId, target.peerIdentityKey);
      return obs.state;
    }
    if (existing.identityKey !== target.peerIdentityKey) {
      this.peerKeyGuard.observe(target.peerUserId, target.peerIdentityKey);
      throw new OlmCryptoError(
        "PEER_KEY_CHANGE_BLOCKED",
        "Peer identity key changed; sending is blocked until the user explicitly accepts the new key (FR-SEC-005).",
      );
    }
    if (!canSendToPeer(existing)) {
      throw new OlmCryptoError(
        "PEER_KEY_CHANGE_BLOCKED",
        "Peer key change is pending user acceptance; sending is blocked (FR-SEC-005).",
      );
    }
    return existing;
  }

  /**
   * Encrypt UTF-8 message plaintext into a versioned `OlmEncryptedEnvelope`
   * (`FR-CHAT-002`, `FR-SEC-001`, `FR-SEC-028`).
   *
   * Fails closed if:
   * - account state is missing/disposed (`MISSING_KEY_MATERIAL`)
   * - peer identity key changed without acceptance (`PEER_KEY_CHANGE_BLOCKED`)
   * - no active session exists and no prekey is supplied (`MISSING_KEY_MATERIAL`)
   * - plaintext is invalid or > 8,000 Unicode code points (`PAYLOAD_TOO_LARGE`)
   */
  async encryptForPeer(
    target: OlmPeerTarget,
    plaintext: string,
  ): Promise<OlmResult<OlmEncryptedEnvelope>> {
    try {
      return await this.lock.acquire(`olm:${this.deviceId}`, async () => {
        this.assertActive();
        const validPlaintext = assertValidPlaintext(plaintext);
        this.assertPeerAllowedForSend(target);

        const now = this.now();
        const peerKey = `${target.peerUserId}:${target.peerDeviceId}`;
        let activeSessionId = this.activeOutboundByPeerDevice.get(peerKey);
        let sessionState = activeSessionId ? this.sessionsById.get(activeSessionId) : undefined;

        // Rotate session if peer sender key changed or DEC-004 limits reached.
        if (
          sessionState &&
          (sessionState.meta.peerIdentityKey !== target.peerIdentityKey ||
            sessionState.meta.peerSenderKey !== target.peerSenderKey ||
            this.isSessionRotationDue(sessionState.meta, now))
        ) {
          sessionState.meta.readOnly = true;
          this.activeOutboundByPeerDevice.delete(peerKey);
          sessionState = undefined;
          activeSessionId = undefined;
        }

        if (!sessionState) {
          if (!target.peerOneTimeOrFallbackKey) {
            throw new OlmCryptoError(
              "MISSING_KEY_MATERIAL",
              "Cannot establish outbound Olm session: peer one-time or fallback prekey is missing.",
            );
          }
          const created = this.bridge.createOutboundSession(
            this.accountHandle,
            target.peerSenderKey,
            target.peerOneTimeOrFallbackKey,
          );
          const meta: OlmSessionMetadata = {
            sessionId: created.sessionId,
            peerUserId: target.peerUserId,
            peerDeviceId: target.peerDeviceId,
            peerIdentityKey: target.peerIdentityKey,
            peerSenderKey: target.peerSenderKey,
            createdAt: now.toISOString(),
            outboundMessageCount: 0,
            inboundMessageCount: 0,
            consecutiveDecryptFailures: 0,
            readOnly: false,
            seenMessageIndices: [],
          };
          sessionState = {
            handle: created.sessionHandle,
            meta,
            seenIndices: new Set<number>(),
          };
          this.sessionsById.set(created.sessionId, sessionState);
          this.activeOutboundByPeerDevice.set(peerKey, created.sessionId);
        }

        const encrypted = this.bridge.encrypt(sessionState.handle, validPlaintext);
        const messageIndex = sessionState.meta.outboundMessageCount;
        sessionState.meta.outboundMessageCount += 1;
        this.stateRevision += 1;

        const payload: OlmEnvelopePayload = {
          schemaVersion: OLM_ENVELOPE_SCHEMA_VERSION,
          protocolVersion: OLM_PROTOCOL_VERSION,
          senderDeviceId: this.deviceId,
          recipientDeviceId: target.peerDeviceId,
          senderIdentityKey: this.identityKey,
          senderCurve25519Key: this.senderKey,
          sessionId: encrypted.sessionId,
          messageIndex,
          messageType: encrypted.messageType,
          ciphertext: encrypted.ciphertext,
        };
        const wire = encodeOlmEncryptedEnvelope(payload);
        return { ok: true, value: wire };
      });
    } catch (error) {
      return olmFailure(error);
    }
  }

  /**
   * Decrypt a versioned `OlmEncryptedEnvelope` (`FR-CHAT-014`, `NFR-REC-002`, `FR-SEC-028`).
   *
   * Never falls back to plaintext. Returns an explicit `OlmOperationFailure`
   * with a deterministic `code` and `state` when:
   * - protocol version is unknown or downgraded (`UNSUPPORTED_PROTOCOL_VERSION`)
   * - envelope is malformed, truncated, or tampered (`TAMPERED_ENVELOPE` / `INVALID_ENVELOPE`)
   * - recipient device or prekey/session state is missing (`MISSING_KEY_MATERIAL`)
   * - message is replayed (`REPLAYED_OR_DUPLICATE_MESSAGE`)
   */
  async decryptEnvelope(
    wire: unknown,
    context: OlmDecryptContext = {},
  ): Promise<OlmResult<OlmDecryptedMessage>> {
    try {
      return await this.lock.acquire(`olm:${this.deviceId}`, async () => {
        this.assertActive();

        const decodedResult = decodeOlmEncryptedEnvelope(wire);
        if (!decodedResult.ok) {
          return decodedResult;
        }
        const payload = decodedResult.value;
        assertSupportedProtocolVersion(payload.protocolVersion);

        const expectedRecipient = context.expectedRecipientDeviceId ?? this.deviceId;
        if (payload.recipientDeviceId !== expectedRecipient) {
          throw new OlmCryptoError(
            "MISSING_KEY_MATERIAL",
            "Encrypted envelope is addressed to a different device ID.",
          );
        }
        if (
          context.expectedPeerIdentityKey &&
          payload.senderIdentityKey !== context.expectedPeerIdentityKey
        ) {
          throw new OlmCryptoError(
            "PEER_KEY_MISMATCH",
            "Envelope senderIdentityKey does not match expected peer identity key.",
          );
        }
        if (
          context.expectedPeerSenderKey &&
          payload.senderCurve25519Key !== context.expectedPeerSenderKey
        ) {
          throw new OlmCryptoError(
            "PEER_KEY_MISMATCH",
            "Envelope senderCurve25519Key does not match expected peer sender key.",
          );
        }

        const ciphertextBytes = base64UrlDecode(payload.ciphertext);
        let sessionState = this.sessionsById.get(payload.sessionId);

        if (sessionState) {
          if (
            sessionState.meta.peerIdentityKey !== payload.senderIdentityKey ||
            sessionState.meta.peerSenderKey !== payload.senderCurve25519Key
          ) {
            throw new OlmCryptoError(
              "PEER_KEY_MISMATCH",
              "Envelope sender keys do not match the bound Olm session keys.",
            );
          }
          if (sessionState.seenIndices.has(payload.messageIndex)) {
            throw new OlmCryptoError(
              "REPLAYED_OR_DUPLICATE_MESSAGE",
              `Duplicate or replayed Olm messageIndex ${payload.messageIndex} in session ${payload.sessionId}.`,
            );
          }
          try {
            const decrypted = this.bridge.decrypt(
              sessionState.handle,
              payload.messageType,
              ciphertextBytes,
            );
            sessionState.seenIndices.add(payload.messageIndex);
            sessionState.meta.seenMessageIndices = Array.from(sessionState.seenIndices);
            sessionState.meta.inboundMessageCount += 1;
            sessionState.meta.consecutiveDecryptFailures = 0;
            this.stateRevision += 1;

            return {
              ok: true,
              value: {
                plaintext: decrypted.plaintext,
                sessionId: payload.sessionId,
                senderDeviceId: payload.senderDeviceId,
                recipientDeviceId: payload.recipientDeviceId,
                senderIdentityKey: payload.senderIdentityKey,
                senderCurve25519Key: payload.senderCurve25519Key,
                messageType: payload.messageType,
                messageIndex: payload.messageIndex,
                protocolVersion: OLM_PROTOCOL_VERSION,
              },
            };
          } catch (error) {
            sessionState.meta.consecutiveDecryptFailures += 1;
            if (
              sessionState.meta.consecutiveDecryptFailures >= OLM_MAX_CONSECUTIVE_DECRYPT_FAILURES
            ) {
              sessionState.meta.readOnly = true;
            }
            if (sessionState.seenIndices.has(payload.messageIndex)) {
              throw new OlmCryptoError(
                "REPLAYED_OR_DUPLICATE_MESSAGE",
                "Replayed Olm message rejected by Double Ratchet.",
              );
            }
            throw error;
          }
        }

        // No existing session with this sessionId: only a PreKey message can establish one.
        if (payload.messageType !== OLM_MESSAGE_TYPE_PREKEY) {
          throw new OlmCryptoError(
            "MISSING_KEY_MATERIAL",
            "No established Olm session for normal message; session key material is missing.",
          );
        }

        const peerUserId = context.peerUserId ?? `peer:${payload.senderDeviceId}`;
        const existingPeerState = this.peerKeyGuard.get(peerUserId);
        if (existingPeerState && existingPeerState.identityKey !== payload.senderIdentityKey) {
          this.peerKeyGuard.observe(peerUserId, payload.senderIdentityKey);
          throw new OlmCryptoError(
            "PEER_KEY_CHANGE_BLOCKED",
            "Inbound PreKey message comes from an unaccepted changed peer identity key.",
          );
        }
        if (!existingPeerState) {
          this.peerKeyGuard.observe(peerUserId, payload.senderIdentityKey);
        }

        const inbound = this.bridge.createInboundSession(
          this.accountHandle,
          payload.senderCurve25519Key,
          ciphertextBytes,
        );
        // Refresh unpublished one-time key view after prekey consumption.
        this.oneTimeKeys = this.bridge.getOneTimeKeys(this.accountHandle);

        const nowIso = this.now().toISOString();
        const meta: OlmSessionMetadata = {
          sessionId: inbound.sessionId,
          peerUserId,
          peerDeviceId: payload.senderDeviceId,
          peerIdentityKey: payload.senderIdentityKey,
          peerSenderKey: payload.senderCurve25519Key,
          createdAt: nowIso,
          outboundMessageCount: 0,
          inboundMessageCount: 1,
          consecutiveDecryptFailures: 0,
          readOnly: false,
          seenMessageIndices: [payload.messageIndex],
        };
        sessionState = {
          handle: inbound.sessionHandle,
          meta,
          seenIndices: new Set<number>([payload.messageIndex]),
        };
        this.sessionsById.set(inbound.sessionId, sessionState);
        const peerKey = `${peerUserId}:${payload.senderDeviceId}`;
        if (!this.activeOutboundByPeerDevice.has(peerKey)) {
          this.activeOutboundByPeerDevice.set(peerKey, inbound.sessionId);
        }
        this.stateRevision += 1;

        return {
          ok: true,
          value: {
            plaintext: inbound.plaintext,
            sessionId: inbound.sessionId,
            senderDeviceId: payload.senderDeviceId,
            recipientDeviceId: payload.recipientDeviceId,
            senderIdentityKey: payload.senderIdentityKey,
            senderCurve25519Key: payload.senderCurve25519Key,
            messageType: OLM_MESSAGE_TYPE_PREKEY,
            messageIndex: payload.messageIndex,
            protocolVersion: OLM_PROTOCOL_VERSION,
          },
        };
      });
    } catch (error) {
      return olmFailure(error);
    }
  }

  /**
   * Seal the Olm account and all sessions into an AES-256-GCM encrypted bundle
   * wrapped by the non-extractable `storageKey` (`FR-SEC-006`, `DEC-002` §4.5).
   *
   * Two-layer protection:
   * 1. `vodozemac` encrypts each account/session pickle with a random 32-byte key.
   * 2. Web Crypto AES-256-GCM encrypts the bundle with the non-extractable `CryptoKey`
   *    and binds `deviceId`, `identityKey`, `senderKey`, and `stateRevision` as AAD.
   */
  async sealState(): Promise<SealedOlmStateBundle> {
    return this.lock.acquire(`olm:${this.deviceId}`, async () => {
      this.assertActive();
      assertStorageKeyNonExtractable(this.storageKey);

      const pickleKey = randomBytes(32);
      const iv = randomBytes(12);
      try {
        const accountPickle = this.bridge.pickleAccount(this.accountHandle, pickleKey);
        const sessions: SealedInnerPayload["sessions"] = [];
        for (const session of this.sessionsById.values()) {
          const pickled = this.bridge.pickleSession(session.handle, pickleKey);
          sessions.push({
            pickle: pickled.pickle,
            meta: {
              ...session.meta,
              seenMessageIndices: Array.from(session.seenIndices),
            },
          });
        }

        const inner: SealedInnerPayload = {
          schemaVersion: 1,
          protocolVersion: OLM_PROTOCOL_VERSION,
          deviceId: this.deviceId,
          identityKey: this.identityKey,
          senderKey: this.senderKey,
          stateRevision: this.stateRevision,
          pickleKeyBase64Url: base64UrlEncode(pickleKey),
          accountPickle,
          fallbackKey: { ...this.fallbackKey },
          fallbackPublishedAt: this.fallbackPublishedAt,
          oneTimeKeys: this.oneTimeKeys.map((k) => ({ ...k })),
          sessions,
        };

        const aad = new TextEncoder().encode(
          `${OLM_PROTOCOL_VERSION}|${this.deviceId}|${this.identityKey}|${this.senderKey}|${this.stateRevision}`,
        );
        const plaintextBytes = new TextEncoder().encode(JSON.stringify(inner));
        const encryptedBuffer = await globalThis.crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: iv as Uint8Array<ArrayBuffer>,
            additionalData: aad,
            tagLength: 128,
          },
          this.storageKey,
          plaintextBytes,
        );

        this.lastKnownSavedRevision = Math.max(this.lastKnownSavedRevision, this.stateRevision);

        const sealed: SealedOlmStateBundle = {
          schemaVersion: 1,
          protocolVersion: OLM_PROTOCOL_VERSION,
          deviceId: this.deviceId,
          identityKey: this.identityKey,
          senderKey: this.senderKey,
          stateRevision: this.stateRevision,
          sealedAt: this.now().toISOString(),
          iv: base64UrlEncode(iv),
          ciphertext: base64UrlEncode(encryptedBuffer),
        };
        const forbidden = findEnvelopeForbiddenField(sealed);
        if (forbidden) {
          throw new OlmCryptoError(
            "FORBIDDEN_FIELD",
            `Forbidden field in sealed state: ${forbidden}`,
          );
        }
        return sealed;
      } finally {
        pickleKey.fill(0);
      }
    });
  }

  /**
   * Restore an `OlmAccountDevice` from a sealed AES-256-GCM state bundle,
   * rejecting tampered ciphertexts, wrong storage keys, and rolled-back
   * state revisions (`FR-SEC-006`, `DEC-018`, `TC-SEC-002`).
   */
  static async unsealState(
    sealed: SealedOlmStateBundle,
    storageKey: CryptoKey,
    options: Omit<CreateOlmAccountDeviceOptions, "deviceId" | "storageKey"> & {
      minExpectedRevision?: number;
    } = {},
  ): Promise<OlmResult<OlmAccountDevice>> {
    try {
      assertStorageKeyNonExtractable(storageKey);
      if (!sealed || typeof sealed !== "object") {
        throw new OlmCryptoError("INVALID_ENVELOPE", "Sealed Olm state bundle is missing.");
      }
      assertSupportedProtocolVersion(sealed.protocolVersion);
      if (
        options.minExpectedRevision !== undefined &&
        sealed.stateRevision < options.minExpectedRevision
      ) {
        throw new OlmCryptoError(
          "SESSION_ROLLBACK_DETECTED",
          `Olm state rollback detected: bundle revision ${sealed.stateRevision} < expected ${options.minExpectedRevision}.`,
        );
      }

      const iv = base64UrlDecode(sealed.iv);
      const ciphertext = base64UrlDecode(sealed.ciphertext);
      const aad = new TextEncoder().encode(
        `${OLM_PROTOCOL_VERSION}|${sealed.deviceId}|${sealed.identityKey}|${sealed.senderKey}|${sealed.stateRevision}`,
      );

      let decryptedBuffer: ArrayBuffer;
      try {
        decryptedBuffer = await globalThis.crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: iv as Uint8Array<ArrayBuffer>,
            additionalData: aad,
            tagLength: 128,
          },
          storageKey,
          ciphertext as Uint8Array<ArrayBuffer>,
        );
      } catch {
        throw new OlmCryptoError(
          "PICKLE_DECRYPTION_FAILED",
          "Failed to unwrap sealed Olm state bundle with storage CryptoKey.",
        );
      }

      const inner = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(decryptedBuffer),
      ) as SealedInnerPayload;

      if (
        inner.deviceId !== sealed.deviceId ||
        inner.identityKey !== sealed.identityKey ||
        inner.senderKey !== sealed.senderKey ||
        inner.stateRevision !== sealed.stateRevision
      ) {
        throw new OlmCryptoError(
          "TAMPERED_ENVELOPE",
          "Sealed Olm state inner header does not match authenticated AAD.",
        );
      }

      const pickleKey = base64UrlDecode(inner.pickleKeyBase64Url);
      try {
        const bridge = await OlmWasmBridge.create(options);
        const restoredAccount = bridge.unpickleAccount(inner.accountPickle, pickleKey);
        if (
          restoredAccount.identityKey !== sealed.identityKey ||
          restoredAccount.senderKey !== sealed.senderKey
        ) {
          bridge.freeAccount(restoredAccount.accountHandle);
          throw new OlmCryptoError(
            "TAMPERED_ENVELOPE",
            "Restored Olm account public keys do not match sealed metadata.",
          );
        }

        const nowFn = options.now ?? (() => new Date());
        const device = new OlmAccountDevice(
          bridge,
          restoredAccount.accountHandle,
          sealed.deviceId,
          restoredAccount.identityKey,
          restoredAccount.senderKey,
          restoredAccount.maxOneTimeKeys,
          storageKey,
          options.lock ?? new InProcessSingleWriterLock(),
          options.peerKeyGuard ?? new PeerKeyGuard(undefined, nowFn),
          nowFn,
          inner.fallbackKey,
          inner.fallbackPublishedAt,
          inner.oneTimeKeys,
        );
        device.stateRevision = sealed.stateRevision;
        device.lastKnownSavedRevision = sealed.stateRevision;

        for (const entry of inner.sessions) {
          const restoredSession = bridge.unpickleSession(entry.pickle, pickleKey);
          const sessionState: InternalSessionState = {
            handle: restoredSession.sessionHandle,
            meta: {
              ...entry.meta,
              seenMessageIndices: [...entry.meta.seenMessageIndices],
            },
            seenIndices: new Set<number>(entry.meta.seenMessageIndices),
          };
          device.sessionsById.set(restoredSession.sessionId, sessionState);
          if (!entry.meta.readOnly) {
            const peerKey = `${entry.meta.peerUserId}:${entry.meta.peerDeviceId}`;
            device.activeOutboundByPeerDevice.set(peerKey, restoredSession.sessionId);
          }
        }

        return { ok: true, value: device };
      } finally {
        pickleKey.fill(0);
      }
    } catch (error) {
      return olmFailure(error);
    }
  }

  getSessionMetadata(sessionId: string): OlmSessionMetadata | null {
    const state = this.sessionsById.get(sessionId);
    if (!state) return null;
    return {
      ...state.meta,
      seenMessageIndices: Array.from(state.seenIndices),
    };
  }

  listSessions(): OlmSessionMetadata[] {
    return Array.from(this.sessionsById.values()).map((s) => ({
      ...s.meta,
      seenMessageIndices: Array.from(s.seenIndices),
    }));
  }

  /**
   * Explicitly zeroize and drop all WASM account and session handles (e.g., on logout/revocation).
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const session of this.sessionsById.values()) {
      try {
        this.bridge.freeSession(session.handle);
      } catch {
        // Ignore already-freed handles during teardown.
      }
    }
    this.sessionsById.clear();
    this.activeOutboundByPeerDevice.clear();
    if (this.accountHandle > 0) {
      try {
        this.bridge.freeAccount(this.accountHandle);
      } catch {
        // Ignore already-freed handles during teardown.
      }
      this.accountHandle = 0;
    }
  }
}
