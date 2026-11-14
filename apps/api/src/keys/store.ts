import {
  fallbackExpiry,
  type DeviceDirectoryEntry,
  type DeviceFallbackKeyState,
  type DeviceKeyAlgorithm,
  type DeviceKeyBundle,
  type DevicePublicKey,
  type DevicePublicKeyBundle,
  type DeviceReplacement,
  type DeviceRevocationReason,
  type DeviceStatus,
  type DeviceSummary,
  type KeyBackupLink,
  type KeyBackupLinkRequest,
} from "@chat/contracts";

/**
 * Device public-key directory v0 (P2-01, DEC-002/DEC-004).
 *
 * - Exactly one active device per account; a second device must supply an
 *   explicit `replace` block (restore or reset) and acknowledge history loss.
 * - Only public material is stored: Ed25519 identity key, Curve25519 sender
 *   key, one-time prekeys, and a fallback key. No private key, recovery key,
 *   archive, manifest, or plaintext is accepted by this module.
 * - Identity is immutable for an active device. Republishing may refresh the
 *   sender/one-time/fallback pool but never the identity key.
 * - Revocation is immediate: the device is marked revoked, published keys are
 *   cleared, and auth-session/queued-ciphertext/peer-notification hooks run.
 * - Production backing is the Mongo `devices` collection with the partial
 *   unique index `uniq_active_device_per_user` (P1-04 schema catalogue).
 */
export interface DeviceRecord {
  userId: string;
  deviceId: string;
  status: DeviceStatus;
  /** Mirrors `status === "active"` for the partial unique Mongo index. */
  isActive: boolean;
  algorithm: DeviceKeyAlgorithm;
  identityKey: string;
  senderKey: string;
  oneTimeKeys: DevicePublicKey[];
  fallbackKey: DeviceFallbackKeyState | null;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  revokedReason: DeviceRevocationReason | null;
  replacedByDeviceId: string | null;
  backupLink: KeyBackupLink | null;
}

export type DeviceAuditAction =
  | "device.enrolled"
  | "device.republished"
  | "device.replaced"
  | "device.revoked"
  | "device.backup_linked";

/** Append-only audit metadata; never contains key material. */
export interface DeviceAuditEntry {
  action: DeviceAuditAction;
  userId: string;
  deviceId: string;
  previousDeviceId?: string;
  replacedByDeviceId?: string;
  reason?: DeviceRevocationReason;
  at: string;
}

/**
 * Integration hooks required by FR-SEC-010. The store invokes them after the
 * revocation boundary is persisted. Auth-session and queued-ciphertext hooks
 * must fail closed: a throw surfaces as a safe 500, never as an accepted
 * replacement.
 */
export interface DeviceRevocationHooks {
  revokeAuthSessions?: (userId: string, deviceId: string) => Promise<void> | void;
  deleteQueuedCiphertext?: (userId: string, deviceId: string) => Promise<void> | void;
  notifyPeers?: (
    userId: string,
    deviceId: string,
    change: "replaced" | "revoked",
  ) => Promise<void> | void;
}

export type DeviceEnrollResult =
  | { ok: true; record: DeviceRecord; replacedDeviceId: string | null }
  | {
      ok: false;
      code: "REPLACEMENT_REQUIRED" | "INVALID_REPLACEMENT" | "IDENTITY_MISMATCH" | "DEVICE_REVOKED";
    };

export type DeviceRevokeResult =
  { ok: true; record: DeviceRecord; alreadyRevoked: boolean } | { ok: false; code: "NOT_FOUND" };

export type DeviceBackupLinkResult =
  | { ok: true; record: DeviceRecord; link: KeyBackupLink }
  | { ok: false; code: "NOT_FOUND" | "DEVICE_REVOKED" | "CONFLICT" };

export interface DeviceKeyStore {
  enroll(
    userId: string,
    bundle: DevicePublicKeyBundle,
    replace?: DeviceReplacement,
    now?: Date,
  ): Promise<DeviceEnrollResult>;
  revoke(
    userId: string,
    deviceId: string,
    reason: DeviceRevocationReason,
    now?: Date,
  ): Promise<DeviceRevokeResult>;
  getOwn(userId: string, deviceId: string): Promise<DeviceRecord | null>;
  getActivePublicKeys(userId: string): Promise<DeviceDirectoryEntry | null>;
  listOwn(userId: string, limit: number): Promise<DeviceRecord[]>;
  linkBackup(
    userId: string,
    input: KeyBackupLinkRequest,
    now?: Date,
  ): Promise<DeviceBackupLinkResult>;
  readonly audit: DeviceAuditEntry[];
}

export class MemoryDeviceKeyStore implements DeviceKeyStore {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly activeByUser = new Map<string, string>();
  readonly audit: DeviceAuditEntry[] = [];

  constructor(private readonly hooks: DeviceRevocationHooks = {}) {}

  private key(userId: string, deviceId: string): string {
    return `${userId}\u0000${deviceId}`;
  }

