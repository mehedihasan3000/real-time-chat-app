/**
 * Device public-key directory contracts v0 (P2-01, DEC-002/003/004/018).
 *
 * Provisional under Release-gated DEC-023. P2-01 publishes only PUBLIC
 * material: an Ed25519 identity key, a Curve25519 sender key, one-time
 * prekeys, and a fallback key. No private key, recovery key, archive, or
 * plaintext field is accepted or returned.
 *
 * `dev-webcrypto-v0` is an explicitly provisional identity provider used
 * until P2-02 integrates the approved Olm/vodozemac WASM account. It makes
 * no E2EE claim and is not an Olm protocol implementation.
 */
import { checkSchemaVersion, type ValidationResult } from "./v0.js";

export const DEVICE_KEY_SCHEMA_VERSION = 1;

export const DEVICE_KEY_ALGORITHMS = ["dev-webcrypto-v0"] as const;
export type DeviceKeyAlgorithm = (typeof DEVICE_KEY_ALGORITHMS)[number];

/** Opaque client-generated device reference. */
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
/** Base64url-encoded 32-byte public key (Ed25519 or Curve25519). */
export const PUBLIC_KEY_RE = /^[A-Za-z0-9_-]{43}$/;
/** Opaque key identifier scoped to one device bundle. */
export const KEY_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const ONE_TIME_KEYS_MIN = 1;
export const ONE_TIME_KEYS_MAX = 100;
export const FALLBACK_KEY_MAX_AGE_DAYS = 30;

export const DEVICE_STATUSES = ["active", "revoked", "replaced"] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export const DEVICE_REVOCATION_REASONS = [
  "logout",
  "replacement",
  "reset",
  "loss",
  "compromise",
] as const;
export type DeviceRevocationReason = (typeof DEVICE_REVOCATION_REASONS)[number];

export const DEVICE_REPLACEMENT_MODES = ["restore", "reset"] as const;
export type DeviceReplacementMode = (typeof DEVICE_REPLACEMENT_MODES)[number];

export const KEY_BACKUP_ARCHIVE_FORMAT = "aes-256-gcm+hkdf-sha256" as const;

/**
 * Field names that must never appear in a directory request/response.
 * Tests and evidence use this list to prove the boundary, not as the only
 * defence: every validator below rejects unknown fields.
 */
export const DEVICE_FORBIDDEN_FIELDS = [
  "privateKey",
  "privateKeys",
  "secretKey",
  "seed",
  "recoveryKey",
  "archive",
  "ciphertext",
  "plaintext",
  "manifest",
] as const;

export interface DevicePublicKey {
  keyId: string;
  key: string;
}

export interface DeviceFallbackKeyState extends DevicePublicKey {
  /** Server-assigned publication time. */
  publishedAt: string;
  /** Server-assigned rotation deadline (30 days after publication). */
  expiresAt: string;
}

/** Client upload shape. Contains public material only. */
export interface DevicePublicKeyBundle {
  schemaVersion: 1;
  algorithm: DeviceKeyAlgorithm;
  deviceId: string;
  identityKey: string;
  senderKey: string;
  oneTimeKeys: DevicePublicKey[];
  fallbackKey: DevicePublicKey;
}

/** Owner-visible server record after publication. */
export interface DeviceKeyBundle {
  schemaVersion: 1;
  algorithm: DeviceKeyAlgorithm;
  userId: string;
  deviceId: string;
  identityKey: string;
  senderKey: string;
  oneTimeKeys: DevicePublicKey[];
  fallbackKey: DeviceFallbackKeyState;
  publishedAt: string;
  updatedAt: string;
}

/** Peer-visible active directory entry. No owner metadata or backup link. */
export interface DeviceDirectoryEntry {
  userId: string;
  deviceId: string;
  schemaVersion: 1;
  algorithm: DeviceKeyAlgorithm;
  identityKey: string;
  senderKey: string;
  oneTimeKeys: DevicePublicKey[];
  fallbackKey: DeviceFallbackKeyState;
  publishedAt: string;
}

export interface DeviceSummary {
  deviceId: string;
  isActive: boolean;
  status: DeviceStatus;
  algorithm: DeviceKeyAlgorithm;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  replacedByDeviceId: string | null;
  backupLinked: boolean;
}

export interface DeviceListResponse {
  items: DeviceSummary[];
}

