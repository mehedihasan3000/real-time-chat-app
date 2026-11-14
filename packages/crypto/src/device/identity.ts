import {
  DEVICE_FORBIDDEN_FIELDS,
  DEVICE_KEY_SCHEMA_VERSION,
  ONE_TIME_KEYS_MAX,
  ONE_TIME_KEYS_MIN,
  isDeviceId,
  validateDevicePublicKeyBundle,
  type DeviceKeyAlgorithm,
  type DevicePublicKey,
  type DevicePublicKeyBundle,
} from "@chat/contracts";

import { base64UrlEncode, newDeviceId, newKeyId } from "./encoding.js";

/**
 * Provisional `dev-webcrypto-v0` device identity (P2-01).
 *
 * Generates an Ed25519 identity key and X25519 sender/one-time/fallback keys
 * with Web Crypto. Private keys are generated non-extractable and are never
 * serialized into a request. This is NOT Olm and makes no E2EE claim; P2-02
 * replaces the provider with the approved vodozemac/Olm binding.
 */
export const PROVISIONAL_IDENTITY_ALGORITHM: DeviceKeyAlgorithm = "dev-webcrypto-v0";

export const DEFAULT_ONE_TIME_KEY_COUNT = 20;

export interface DeviceOneTimeKeyPair {
  keyId: string;
  keyPair: CryptoKeyPair;
}

export interface DeviceFallbackKeyPair {
  keyId: string;
  keyPair: CryptoKeyPair;
}

export interface DeviceIdentityMaterial {
  schemaVersion: 1;
  algorithm: DeviceKeyAlgorithm;
  deviceId: string;
  identityKeyPair: CryptoKeyPair;
  senderKeyPair: CryptoKeyPair;
  oneTimeKeyPairs: DeviceOneTimeKeyPair[];
  fallbackKeyPair: DeviceFallbackKeyPair;
  publicBundle: DevicePublicKeyBundle;
  createdAt: string;
}

export interface GenerateDeviceIdentityOptions {
  deviceId?: string;
  oneTimeKeyCount?: number;
  now?: Date;
}

async function exportPublicKey(key: CryptoKey): Promise<string> {
  const raw = await globalThis.crypto.subtle.exportKey("raw", key);
  return base64UrlEncode(raw);
}