  async enroll(
    userId: string,
    bundle: DevicePublicKeyBundle,
    replace?: DeviceReplacement,
    now = new Date(),
  ): Promise<DeviceEnrollResult> {
    const at = now.toISOString();
    const existing = this.devices.get(this.key(userId, bundle.deviceId));
    const activeId = this.activeByUser.get(userId);

    // A revoked/replaced device identifier cannot be reactivated. A new
    // browser must generate a new device ID and explicitly replace/reset.
    if (existing && existing.status !== "active") {
      return { ok: false, code: "DEVICE_REVOKED" };
    }

    if (activeId === bundle.deviceId && existing) {
      if (replace) return { ok: false, code: "INVALID_REPLACEMENT" };
      if (existing.identityKey !== bundle.identityKey) {
        return { ok: false, code: "IDENTITY_MISMATCH" };
      }
      existing.senderKey = bundle.senderKey;
      existing.oneTimeKeys = [...bundle.oneTimeKeys];
      existing.fallbackKey = this.fallbackStateFor(existing, bundle, now);
      existing.updatedAt = at;
      this.audit.push({
        action: "device.republished",
        userId,
        deviceId: existing.deviceId,
        at,
      });
      return { ok: true, record: existing, replacedDeviceId: null };
    }

    if (activeId && activeId !== bundle.deviceId) {
      // Authentication alone never adds a second trusted endpoint. The
      // previous device must be named explicitly and match the current
      // active device; otherwise the response is the same safe 409.
      if (!replace || replace.previousDeviceId !== activeId) {
        return { ok: false, code: "REPLACEMENT_REQUIRED" };
      }
      const previous = this.devices.get(this.key(userId, activeId));
      if (!previous || previous.status !== "active") {
        return { ok: false, code: "REPLACEMENT_REQUIRED" };
      }

      const record = this.newRecord(userId, bundle, now);
      this.markRevoked(
        previous,
        replace.mode === "reset" ? "reset" : "replacement",
        at,
        record.deviceId,
      );
      this.devices.set(this.key(userId, record.deviceId), record);
      this.activeByUser.set(userId, record.deviceId);
      this.audit.push(
        {
          action: "device.replaced",
          userId,
          deviceId: previous.deviceId,
          replacedByDeviceId: record.deviceId,
          reason: previous.revokedReason ?? undefined,
          at,
        },
        {
          action: "device.enrolled",
          userId,
          deviceId: record.deviceId,
          previousDeviceId: previous.deviceId,
          reason: replace.mode === "reset" ? "reset" : "replacement",
          at,
        },
      );
      await this.runRevocationHooks(previous, "replaced");
      return { ok: true, record, replacedDeviceId: previous.deviceId };
    }

    if (replace) {
      // No active device exists to replace. Reject rather than silently
      // accepting a stale replacement claim.
      return { ok: false, code: "INVALID_REPLACEMENT" };
    }

    const record = this.newRecord(userId, bundle, now);
    this.devices.set(this.key(userId, record.deviceId), record);
    this.activeByUser.set(userId, record.deviceId);
    this.audit.push({
      action: "device.enrolled",
      userId,
      deviceId: record.deviceId,
      at,
    });
    return { ok: true, record, replacedDeviceId: null };
  }

  async revoke(
    userId: string,
    deviceId: string,
    reason: DeviceRevocationReason,
    now = new Date(),
  ): Promise<DeviceRevokeResult> {
    const record = this.devices.get(this.key(userId, deviceId));
    if (!record) return { ok: false, code: "NOT_FOUND" };
    if (record.status !== "active") {
      return { ok: true, record, alreadyRevoked: true };
    }

    const at = now.toISOString();
    this.markRevoked(record, reason, at, null);
    this.activeByUser.delete(userId);
    this.audit.push({
      action: "device.revoked",
      userId,
      deviceId: record.deviceId,
      reason,
      at,
    });
    await this.runRevocationHooks(record, "revoked");
    return { ok: true, record, alreadyRevoked: false };
  }

  async getOwn(userId: string, deviceId: string): Promise<DeviceRecord | null> {
    return this.devices.get(this.key(userId, deviceId)) ?? null;
  }

  async getActivePublicKeys(userId: string): Promise<DeviceDirectoryEntry | null> {
    const activeId = this.activeByUser.get(userId);
    if (!activeId) return null;
    const record = this.devices.get(this.key(userId, activeId));
    if (!record || record.status !== "active" || !record.fallbackKey) return null;
    return directoryEntryView(record);
  }

