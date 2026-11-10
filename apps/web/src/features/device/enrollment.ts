import {
  DeviceApiError,
  DeviceEnrollmentClient,
  generateDeviceIdentity,
  type CryptoCapabilityReport,
} from "@chat/crypto";
import type {
  DeviceEnrollmentResponse,
  DeviceReplacementMode,
  DeviceRevocationReason,
  KeyBackupLinkResponse,
} from "@chat/contracts";

import { checkDeviceCryptoSupport } from "./capabilities.js";
import {
  deleteDeviceIdentity,
  loadDeviceIdentity,
  saveDeviceIdentity,
  withDeviceLock,
  type StoredDeviceIdentity,
} from "./identity-store.js";

/**
 * Device enrollment orchestration (P2-01).
 *
 * Authentication alone never silently enrolls a second device. If the server
 * reports an existing active device, the caller receives
 * `replacement-required`; it must show the history-loss warning and call
 * `resetDeviceEncryption` with the active device ID. No UI/localization claim
 * is made here.
 */
export interface DeviceEnrollmentOptions {
  userId: string;
  apiOrigin: string;
  getToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
}

export type EnsureDeviceResult =
  | {
      status: "ready";
      identity: StoredDeviceIdentity;
      response: DeviceEnrollmentResponse;
      republished: boolean;
    }
  | { status: "replacement-required"; activeDeviceId: string | null }
  | { status: "unsupported"; report: CryptoCapabilityReport };

export type ResetDeviceResult =
  | { status: "ready"; identity: StoredDeviceIdentity; response: DeviceEnrollmentResponse }
  | { status: "unsupported"; report: CryptoCapabilityReport };

export type RevokeDeviceResult = { status: "revoked"; deviceId: string } | { status: "no-device" };

export const DEVICE_REPLACEMENT_WARNING =
  "Replacing this device revokes the previous device. Messages not included in your last encrypted backup will be unrecoverable.";

function createClient(options: DeviceEnrollmentOptions): DeviceEnrollmentClient {
  return new DeviceEnrollmentClient({
    apiOrigin: options.apiOrigin,
    expectedUserId: options.userId,
    getToken: options.getToken,
    fetchImpl: options.fetchImpl,
  });
}

async function findActiveDeviceId(client: DeviceEnrollmentClient): Promise<string | null> {
  try {
    const list = await client.list();
    return list.items.find((item) => item.isActive)?.deviceId ?? null;
  } catch {
    return null;
  }
}

export async function ensureDeviceEnrollment(
  options: DeviceEnrollmentOptions,
): Promise<EnsureDeviceResult> {
  const report = await checkDeviceCryptoSupport();
  if (!report.ready) return { status: "unsupported", report };

  return withDeviceLock(options.userId, async () => {
    const client = createClient(options);
    const existing = await loadDeviceIdentity(options.userId);

    if (existing) {
      try {
        const response = await client.republish(existing);
        return { status: "ready", identity: existing, response, republished: true };
      } catch (error) {
        if (error instanceof DeviceApiError && error.code === "DEVICE_REPLACEMENT_REQUIRED") {
          return {
            status: "replacement-required",
            activeDeviceId: await findActiveDeviceId(client),
          };
        }
        throw error;
      }
    }

    const identity = await generateDeviceIdentity();
    try {
      const response = await client.enroll(identity);
      const stored: StoredDeviceIdentity = { ...identity, userId: options.userId };
      await saveDeviceIdentity(stored);
      return { status: "ready", identity: stored, response, republished: false };
    } catch (error) {
      if (error instanceof DeviceApiError && error.code === "DEVICE_REPLACEMENT_REQUIRED") {
        return {
          status: "replacement-required",
          activeDeviceId: await findActiveDeviceId(client),
        };
      }
      throw error;
    }
  });
}

export interface ResetDeviceOptions extends DeviceEnrollmentOptions {
  previousDeviceId: string;
  mode: DeviceReplacementMode;
}

export async function resetDeviceEncryption(
  options: ResetDeviceOptions,
): Promise<ResetDeviceResult> {
  const report = await checkDeviceCryptoSupport();
  if (!report.ready) return { status: "unsupported", report };

  return withDeviceLock(options.userId, async () => {
    const client = createClient(options);
    const identity = await generateDeviceIdentity();
    const response = await client.enroll(identity, {
      previousDeviceId: options.previousDeviceId,
      mode: options.mode,
      acknowledgeHistoryLoss: true,
    });
    const stored: StoredDeviceIdentity = { ...identity, userId: options.userId };
    await saveDeviceIdentity(stored);
    return { status: "ready", identity: stored, response };
  });
}

export interface RevokeDeviceOptions extends DeviceEnrollmentOptions {
  reason: DeviceRevocationReason;
}

export async function revokeCurrentDevice(
  options: RevokeDeviceOptions,
): Promise<RevokeDeviceResult> {
  return withDeviceLock(options.userId, async () => {
    const identity = await loadDeviceIdentity(options.userId);
    if (!identity) return { status: "no-device" };
    const client = createClient(options);
    await client.revoke(identity.deviceId, options.reason);
    await deleteDeviceIdentity(options.userId);
    return { status: "revoked", deviceId: identity.deviceId };
  });
}

export async function linkDeviceBackup(
  options: DeviceEnrollmentOptions,
  backupId: string,
  kid: string,
): Promise<KeyBackupLinkResponse> {
  return withDeviceLock(options.userId, async () => {
    const identity = await loadDeviceIdentity(options.userId);
    if (!identity) {
      throw new Error("No local device identity is enrolled.");
    }
    const client = createClient(options);
    return client.linkBackup(identity.deviceId, backupId, kid);
  });
}

export async function loadCurrentDevice(userId: string): Promise<StoredDeviceIdentity | null> {
  return loadDeviceIdentity(userId);
}
