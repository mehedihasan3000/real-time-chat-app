import { MESSAGE_FORBIDDEN_FIELDS, type MessageProtocolVersion } from "@chat/contracts";
import { base64UrlDecode, base64UrlEncode, randomBytes } from "../device/encoding.js";

/**
 * AES-256-GCM sealing/unsealing primitives and plaintext/key-reuse guards
 * for the offline encrypted outbox (`P2-09`, `FR-CHAT-008`, `DATA-013`,
 * `DEC-021` §6.1).
 *
 * Security invariants enforced here:
 * - Outbox entries are sealed at rest with a dedicated non-extractable
 *   AES-256-GCM `CryptoKey` that is distinct from any Olm protocol-state key.
 * - Authenticated Additional Data (AAD) binds `accountId`, `conversationId`,
 *   `clientMessageId`, `senderDeviceId`, `protocolVersion`, `payloadHash`,
 *   `keyId`, `createdAtMs`, `updatedAtMs`, and `schemaVersion`.
 * - Plaintext message fields and private key fields are rejected deeply on both
 *   outer metadata and inner sealed records before encryption or after unseal.
 */

export const OUTBOX_SEAL_DOMAIN = "chat.outbox.sealed.v1" as const;
export const OUTBOX_SEAL_SCHEMA_VERSION = 1 as const;
export const OUTBOX_AES_GCM_IV_BYTES = 12;
export const OUTBOX_AES_GCM_TAG_BITS = 128;

export type OutboxCryptoErrorCode =
  | "INVALID_STORAGE_KEY"
  | "KEY_REUSE_FORBIDDEN"
  | "FORBIDDEN_PLAINTEXT_FIELD"
  | "CORRUPT_SEALED_ENTRY"
  | "ACCOUNT_MISMATCH"
  | "WEB_CRYPTO_UNAVAILABLE";

export class OutboxCryptoError extends Error {
  constructor(
    readonly code: OutboxCryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OutboxCryptoError";
  }
}

export interface OutboxSealMetadata {
  schemaVersion: 1;
  accountId: string;
  conversationId: string;
  clientMessageId: string;
  senderDeviceId: string;
  protocolVersion: MessageProtocolVersion;
  payloadHash: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SealedOutboxEntryRecord extends OutboxSealMetadata {
  storageKey: string;
  keyId: string;
  iv: string;
  ciphertext: string;
}

const OUTBOX_FORBIDDEN_FIELD_SET = new Set<string>([
  ...MESSAGE_FORBIDDEN_FIELDS,
  "message",
  "html",
  "markdown",
  "smartReplies",
  "privateKey",
  "private_key",
  "recoveryKey",
  "recovery_key",
  "pickle",
  "accountPickle",
  "pickleKeyBase64Url",
  "secretKey",
  "seed",
  "mnemonic",
]);

function resolveSubtleCrypto(subtle?: SubtleCrypto | null): SubtleCrypto {
  const resolved = subtle === undefined ? globalThis.crypto?.subtle : subtle;
  if (!resolved) {
    throw new OutboxCryptoError(
      "WEB_CRYPTO_UNAVAILABLE",
      "Web Crypto SubtleCrypto API is unavailable in this browser context (DEC-009).",
    );
  }
  return resolved;
}

function findForbiddenOutboxFieldRecursive(
  value: unknown,
  seen = new WeakSet<object>(),
): string | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findForbiddenOutboxFieldRecursive(item, seen);
      if (hit) return hit;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (OUTBOX_FORBIDDEN_FIELD_SET.has(key)) {
      return key;
    }
    const child = record[key];
    if (key === "encryptedEnvelope" && typeof child === "string") {
      validateEncodedOlmEnvelopeObject(child);
    }
    const hit = findForbiddenOutboxFieldRecursive(child, seen);
    if (hit) return hit;
  }
  return null;
}