async function generateEd25519KeyPair(): Promise<CryptoKeyPair> {
  return (await globalThis.crypto.subtle.generateKey({ name: "Ed25519" }, false, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function generateX25519KeyPair(): Promise<CryptoKeyPair> {
  return (await globalThis.crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
}

async function generateOneTimeKeys(count: number): Promise<DeviceOneTimeKeyPair[]> {
  return Promise.all(
    Array.from({ length: count }, async () => {
      const keyPair = await generateX25519KeyPair();
      return { keyId: newKeyId(), keyPair };
    }),
  );
}

export async function generateDeviceIdentity(
  options: GenerateDeviceIdentityOptions = {},
): Promise<DeviceIdentityMaterial> {
  const deviceId = options.deviceId ?? newDeviceId();
  if (!isDeviceId(deviceId)) {
    throw new Error("deviceId must be an opaque 8–128 character identifier.");
  }
  const count = options.oneTimeKeyCount ?? DEFAULT_ONE_TIME_KEY_COUNT;
  if (!Number.isInteger(count) || count < ONE_TIME_KEYS_MIN || count > ONE_TIME_KEYS_MAX) {
    throw new Error(`oneTimeKeyCount must be ${ONE_TIME_KEYS_MIN}..${ONE_TIME_KEYS_MAX}.`);
  }

  const identityKeyPair = await generateEd25519KeyPair();
  const senderKeyPair = await generateX25519KeyPair();
  const fallbackKeyPair = { keyId: newKeyId(), keyPair: await generateX25519KeyPair() };
  const oneTimeKeyPairs = await generateOneTimeKeys(count);

  const [identityKey, senderKey, fallbackKey, oneTimeKeys] = await Promise.all([
    exportPublicKey(identityKeyPair.publicKey),
    exportPublicKey(senderKeyPair.publicKey),
    exportPublicKey(fallbackKeyPair.keyPair.publicKey),
    Promise.all(
      oneTimeKeyPairs.map(async (entry): Promise<DevicePublicKey> => ({
        keyId: entry.keyId,
        key: await exportPublicKey(entry.keyPair.publicKey),
      })),
    ),
  ]);

  const publicBundle: DevicePublicKeyBundle = {
    schemaVersion: DEVICE_KEY_SCHEMA_VERSION,
    algorithm: PROVISIONAL_IDENTITY_ALGORITHM,
    deviceId,
    identityKey,
    senderKey,
    oneTimeKeys,
    fallbackKey: { keyId: fallbackKeyPair.keyId, key: fallbackKey },
  };

  const validated = validateDevicePublicKeyBundle(publicBundle, deviceId);
  if (!validated.ok) {
    throw new Error(`Generated device bundle failed validation: ${validated.message}`);
  }

  return {
    schemaVersion: 1,
    algorithm: PROVISIONAL_IDENTITY_ALGORITHM,
    deviceId,
    identityKeyPair,
    senderKeyPair,
    oneTimeKeyPairs,
    fallbackKeyPair,
    publicBundle: validated.value,
    createdAt: (options.now ?? new Date()).toISOString(),
  };
}

/** Deep public-only projection; never includes CryptoKey/private material. */
export function toPublicBundle(material: DeviceIdentityMaterial): DevicePublicKeyBundle {
  return {
    schemaVersion: DEVICE_KEY_SCHEMA_VERSION,
    algorithm: material.algorithm,
    deviceId: material.deviceId,
    identityKey: material.publicBundle.identityKey,
    senderKey: material.publicBundle.senderKey,
    oneTimeKeys: material.publicBundle.oneTimeKeys.map((key) => ({ ...key })),
    fallbackKey: { ...material.publicBundle.fallbackKey },
  };
}

/**
 * Refresh the one-time-key pool while keeping the device identity and
 * fallback key stable. Used for server-pool replenishment (P2-02 consumes).
 */
export async function refreshOneTimeKeys(
  material: DeviceIdentityMaterial,
  count = DEFAULT_ONE_TIME_KEY_COUNT,
): Promise<DeviceIdentityMaterial> {
  if (!Number.isInteger(count) || count < ONE_TIME_KEYS_MIN || count > ONE_TIME_KEYS_MAX) {
    throw new Error(`oneTimeKeyCount must be ${ONE_TIME_KEYS_MIN}..${ONE_TIME_KEYS_MAX}.`);
  }
  const oneTimeKeyPairs = await generateOneTimeKeys(count);
  const oneTimeKeys = await Promise.all(
    oneTimeKeyPairs.map(async (entry): Promise<DevicePublicKey> => ({
      keyId: entry.keyId,
      key: await exportPublicKey(entry.keyPair.publicKey),
    })),
  );
  const publicBundle: DevicePublicKeyBundle = {
    ...toPublicBundle(material),
    oneTimeKeys,
  };
  const validated = validateDevicePublicKeyBundle(publicBundle, material.deviceId);
  if (!validated.ok) {
    throw new Error(`Refreshed device bundle failed validation: ${validated.message}`);
  }
  return {
    ...material,
    oneTimeKeyPairs,
    publicBundle: validated.value,
  };
}

const FORBIDDEN = new Set<string>(DEVICE_FORBIDDEN_FIELDS);

/**
 * Recursively find a forbidden private-material field name. This complements
 * (does not replace) the strict server-side field allowlists.
 */
export function findForbiddenField(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): string | null {
  if (typeof value !== "object" || value === null) return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenField(item, seen);
      if (found) return found;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN.has(key)) return key;
    const found = findForbiddenField(record[key], seen);
    if (found) return found;
  }
  return null;
}

export function assertNoForbiddenFields(value: unknown): void {
  const found = findForbiddenField(value);
  if (found) throw new Error(`Forbidden private-material field present: ${found}`);
}

export function assertPrivateKeysNonExtractable(material: DeviceIdentityMaterial): void {
  const privateKeys: CryptoKey[] = [
    material.identityKeyPair.privateKey,
    material.senderKeyPair.privateKey,
    material.fallbackKeyPair.keyPair.privateKey,
    ...material.oneTimeKeyPairs.map((entry) => entry.keyPair.privateKey),
  ];
  if (privateKeys.some((key) => key.extractable)) {
    throw new Error("Device private keys must be non-extractable.");
  }
}