export interface DeviceReplacement {
  previousDeviceId: string;
  mode: DeviceReplacementMode;
  /** Explicit history-loss/replacement acknowledgement (DEC-002). */
  acknowledgeHistoryLoss: true;
}

export interface DeviceEnrollmentRequest {
  bundle: DevicePublicKeyBundle;
  replace?: DeviceReplacement;
}

export interface DeviceEnrollmentResponse {
  device: DeviceKeyBundle;
  replacedDeviceId: string | null;
  /** The client must offer/confirm an encrypted recovery archive (DEC-003). */
  backupRequired: true;
}

export interface DeviceKeyResponse {
  device: DeviceKeyBundle;
  backupLink: KeyBackupLink | null;
}

export interface DevicePublicKeysResponse {
  userId: string;
  device: DeviceDirectoryEntry;
}

export interface DeviceRevocationRequest {
  reason: DeviceRevocationReason;
}

export interface DeviceRevocationResponse {
  deviceId: string;
  status: DeviceStatus;
  revokedAt: string;
  replacedByDeviceId: string | null;
}

/**
 * Metadata-only linkage between a device and an opaque recovery archive.
 * The recovery key and archive bytes never appear here; P2-17 owns the
 * opaque upload/download flow.
 */
export interface KeyBackupLink {
  backupId: string;
  kid: string;
  archiveFormat: typeof KEY_BACKUP_ARCHIVE_FORMAT;
  schemaVersion: 1;
  createdAt: string;
}

export interface KeyBackupLinkRequest {
  deviceId: string;
  backupId: string;
  kid: string;
  archiveFormat: typeof KEY_BACKUP_ARCHIVE_FORMAT;
  schemaVersion: 1;
}

export interface KeyBackupLinkResponse {
  deviceId: string;
  link: KeyBackupLink;
}

const BUNDLE_FIELDS = new Set([
  "schemaVersion",
  "algorithm",
  "deviceId",
  "identityKey",
  "senderKey",
  "oneTimeKeys",
  "fallbackKey",
]);
const PUBLIC_KEY_FIELDS = new Set(["keyId", "key"]);
const FALLBACK_STATE_FIELDS = new Set(["keyId", "key", "publishedAt", "expiresAt"]);
const OWNER_BUNDLE_FIELDS = new Set([
  "schemaVersion",
  "algorithm",
  "userId",
  "deviceId",
  "identityKey",
  "senderKey",
  "oneTimeKeys",
  "fallbackKey",
  "publishedAt",
  "updatedAt",
]);
const DIRECTORY_ENTRY_FIELDS = new Set([
  "userId",
  "deviceId",
  "schemaVersion",
  "algorithm",
  "identityKey",
  "senderKey",
  "oneTimeKeys",
  "fallbackKey",
  "publishedAt",
]);
const DEVICE_SUMMARY_FIELDS = new Set([
  "deviceId",
  "isActive",
  "status",
  "algorithm",
  "createdAt",
  "updatedAt",
  "revokedAt",
  "replacedByDeviceId",
  "backupLinked",
]);
const ENROLLMENT_FIELDS = new Set(["bundle", "replace"]);
const REPLACEMENT_FIELDS = new Set(["previousDeviceId", "mode", "acknowledgeHistoryLoss"]);
const REVOCATION_FIELDS = new Set(["reason"]);
const BACKUP_LINK_FIELDS = new Set([
  "deviceId",
  "backupId",
  "kid",
  "archiveFormat",
  "schemaVersion",
]);