function validateEncodedOlmEnvelopeObject(encoded: string): void {
  let parsed: unknown;
  try {
    const rawBytes = base64UrlDecode(encoded);
    const json = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
    parsed = JSON.parse(json);
  } catch {
    throw new OutboxCryptoError(
      "CORRUPT_SEALED_ENTRY",
      "Encrypted envelope inside outbox entry is not valid base64url UTF-8 JSON.",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new OutboxCryptoError(
      "CORRUPT_SEALED_ENTRY",
      "Decoded encrypted envelope inside outbox entry must be an object.",
    );
  }

  const envelopeHit = findForbiddenOutboxFieldRecursive(parsed);
  if (envelopeHit) {
    throw new OutboxCryptoError(
      "FORBIDDEN_PLAINTEXT_FIELD",
      `Forbidden plaintext or secret key "${envelopeHit}" detected inside decoded encryptedEnvelope.`,
    );
  }

  const record = parsed as Record<string, unknown>;
  if (typeof record.ciphertext !== "string" || record.ciphertext.length === 0) {
    throw new OutboxCryptoError(
      "CORRUPT_SEALED_ENTRY",
      "Decoded encryptedEnvelope in outbox must contain non-empty ciphertext.",
    );
  }
}

/**
 * Generates a dedicated non-extractable AES-256-GCM `CryptoKey` for IndexedDB
 * outbox encryption (`DEC-021` §6.1). Must never reuse the Olm storage key.
 */
export async function generateOutboxStorageKey(subtle?: SubtleCrypto | null): Promise<CryptoKey> {
  const api = resolveSubtleCrypto(subtle);
  return api.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/**
 * Verifies that `key` is a non-extractable AES-256-GCM secret key usable for
 * encrypt/decrypt and is strictly distinct from forbidden keys (such as Olm state keys).
 */
export function assertValidOutboxStorageKey(
  key: unknown,
  options?: { forbiddenKeys?: readonly CryptoKey[] },
): asserts key is CryptoKey {
  if (typeof key !== "object" || key === null) {
    throw new OutboxCryptoError("INVALID_STORAGE_KEY", "Outbox storage key is missing.");
  }

  const candidate = key as CryptoKey;
  if (candidate.type !== "secret") {
    throw new OutboxCryptoError("INVALID_STORAGE_KEY", "Outbox storage key must be a secret key.");
  }
  if (candidate.extractable !== false) {
    throw new OutboxCryptoError(
      "INVALID_STORAGE_KEY",
      "Outbox IndexedDB storage CryptoKey must be non-extractable (DEC-021 §6.1).",
    );
  }

  const alg = candidate.algorithm as { name?: unknown; length?: unknown } | undefined;
  if (alg?.name !== "AES-GCM" || (typeof alg.length === "number" && alg.length !== 256)) {
    throw new OutboxCryptoError(
      "INVALID_STORAGE_KEY",
      "Outbox storage key must use 256-bit AES-GCM.",
    );
  }

  const usages = candidate.usages;
  if (!Array.isArray(usages) || !usages.includes("encrypt") || !usages.includes("decrypt")) {
    throw new OutboxCryptoError(
      "INVALID_STORAGE_KEY",
      "Outbox storage key must allow both encrypt and decrypt usages.",
    );
  }

  if (options?.forbiddenKeys?.some((forbidden) => forbidden === candidate)) {
    throw new OutboxCryptoError(
      "KEY_REUSE_FORBIDDEN",
      "Outbox storage key must not reuse the Olm protocol-state CryptoKey (DEC-021 §6.1).",
    );
  }
}

/**
 * Recursively asserts that `value` contains no plaintext message fields,
 * private key fields, or malformed/plaintext-tainted `encryptedEnvelope` payloads.
 */
export function assertNoOutboxPlaintextOrSecrets(value: unknown): void {
  const forbidden = findForbiddenOutboxFieldRecursive(value);
  if (forbidden) {
    throw new OutboxCryptoError(
      "FORBIDDEN_PLAINTEXT_FIELD",
      `Forbidden plaintext or secret key "${forbidden}" is prohibited in outbox storage (DATA-013).`,
    );
  }
}

export function buildOutboxEntryAad(meta: OutboxSealMetadata, keyId: string): Uint8Array {
  return new TextEncoder().encode(
    `${OUTBOX_SEAL_DOMAIN}|${meta.schemaVersion}|${keyId}|${meta.accountId}|${meta.conversationId}|${meta.clientMessageId}|${meta.senderDeviceId}|${meta.protocolVersion}|${meta.payloadHash}|${meta.createdAtMs}|${meta.updatedAtMs}`,
  );
}

/**
 * Seals an inner outbox record using AES-256-GCM with AAD bound to outer metadata.
 */
export async function sealOutboxEntry<TInner>(input: {
  meta: OutboxSealMetadata;
  keyId: string;
  key: CryptoKey;
  inner: TInner;
  forbiddenReuseKeys?: readonly CryptoKey[];
  subtle?: SubtleCrypto | null;
}): Promise<SealedOutboxEntryRecord> {
  const subtle = resolveSubtleCrypto(input.subtle);
  assertValidOutboxStorageKey(input.key, { forbiddenKeys: input.forbiddenReuseKeys });
  assertNoOutboxPlaintextOrSecrets(input.meta);
  assertNoOutboxPlaintextOrSecrets(input.inner);

  if (input.meta.schemaVersion !== OUTBOX_SEAL_SCHEMA_VERSION) {
    throw new OutboxCryptoError(
      "CORRUPT_SEALED_ENTRY",
      `Unsupported outbox seal schemaVersion: ${String(input.meta.schemaVersion)}.`,
    );
  }

  const iv = randomBytes(OUTBOX_AES_GCM_IV_BYTES);
  const aad = buildOutboxEntryAad(input.meta, input.keyId);
  const plaintextBytes = new TextEncoder().encode(JSON.stringify(input.inner));

  const encryptedBuffer = await subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as Uint8Array<ArrayBuffer>,
      additionalData: aad as Uint8Array<ArrayBuffer>,
      tagLength: OUTBOX_AES_GCM_TAG_BITS,
    },
    input.key,
    plaintextBytes as Uint8Array<ArrayBuffer>,
  );

  return {
    schemaVersion: OUTBOX_SEAL_SCHEMA_VERSION,
    storageKey: `${input.meta.accountId}:${input.meta.clientMessageId}`,
    keyId: input.keyId,
    accountId: input.meta.accountId,
    conversationId: input.meta.conversationId,
    clientMessageId: input.meta.clientMessageId,
    senderDeviceId: input.meta.senderDeviceId,
    protocolVersion: input.meta.protocolVersion,
    payloadHash: input.meta.payloadHash,
    createdAtMs: input.meta.createdAtMs,
    updatedAtMs: input.meta.updatedAtMs,
    iv: base64UrlEncode(iv),
    ciphertext: base64UrlEncode(encryptedBuffer),
  };
}

