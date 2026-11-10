import {
  KEY_BACKUP_ARCHIVE_FORMAT,
  validateDeviceDirectoryResponse,
  validateDeviceEnrollmentResponse,
  validateDeviceKeyResponse,
  validateDeviceListResponse,
  validateDeviceRevocationResponse,
  validateKeyBackupLinkResponse,
  type DeviceDirectoryEntry,
  type DeviceEnrollmentResponse,
  type DeviceKeyBundle,
  type DeviceKeyResponse,
  type DeviceListResponse,
  type DevicePublicKeyBundle,
  type DeviceReplacement,
  type DeviceRevocationReason,
  type DeviceRevocationResponse,
  type KeyBackupLinkResponse,
} from "@chat/contracts";

import {
  assertNoForbiddenFields,
  toPublicBundle,
  type DeviceIdentityMaterial,
} from "./identity.js";

/**
 * Authenticated device-directory client (P2-01).
 *
 * - Sends public material only; `assertNoForbiddenFields` runs before every
 *   request as a defence-in-depth check.
 * - Verifies server responses against the local public bundle so a substituted
 *   identity/sender/one-time/fallback key fails closed.
 * - Uses a Bearer JWT supplied by the caller; the session cookie is never read.
 */
export interface DeviceApiClientOptions {
  apiOrigin: string;
  expectedUserId: string;
  getToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
}

export class DeviceApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "DeviceApiError";
  }
}

export class DeviceDirectoryVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceDirectoryVerificationError";
  }
}

interface ApiEnvelope {
  ok?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function samePublicKeys(
  local: readonly { keyId: string; key: string }[],
  server: readonly { keyId: string; key: string }[],
  label: string,
): void {
  if (local.length !== server.length) {
    throw new DeviceDirectoryVerificationError(`Server returned a different ${label} count.`);
  }
  const expected = new Map(local.map((key) => [key.keyId, key.key]));
  for (const key of server) {
    if (expected.get(key.keyId) !== key.key) {
      throw new DeviceDirectoryVerificationError(`Server returned a different ${label}.`);
    }
  }
}

export function assertPublishedBundle(local: DevicePublicKeyBundle, server: DeviceKeyBundle): void {
  if (server.deviceId !== local.deviceId) {
    throw new DeviceDirectoryVerificationError("Server returned a different device ID.");
  }
  if (server.algorithm !== local.algorithm) {
    throw new DeviceDirectoryVerificationError("Server returned a different key algorithm.");
  }
  if (server.identityKey !== local.identityKey) {
    throw new DeviceDirectoryVerificationError("Server substituted the identity key.");
  }
  if (server.senderKey !== local.senderKey) {
    throw new DeviceDirectoryVerificationError("Server substituted the sender key.");
  }
  samePublicKeys(local.oneTimeKeys, server.oneTimeKeys, "one-time key");
  if (
    server.fallbackKey.keyId !== local.fallbackKey.keyId ||
    server.fallbackKey.key !== local.fallbackKey.key
  ) {
    throw new DeviceDirectoryVerificationError("Server substituted the fallback key.");
  }
}

export class DeviceEnrollmentClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DeviceApiClientOptions) {
    const url = new URL(options.apiOrigin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("apiOrigin must use http or https.");
    }
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("apiOrigin must be an origin without credentials, path, query, or fragment.");
    }
    if (!options.expectedUserId) {
      throw new Error("expectedUserId is required for directory verification.");
    }
    this.origin = url.origin;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("A fetch implementation is required.");
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.options.getToken();
    if (!token) {
      throw new DeviceApiError("UNAUTHENTICATED", 401, false, "Authentication is required.");
    }
    const response = await this.fetchImpl(`${this.origin}/api/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
      },
      credentials: "omit",
      cache: "no-store",
    });
    const body = (await response.json().catch(() => null)) as ApiEnvelope | null;
    if (!response.ok || !body || body.ok !== true) {
      throw new DeviceApiError(
        body?.error?.code ?? "INTERNAL_ERROR",
        response.status,
        body?.error?.retryable ?? false,
        body?.error?.message ?? "Device operation failed.",
      );
    }
    return body.data;
  }

  async enroll(
    identity: DeviceIdentityMaterial,
    replace?: DeviceReplacement,
  ): Promise<DeviceEnrollmentResponse> {
    const body: Record<string, unknown> = { bundle: toPublicBundle(identity) };
    if (replace) body.replace = replace;
    assertNoForbiddenFields(body);

    const data = await this.request(`/devices/${encodeURIComponent(identity.deviceId)}/keys`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const validated = validateDeviceEnrollmentResponse(
      data,
      this.options.expectedUserId,
      identity.deviceId,
    );
    if (!validated.ok) throw new DeviceDirectoryVerificationError(validated.message);

    assertPublishedBundle(identity.publicBundle, validated.value.device);
    if (replace) {
      if (validated.value.replacedDeviceId !== replace.previousDeviceId) {
        throw new DeviceDirectoryVerificationError(
          "Server did not confirm the expected replaced device.",
        );
      }
    } else if (validated.value.replacedDeviceId !== null) {
      throw new DeviceDirectoryVerificationError("Server unexpectedly replaced another device.");
    }
    return validated.value;
  }

  async republish(identity: DeviceIdentityMaterial): Promise<DeviceEnrollmentResponse> {
    return this.enroll(identity);
  }

  async getOwn(deviceId: string): Promise<DeviceKeyResponse> {
    const data = await this.request(`/devices/${encodeURIComponent(deviceId)}/keys`);
    const validated = validateDeviceKeyResponse(data, this.options.expectedUserId, deviceId);
    if (!validated.ok) throw new DeviceDirectoryVerificationError(validated.message);
    return validated.value;
  }

  async list(): Promise<DeviceListResponse> {
    const data = await this.request("/devices");
    const validated = validateDeviceListResponse(data);
    if (!validated.ok) throw new DeviceDirectoryVerificationError(validated.message);
    return validated.value;
  }

  async getPeer(userId: string): Promise<DeviceDirectoryEntry> {
    const data = await this.request(`/devices/${encodeURIComponent(userId)}/public-keys`);
    const validated = validateDeviceDirectoryResponse(data, userId);
    if (!validated.ok) throw new DeviceDirectoryVerificationError(validated.message);
    return validated.value.device;
  }

  async revoke(
    deviceId: string,
    reason: DeviceRevocationReason,
  ): Promise<DeviceRevocationResponse> {
    const data = await this.request(`/devices/${encodeURIComponent(deviceId)}/revoke`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    const validated = validateDeviceRevocationResponse(data, deviceId);
    if (!validated.ok) throw new DeviceDirectoryVerificationError(validated.message);
    return validated.value;
  }

  async linkBackup(
    deviceId: string,
    backupId: string,
    kid: string,
  ): Promise<KeyBackupLinkResponse> {
    const body = {
      deviceId,
      backupId,
      kid,
      archiveFormat: KEY_BACKUP_ARCHIVE_FORMAT,
      schemaVersion: 1,
    };
    assertNoForbiddenFields(body);
    const data = await this.request("/key-backups/link", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const validated = validateKeyBackupLinkResponse(data, deviceId);
    if (!validated.ok) throw new DeviceDirectoryVerificationError(validated.message);
    return validated.value;
  }
}

/** Type guard used by web wiring to distinguish safe API errors. */
export function isDeviceApiError(error: unknown): error is DeviceApiError {
  return error instanceof DeviceApiError || (isRecord(error) && error.name === "DeviceApiError");
}