function invalid(message: string): ValidationResult<never> {
  return { ok: false, code: "INVALID_REQUEST", message, retryable: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyFields(record: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID_RE.test(value);
}

export function isPublicKey(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_KEY_RE.test(value);
}

export function isKeyId(value: unknown): value is string {
  return typeof value === "string" && KEY_ID_RE.test(value);
}

function validatePublicKey(value: unknown, label: string): ValidationResult<DevicePublicKey> {
  if (!isRecord(value) || !hasOnlyFields(value, PUBLIC_KEY_FIELDS)) {
    return invalid(`${label} must contain only keyId and key.`);
  }
  if (!isKeyId(value.keyId)) {
    return invalid(`${label}.keyId is invalid.`);
  }
  if (!isPublicKey(value.key)) {
    return invalid(`${label}.key must be a base64url 32-byte public key.`);
  }
  return { ok: true, value: { keyId: value.keyId, key: value.key } };
}

export function validateDevicePublicKeyBundle(
  input: unknown,
  expectedDeviceId?: string,
): ValidationResult<DevicePublicKeyBundle> {
  if (!isRecord(input) || !hasOnlyFields(input, BUNDLE_FIELDS)) {
    return invalid("Device key bundle contains unsupported fields.");
  }

  const version = checkSchemaVersion(input.schemaVersion);
  if (!version.ok) {
    return {
      ok: false,
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `Unsupported schemaVersion. Expected ${DEVICE_KEY_SCHEMA_VERSION}.`,
      retryable: false,
    };
  }

  if (
    typeof input.algorithm !== "string" ||
    !(DEVICE_KEY_ALGORITHMS as readonly string[]).includes(input.algorithm)
  ) {
    return invalid("Device key algorithm is not supported.");
  }

  if (!isDeviceId(input.deviceId)) {
    return invalid("deviceId is invalid.");
  }
  if (expectedDeviceId !== undefined && input.deviceId !== expectedDeviceId) {
    return invalid("deviceId must match the route parameter.");
  }
  if (!isPublicKey(input.identityKey)) {
    return invalid("identityKey must be a base64url 32-byte public key.");
  }
  if (!isPublicKey(input.senderKey)) {
    return invalid("senderKey must be a base64url 32-byte public key.");
  }

  if (!Array.isArray(input.oneTimeKeys)) {
    return invalid("oneTimeKeys must be an array.");
  }
  if (
    input.oneTimeKeys.length < ONE_TIME_KEYS_MIN ||
    input.oneTimeKeys.length > ONE_TIME_KEYS_MAX
  ) {
    return invalid(`oneTimeKeys must contain ${ONE_TIME_KEYS_MIN}..${ONE_TIME_KEYS_MAX} keys.`);
  }

  const keyIds = new Set<string>();
  const oneTimeKeys: DevicePublicKey[] = [];
  for (const [index, candidate] of input.oneTimeKeys.entries()) {
    const validated = validatePublicKey(candidate, `oneTimeKeys[${index}]`);
    if (!validated.ok) return validated;
    if (keyIds.has(validated.value.keyId)) {
      return invalid("Key identifiers must be unique within a device bundle.");
    }
    keyIds.add(validated.value.keyId);
    oneTimeKeys.push(validated.value);
  }

  const fallback = validatePublicKey(input.fallbackKey, "fallbackKey");
  if (!fallback.ok) return fallback;
  if (keyIds.has(fallback.value.keyId)) {
    return invalid("fallbackKey.keyId must be unique within a device bundle.");
  }

  return {
    ok: true,
    value: {
      schemaVersion: DEVICE_KEY_SCHEMA_VERSION,
      algorithm: input.algorithm as DeviceKeyAlgorithm,
      deviceId: input.deviceId,
      identityKey: input.identityKey,
      senderKey: input.senderKey,
      oneTimeKeys,
      fallbackKey: fallback.value,
    },
  };
}

export function validateDeviceEnrollmentRequest(
  input: unknown,
  expectedDeviceId?: string,
): ValidationResult<DeviceEnrollmentRequest> {
  if (!isRecord(input) || !hasOnlyFields(input, ENROLLMENT_FIELDS)) {
    return invalid("Enrollment request contains unsupported fields.");
  }

  const bundle = validateDevicePublicKeyBundle(input.bundle, expectedDeviceId);
  if (!bundle.ok) return bundle;

  if (input.replace === undefined) {
    return { ok: true, value: { bundle: bundle.value } };
  }

  if (!isRecord(input.replace) || !hasOnlyFields(input.replace, REPLACEMENT_FIELDS)) {
    return invalid("replace contains unsupported fields.");
  }
  if (!isDeviceId(input.replace.previousDeviceId)) {
    return invalid("replace.previousDeviceId is invalid.");
  }
  if (input.replace.previousDeviceId === bundle.value.deviceId) {
    return invalid("A device cannot replace itself.");
  }
  if (
    typeof input.replace.mode !== "string" ||
    !(DEVICE_REPLACEMENT_MODES as readonly string[]).includes(input.replace.mode)
  ) {
    return invalid("replace.mode must be restore or reset.");
  }
  if (input.replace.acknowledgeHistoryLoss !== true) {
    return invalid("Replacing a device requires explicit history-loss acknowledgement.");
  }

  return {
    ok: true,
    value: {
      bundle: bundle.value,
      replace: {
        previousDeviceId: input.replace.previousDeviceId,
        mode: input.replace.mode as DeviceReplacementMode,
        acknowledgeHistoryLoss: true,
      },
    },
  };
}

export function validateDeviceRevocationRequest(
  input: unknown,
): ValidationResult<DeviceRevocationRequest> {
  if (!isRecord(input) || !hasOnlyFields(input, REVOCATION_FIELDS)) {
    return invalid("Revocation request contains unsupported fields.");
  }
  if (
    typeof input.reason !== "string" ||
    !(DEVICE_REVOCATION_REASONS as readonly string[]).includes(input.reason)
  ) {
    return invalid("reason must be an approved revocation reason.");
  }
  return { ok: true, value: { reason: input.reason as DeviceRevocationReason } };
}

export function validateKeyBackupLinkRequest(
  input: unknown,
): ValidationResult<KeyBackupLinkRequest> {
  if (!isRecord(input) || !hasOnlyFields(input, BACKUP_LINK_FIELDS)) {
    return invalid("Key-backup link contains unsupported fields.");
  }
  if (!isDeviceId(input.deviceId)) {
    return invalid("deviceId is invalid.");
  }
  if (!isDeviceId(input.backupId)) {
    return invalid("backupId is invalid.");
  }
  if (!isKeyId(input.kid)) {
    return invalid("kid is invalid.");
  }
  if (input.archiveFormat !== KEY_BACKUP_ARCHIVE_FORMAT) {
    return invalid("archiveFormat is not supported.");
  }
  const version = checkSchemaVersion(input.schemaVersion);
  if (!version.ok) {
    return {
      ok: false,
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `Unsupported schemaVersion. Expected ${DEVICE_KEY_SCHEMA_VERSION}.`,
      retryable: false,
    };
  }
  return {
    ok: true,
    value: {
      deviceId: input.deviceId,
      backupId: input.backupId,
      kid: input.kid,
      archiveFormat: KEY_BACKUP_ARCHIVE_FORMAT,
      schemaVersion: DEVICE_KEY_SCHEMA_VERSION,
    },
  };
}

function isUserId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validatePublicKeyList(
  value: unknown,
  label: string,
  min: number,
  max: number,
): ValidationResult<DevicePublicKey[]> {
  if (!Array.isArray(value)) {
    return invalid(`${label} must be an array.`);
  }
  if (value.length < min || value.length > max) {
    return invalid(`${label} must contain ${min}..${max} keys.`);
  }
  const keyIds = new Set<string>();
  const keys: DevicePublicKey[] = [];
  for (const [index, candidate] of value.entries()) {
    const validated = validatePublicKey(candidate, `${label}[${index}]`);
    if (!validated.ok) return validated;
    if (keyIds.has(validated.value.keyId)) {
      return invalid("Key identifiers must be unique within a device bundle.");
    }
    keyIds.add(validated.value.keyId);
    keys.push(validated.value);
  }
  return { ok: true, value: keys };
}

function validateFallbackState(value: unknown): ValidationResult<DeviceFallbackKeyState> {
  if (!isRecord(value) || !hasOnlyFields(value, FALLBACK_STATE_FIELDS)) {
    return invalid("fallbackKey must contain keyId, key, publishedAt, and expiresAt.");
  }
  const key = validatePublicKey({ keyId: value.keyId, key: value.key }, "fallbackKey");
  if (!key.ok) return key;
  if (!isIsoDate(value.publishedAt) || !isIsoDate(value.expiresAt)) {
    return invalid("fallbackKey publication timestamps are invalid.");
  }
  return {
    ok: true,
    value: {
      keyId: key.value.keyId,
      key: key.value.key,
      publishedAt: value.publishedAt,
      expiresAt: value.expiresAt,
    },
  };
}

/** Validate an owner-visible published bundle (server → owner). */
export function validateDeviceKeyBundle(
  input: unknown,
  expectedUserId?: string,
  expectedDeviceId?: string,
): ValidationResult<DeviceKeyBundle> {
  if (!isRecord(input) || !hasOnlyFields(input, OWNER_BUNDLE_FIELDS)) {
    return invalid("Device key bundle contains unsupported fields.");
  }
  const version = checkSchemaVersion(input.schemaVersion);
  if (!version.ok) {
    return {
      ok: false,
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `Unsupported schemaVersion. Expected ${DEVICE_KEY_SCHEMA_VERSION}.`,
      retryable: false,
    };
  }
  if (
    typeof input.algorithm !== "string" ||
    !(DEVICE_KEY_ALGORITHMS as readonly string[]).includes(input.algorithm)
  ) {
    return invalid("Device key algorithm is not supported.");
  }
  if (!isUserId(input.userId)) {
    return invalid("userId is invalid.");
  }
  if (expectedUserId !== undefined && input.userId !== expectedUserId) {
    return invalid("Device key bundle belongs to another user.");
  }
  if (!isDeviceId(input.deviceId)) {
    return invalid("deviceId is invalid.");
  }
  if (expectedDeviceId !== undefined && input.deviceId !== expectedDeviceId) {
    return invalid("deviceId does not match the expected device.");
  }
  if (!isPublicKey(input.identityKey) || !isPublicKey(input.senderKey)) {
    return invalid("Device public keys are invalid.");
  }
  const oneTimeKeys = validatePublicKeyList(input.oneTimeKeys, "oneTimeKeys", 0, ONE_TIME_KEYS_MAX);
  if (!oneTimeKeys.ok) return oneTimeKeys;
  const fallback = validateFallbackState(input.fallbackKey);
  if (!fallback.ok) return fallback;
  if (!isIsoDate(input.publishedAt) || !isIsoDate(input.updatedAt)) {
    return invalid("Device publication timestamps are invalid.");
  }
  return {
    ok: true,
    value: {
      schemaVersion: DEVICE_KEY_SCHEMA_VERSION,
      algorithm: input.algorithm as DeviceKeyAlgorithm,
      userId: input.userId,
      deviceId: input.deviceId,
      identityKey: input.identityKey,
      senderKey: input.senderKey,
      oneTimeKeys: oneTimeKeys.value,
      fallbackKey: fallback.value,
      publishedAt: input.publishedAt,
      updatedAt: input.updatedAt,
    },
  };
}

/** Validate a peer-visible directory entry (server → peer). */
export function validateDeviceDirectoryEntry(
  input: unknown,
  expectedUserId?: string,
): ValidationResult<DeviceDirectoryEntry> {
  if (!isRecord(input) || !hasOnlyFields(input, DIRECTORY_ENTRY_FIELDS)) {
    return invalid("Device directory entry contains unsupported fields.");
  }
  const version = checkSchemaVersion(input.schemaVersion);
  if (!version.ok) {
    return {
      ok: false,
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `Unsupported schemaVersion. Expected ${DEVICE_KEY_SCHEMA_VERSION}.`,
      retryable: false,
    };
  }
  if (
    typeof input.algorithm !== "string" ||
    !(DEVICE_KEY_ALGORITHMS as readonly string[]).includes(input.algorithm)
  ) {
    return invalid("Device key algorithm is not supported.");
  }
  if (!isUserId(input.userId)) {
    return invalid("userId is invalid.");
  }
  if (expectedUserId !== undefined && input.userId !== expectedUserId) {
    return invalid("Device directory entry belongs to another user.");
  }
  if (!isDeviceId(input.deviceId)) {
    return invalid("deviceId is invalid.");
  }
  if (!isPublicKey(input.identityKey) || !isPublicKey(input.senderKey)) {
    return invalid("Device public keys are invalid.");
  }
  const oneTimeKeys = validatePublicKeyList(input.oneTimeKeys, "oneTimeKeys", 0, ONE_TIME_KEYS_MAX);
  if (!oneTimeKeys.ok) return oneTimeKeys;
  const fallback = validateFallbackState(input.fallbackKey);
  if (!fallback.ok) return fallback;
  if (!isIsoDate(input.publishedAt)) {
    return invalid("Device publication timestamp is invalid.");
  }
  return {
    ok: true,
    value: {
      userId: input.userId,
      deviceId: input.deviceId,
      schemaVersion: DEVICE_KEY_SCHEMA_VERSION,
      algorithm: input.algorithm as DeviceKeyAlgorithm,
      identityKey: input.identityKey,
      senderKey: input.senderKey,
      oneTimeKeys: oneTimeKeys.value,
      fallbackKey: fallback.value,
      publishedAt: input.publishedAt,
    },
  };
}

export function validateDeviceSummary(input: unknown): ValidationResult<DeviceSummary> {
  if (!isRecord(input) || !hasOnlyFields(input, DEVICE_SUMMARY_FIELDS)) {
    return invalid("Device summary contains unsupported fields.");
  }
  if (!isDeviceId(input.deviceId)) {
    return invalid("deviceId is invalid.");
  }
  if (typeof input.isActive !== "boolean" || typeof input.backupLinked !== "boolean") {
    return invalid("Device summary flags are invalid.");
  }
  if (
    typeof input.status !== "string" ||
    !(DEVICE_STATUSES as readonly string[]).includes(input.status)
  ) {
    return invalid("Device status is invalid.");
  }
  if (
    typeof input.algorithm !== "string" ||
    !(DEVICE_KEY_ALGORITHMS as readonly string[]).includes(input.algorithm)
  ) {
    return invalid("Device key algorithm is not supported.");
  }
  if (!isIsoDate(input.createdAt) || !isIsoDate(input.updatedAt)) {
    return invalid("Device timestamps are invalid.");
  }
  if (input.revokedAt !== null && !isIsoDate(input.revokedAt)) {
    return invalid("revokedAt is invalid.");
  }
  if (input.replacedByDeviceId !== null && !isDeviceId(input.replacedByDeviceId)) {
    return invalid("replacedByDeviceId is invalid.");
  }
  return {
    ok: true,
    value: {
      deviceId: input.deviceId,
      isActive: input.isActive,
      status: input.status as DeviceStatus,
      algorithm: input.algorithm as DeviceKeyAlgorithm,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
      revokedAt: input.revokedAt,
      replacedByDeviceId: input.replacedByDeviceId,
      backupLinked: input.backupLinked,
    },
  };
}

export function validateDeviceEnrollmentResponse(
  input: unknown,
  expectedUserId?: string,
  expectedDeviceId?: string,
): ValidationResult<DeviceEnrollmentResponse> {
  if (!isRecord(input)) {
    return invalid("Enrollment response must be an object.");
  }
  if (!hasOnlyFields(input, new Set(["device", "replacedDeviceId", "backupRequired"]))) {
    return invalid("Enrollment response contains unsupported fields.");
  }
  const device = validateDeviceKeyBundle(input.device, expectedUserId, expectedDeviceId);
  if (!device.ok) return device;
  if (input.replacedDeviceId !== null && !isDeviceId(input.replacedDeviceId)) {
    return invalid("replacedDeviceId is invalid.");
  }
  if (input.backupRequired !== true) {
    return invalid("Enrollment response must require a backup decision.");
  }
  return {
    ok: true,
    value: {
      device: device.value,
      replacedDeviceId: input.replacedDeviceId,
      backupRequired: true,
    },
  };
}

export function validateDeviceKeyResponse(
  input: unknown,
  expectedUserId?: string,
  expectedDeviceId?: string,
): ValidationResult<DeviceKeyResponse> {
  if (!isRecord(input) || !hasOnlyFields(input, new Set(["device", "backupLink"]))) {
    return invalid("Device key response contains unsupported fields.");
  }
  const device = validateDeviceKeyBundle(input.device, expectedUserId, expectedDeviceId);
  if (!device.ok) return device;
  if (input.backupLink !== null) {
    const link = validateKeyBackupLinkObject(input.backupLink);
    if (!link.ok) return link;
    return { ok: true, value: { device: device.value, backupLink: link.value } };
  }
  return { ok: true, value: { device: device.value, backupLink: null } };
}

export function validateDeviceDirectoryResponse(
  input: unknown,
  expectedUserId?: string,
): ValidationResult<DevicePublicKeysResponse> {
  if (!isRecord(input) || !hasOnlyFields(input, new Set(["userId", "device"]))) {
    return invalid("Device directory response contains unsupported fields.");
  }
  if (!isUserId(input.userId)) {
    return invalid("userId is invalid.");
  }
  if (expectedUserId !== undefined && input.userId !== expectedUserId) {
    return invalid("Device directory response belongs to another user.");
  }
  const device = validateDeviceDirectoryEntry(input.device, input.userId);
  if (!device.ok) return device;
  return { ok: true, value: { userId: input.userId, device: device.value } };
}

export function validateDeviceListResponse(input: unknown): ValidationResult<DeviceListResponse> {
  if (
    !isRecord(input) ||
    !hasOnlyFields(input, new Set(["items"])) ||
    !Array.isArray(input.items)
  ) {
    return invalid("Device list response contains unsupported fields.");
  }
  const items: DeviceSummary[] = [];
  for (const [index, candidate] of input.items.entries()) {
    const validated = validateDeviceSummary(candidate);
    if (!validated.ok) {
      return invalid(`items[${index}]: ${validated.message}`);
    }
    items.push(validated.value);
  }
  return { ok: true, value: { items } };
}

export function validateDeviceRevocationResponse(
  input: unknown,
  expectedDeviceId?: string,
): ValidationResult<DeviceRevocationResponse> {
  if (
    !isRecord(input) ||
    !hasOnlyFields(input, new Set(["deviceId", "status", "revokedAt", "replacedByDeviceId"]))
  ) {
    return invalid("Device revocation response contains unsupported fields.");
  }
  if (!isDeviceId(input.deviceId)) {
    return invalid("deviceId is invalid.");
  }
  if (expectedDeviceId !== undefined && input.deviceId !== expectedDeviceId) {
    return invalid("Device revocation response does not match the expected device.");
  }
  if (
    typeof input.status !== "string" ||
    !(DEVICE_STATUSES as readonly string[]).includes(input.status)
  ) {
    return invalid("Device status is invalid.");
  }
  if (!isIsoDate(input.revokedAt)) {
    return invalid("revokedAt is invalid.");
  }
  if (input.replacedByDeviceId !== null && !isDeviceId(input.replacedByDeviceId)) {
    return invalid("replacedByDeviceId is invalid.");
  }
  return {
    ok: true,
    value: {
      deviceId: input.deviceId,
      status: input.status as DeviceStatus,
      revokedAt: input.revokedAt,
      replacedByDeviceId: input.replacedByDeviceId,
    },
  };
}

export function validateKeyBackupLinkResponse(
  input: unknown,
  expectedDeviceId?: string,
): ValidationResult<KeyBackupLinkResponse> {
  if (!isRecord(input) || !hasOnlyFields(input, new Set(["deviceId", "link"]))) {
    return invalid("Key-backup link response contains unsupported fields.");
  }
  if (!isDeviceId(input.deviceId)) {
    return invalid("deviceId is invalid.");
  }
  if (expectedDeviceId !== undefined && input.deviceId !== expectedDeviceId) {
    return invalid("Key-backup link response does not match the expected device.");
  }
  const link = validateKeyBackupLinkObject(input.link);
  if (!link.ok) return link;
  return { ok: true, value: { deviceId: input.deviceId, link: link.value } };
}

function validateKeyBackupLinkObject(input: unknown): ValidationResult<KeyBackupLink> {
  if (
    !isRecord(input) ||
    !hasOnlyFields(
      input,
      new Set(["backupId", "kid", "archiveFormat", "schemaVersion", "createdAt"]),
    )
  ) {
    return invalid("Key-backup link contains unsupported fields.");
  }
  if (!isDeviceId(input.backupId) || !isKeyId(input.kid)) {
    return invalid("Key-backup link identifiers are invalid.");
  }
  if (input.archiveFormat !== KEY_BACKUP_ARCHIVE_FORMAT) {
    return invalid("archiveFormat is not supported.");
  }
  const version = checkSchemaVersion(input.schemaVersion);
  if (!version.ok) {
    return {
      ok: false,
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `Unsupported schemaVersion. Expected ${DEVICE_KEY_SCHEMA_VERSION}.`,
      retryable: false,
    };
  }
  if (!isIsoDate(input.createdAt)) {
    return invalid("Key-backup link createdAt is invalid.");
  }
  return {
    ok: true,
    value: {
      backupId: input.backupId,
      kid: input.kid,
      archiveFormat: KEY_BACKUP_ARCHIVE_FORMAT,
      schemaVersion: DEVICE_KEY_SCHEMA_VERSION,
      createdAt: input.createdAt,
    },
  };
}

/** Server-side helper: validate a stored/peer bundle before emitting it. */
export function isDeviceKeyBundle(value: unknown): value is DeviceKeyBundle {
  return validateDeviceKeyBundle(value).ok;
}

export function fallbackExpiry(publishedAt: Date): string {
  return new Date(publishedAt.getTime() + FALLBACK_KEY_MAX_AGE_DAYS * 86_400_000).toISOString();
}