/**
 * Unseals and authenticates a sealed IndexedDB outbox entry, rejecting tampered
 * ciphertext, modified metadata AAD, wrong keys, account mismatches, or plaintext leaks.
 */
export async function unsealOutboxEntry<TInner>(input: {
  sealed: SealedOutboxEntryRecord;
  expectedAccountId: string;
  expectedKeyId?: string;
  key: CryptoKey;
  forbiddenReuseKeys?: readonly CryptoKey[];
  subtle?: SubtleCrypto | null;
}): Promise<TInner> {
  const subtle = resolveSubtleCrypto(input.subtle);
  assertValidOutboxStorageKey(input.key, { forbiddenKeys: input.forbiddenReuseKeys });

  const { sealed } = input;
  if (!sealed || typeof sealed !== "object") {
    throw new OutboxCryptoError("CORRUPT_SEALED_ENTRY", "Sealed outbox record is missing.");
  }
  if (sealed.schemaVersion !== OUTBOX_SEAL_SCHEMA_VERSION) {
    throw new OutboxCryptoError(
      "CORRUPT_SEALED_ENTRY",
      `Unsupported sealed outbox schemaVersion: ${String(sealed.schemaVersion)}.`,
    );
  }
  if (sealed.accountId !== input.expectedAccountId) {
    throw new OutboxCryptoError(
      "ACCOUNT_MISMATCH",
      "Sealed outbox entry belongs to a different account.",
    );
  }
  if (sealed.storageKey !== `${sealed.accountId}:${sealed.clientMessageId}`) {
    throw new OutboxCryptoError(
      "CORRUPT_SEALED_ENTRY",
      "Sealed outbox storageKey does not match entry identity.",
    );
  }
  if (input.expectedKeyId !== undefined && sealed.keyId !== input.expectedKeyId) {
    throw new OutboxCryptoError(
      "CORRUPT_SEALED_ENTRY",
      "Sealed outbox keyId does not match the active account storage key.",
    );
  }

  let ivBytes: Uint8Array;
  let ciphertextBytes: Uint8Array;
  try {
    ivBytes = base64UrlDecode(sealed.iv);
    ciphertextBytes = base64UrlDecode(sealed.ciphertext);
  } catch {
    throw new OutboxCryptoError(
      "CORRUPT_SEALED_ENTRY",
      "Sealed outbox iv/ciphertext encoding is invalid.",
    );
  }
  if (ivBytes.byteLength !== OUTBOX_AES_GCM_IV_BYTES || ciphertextBytes.byteLength < 16) {
    throw new OutboxCryptoError(
      "CORRUPT_SEALED_ENTRY",
      "Sealed outbox iv or ciphertext length is invalid.",
    );
  }

  const aad = buildOutboxEntryAad(sealed, sealed.keyId);
  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: ivBytes as Uint8Array<ArrayBuffer>,
        additionalData: aad as Uint8Array<ArrayBuffer>,
        tagLength: OUTBOX_AES_GCM_TAG_BITS,
      },
      input.key,
      ciphertextBytes as Uint8Array<ArrayBuffer>,
    );
  } catch {
    throw new OutboxCryptoError(
      "CORRUPT_SEALED_ENTRY",
      "Sealed outbox AES-256-GCM authentication check failed.",
    );
  }

  let parsed: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(decryptedBuffer);
    parsed = JSON.parse(json);
  } catch {
    throw new OutboxCryptoError(
      "CORRUPT_SEALED_ENTRY",
      "Decrypted outbox payload is not valid UTF-8 JSON.",
    );
  }

  assertNoOutboxPlaintextOrSecrets(parsed);
  return parsed as TInner;
}