  async listOwn(userId: string, limit: number): Promise<DeviceRecord[]> {
    return [...this.devices.values()]
      .filter((record) => record.userId === userId)
      .sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, limit);
  }

  async linkBackup(
    userId: string,
    input: KeyBackupLinkRequest,
    now = new Date(),
  ): Promise<DeviceBackupLinkResult> {
    const record = this.devices.get(this.key(userId, input.deviceId));
    if (!record) return { ok: false, code: "NOT_FOUND" };
    if (record.status !== "active") return { ok: false, code: "DEVICE_REVOKED" };

    if (
      record.backupLink &&
      record.backupLink.backupId === input.backupId &&
      record.backupLink.kid === input.kid
    ) {
      return { ok: true, record, link: record.backupLink };
    }

    for (const other of this.devices.values()) {
      if (other.userId !== userId || other.deviceId === record.deviceId) continue;
      if (
        other.backupLink &&
        (other.backupLink.backupId === input.backupId || other.backupLink.kid === input.kid)
      ) {
        return { ok: false, code: "CONFLICT" };
      }
    }

    const link: KeyBackupLink = {
      backupId: input.backupId,
      kid: input.kid,
      archiveFormat: input.archiveFormat,
      schemaVersion: 1,
      createdAt: now.toISOString(),
    };
    record.backupLink = link;
    this.audit.push({
      action: "device.backup_linked",
      userId,
      deviceId: record.deviceId,
      at: now.toISOString(),
    });
    return { ok: true, record, link };
  }

  private newRecord(userId: string, bundle: DevicePublicKeyBundle, now: Date): DeviceRecord {
    const at = now.toISOString();
    return {
      userId,
      deviceId: bundle.deviceId,
      status: "active",
      isActive: true,
      algorithm: bundle.algorithm,
      identityKey: bundle.identityKey,
      senderKey: bundle.senderKey,
      oneTimeKeys: [...bundle.oneTimeKeys],
      fallbackKey: {
        ...bundle.fallbackKey,
        publishedAt: at,
        expiresAt: fallbackExpiry(now),
      },
      createdAt: at,
      updatedAt: at,
      revokedAt: null,
      revokedReason: null,
      replacedByDeviceId: null,
      backupLink: null,
    };
  }

  private fallbackStateFor(
    existing: DeviceRecord,
    bundle: DevicePublicKeyBundle,
    now: Date,
  ): DeviceFallbackKeyState {
    const previous = existing.fallbackKey;
    if (
      previous &&
      previous.keyId === bundle.fallbackKey.keyId &&
      previous.key === bundle.fallbackKey.key
    ) {
      return previous;
    }
    return {
      ...bundle.fallbackKey,
      publishedAt: now.toISOString(),
      expiresAt: fallbackExpiry(now),
    };
  }

  private markRevoked(
    record: DeviceRecord,
    reason: DeviceRevocationReason,
    at: string,
    replacedByDeviceId: string | null,
  ): void {
    record.status = replacedByDeviceId ? "replaced" : "revoked";
    record.isActive = false;
    // FR-SEC-010: remove published keys immediately. Keep only non-key
    // lifecycle metadata for owner audit/listing.
    record.identityKey = "";
    record.senderKey = "";
    record.oneTimeKeys = [];
    record.fallbackKey = null;
    record.revokedAt = at;
    record.revokedReason = reason;
    record.replacedByDeviceId = replacedByDeviceId;
    record.updatedAt = at;
  }

  private async runRevocationHooks(
    record: DeviceRecord,
    change: "replaced" | "revoked",
  ): Promise<void> {
    const failures: unknown[] = [];
    const run = async (hook: (() => Promise<void> | void) | undefined): Promise<void> => {
      if (!hook) return;
      try {
        await hook();
      } catch (error) {
        failures.push(error);
      }
    };

    // Auth-session revocation is the first boundary; all hooks run even if
    // one fails so queued ciphertext is not retained unnecessarily.
    await run(() => this.hooks.revokeAuthSessions?.(record.userId, record.deviceId));
    await run(() => this.hooks.deleteQueuedCiphertext?.(record.userId, record.deviceId));
    await run(() => this.hooks.notifyPeers?.(record.userId, record.deviceId, change));

    if (failures.length > 0) {
      throw new Error("Device revocation hook failed.");
    }
  }
}

export function deviceSummaryView(record: DeviceRecord): DeviceSummary {
  return {
    deviceId: record.deviceId,
    isActive: record.isActive,
    status: record.status,
    algorithm: record.algorithm,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revokedAt: record.revokedAt,
    replacedByDeviceId: record.replacedByDeviceId,
    backupLinked: record.backupLink !== null,
  };
}

export function ownerBundleView(record: DeviceRecord): DeviceKeyBundle {
  if (record.status !== "active" || !record.fallbackKey) {
    throw new Error("Only active devices have published key bundles.");
  }
  return {
    schemaVersion: 1,
    algorithm: record.algorithm,
    userId: record.userId,
    deviceId: record.deviceId,
    identityKey: record.identityKey,
    senderKey: record.senderKey,
    oneTimeKeys: record.oneTimeKeys.map((key) => ({ ...key })),
    fallbackKey: { ...record.fallbackKey },
    publishedAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function directoryEntryView(record: DeviceRecord): DeviceDirectoryEntry {
  if (record.status !== "active" || !record.fallbackKey) {
    throw new Error("Only active devices appear in the public key directory.");
  }
  return {
    userId: record.userId,
    deviceId: record.deviceId,
    schemaVersion: 1,
    algorithm: record.algorithm,
    identityKey: record.identityKey,
    senderKey: record.senderKey,
    oneTimeKeys: record.oneTimeKeys.map((key) => ({ ...key })),
    fallbackKey: { ...record.fallbackKey },
    publishedAt: record.createdAt,
  };
}
