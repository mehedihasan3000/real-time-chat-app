import type { Server } from "node:http";

import * as jose from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  DeviceEnrollmentResponse,
  DeviceKeyResponse,
  DeviceListResponse,
  DevicePublicKeysResponse,
  DeviceRevocationResponse,
  KeyBackupLinkResponse,
} from "@chat/contracts";
import { generateDeviceIdentity, type DeviceIdentityMaterial } from "@chat/crypto";

import { createApp, type CreateAppOptions } from "../../apps/api/src/app.js";
import { createVerifier, mintTestToken } from "../../apps/api/src/auth/jwt.js";
import { clearSessionCache } from "../../apps/api/src/auth/session.js";
import { MemoryDeviceKeyStore } from "../../apps/api/src/keys/store.js";

/**
 * P2-01 integration — device enrollment and public key directory (TC-SEC-004 v0).
 *
 * Runs the real Express app with the in-memory device store. Proves route-level
 * behavior: one active device, explicit replacement/reset, owner-scoped 404s,
 * revoked-device denial, sensitive-action session gates, and metadata-only
 * backup linkage. No live Mongo/Olm/browser claim is made here.
 */

const ISS = "http://127.0.0.1:3000";
const AUD = "http://127.0.0.1:3001";

const hooks = {
  revokeAuthSessions: vi.fn(),
  deleteQueuedCiphertext: vi.fn(),
  notifyPeers: vi.fn(),
};

let server: Server;
let baseUrl: string;
let tokenA: string;
let tokenB: string;
let tokenC: string;
let tokenR: string;
let tokenUnverified: string;
let tokenStale: string;

type EnvelopeBody = {
  ok: boolean;
  requestId: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
};

async function mint(
  shared: Parameters<typeof mintTestToken>[0]["keyPair"],
  sub: string,
  sid: string,
  emailVerified = true,
): Promise<string> {
  const { token } = await mintTestToken({
    sub,
    sid,
    emailVerified,
    iss: ISS,
    aud: AUD,
    keyPair: shared,
  });
  return token;
}

beforeAll(async () => {
  clearSessionCache();
  const keyPair = (await jose.generateKeyPair("Ed25519", {
    extractable: true,
  })) as unknown as {
    privateKey: import("jose").CryptoKey;
    publicKey: import("jose").CryptoKey;
    kid: string;
  };
  const shared = { ...keyPair, kid: "test-kid" };

  tokenA = await mint(shared, "user-a", "sid-a");
  tokenB = await mint(shared, "user-b", "sid-b");
  tokenC = await mint(shared, "user-c", "sid-c");
  tokenR = await mint(shared, "user-r", "sid-r");
  tokenUnverified = await mint(shared, "user-u", "sid-u", false);
  tokenStale = await mint(shared, "user-s", "sid-s");

  const verifier = createVerifier({
    appOrigin: ISS,
    apiOrigin: AUD,
    resolveKey: (async () => shared.publicKey as never) as never,
  });

  const deviceKeyStore = new MemoryDeviceKeyStore(hooks);
  const options: CreateAppOptions = {
    verifier,
    deviceKeyStore,
    sessionLookup: async (sid: string) => {
      const records: Record<string, { userId: string; fresh: boolean }> = {
        "sid-a": { userId: "user-a", fresh: true },
        "sid-b": { userId: "user-b", fresh: true },
        "sid-c": { userId: "user-c", fresh: true },
        "sid-r": { userId: "user-r", fresh: true },
        "sid-u": { userId: "user-u", fresh: true },
        "sid-s": { userId: "user-s", fresh: false },
      };
      const record = records[sid];
      if (!record) return null;
      return {
        sid,
        userId: record.userId,
        revoked: false,
        authenticatedAt: record.fresh ? new Date() : new Date(Date.now() - 30 * 60 * 1000),
      };
    },
  };

  server = createApp(options).listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected ephemeral port.");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function req(path: string, token?: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

async function jsonBody(response: Response): Promise<EnvelopeBody> {
  return (await response.json()) as EnvelopeBody;
}

async function enroll(
  material: DeviceIdentityMaterial,
  token: string,
  replace?: { previousDeviceId: string; mode: "restore" | "reset" },
) {
  const body: Record<string, unknown> = { bundle: material.publicBundle };
  if (replace) body.replace = { ...replace, acknowledgeHistoryLoss: true };
  return req(`/api/v1/devices/${material.deviceId}/keys`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function clearHooks(): void {
  hooks.revokeAuthSessions.mockClear();
  hooks.deleteQueuedCiphertext.mockClear();
  hooks.notifyPeers.mockClear();
}

describe("P2-01 — single-device enrollment and public directory", () => {
  it("enrolls one active device and returns public material only", async () => {
    const material = await generateDeviceIdentity({
      deviceId: "dev-int-a1",
      oneTimeKeyCount: 3,
    });

    const response = await enroll(material, tokenA);
    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    expect(body.ok).toBe(true);
    const data = body.data as unknown as DeviceEnrollmentResponse;
    expect(Object.keys(body.data ?? {}).sort()).toEqual([
      "backupRequired",
      "device",
      "replacedDeviceId",
    ]);
    expect(data.replacedDeviceId).toBeNull();
    expect(data.backupRequired).toBe(true);
    expect(data.device.deviceId).toBe(material.deviceId);
    expect(data.device.identityKey).toBe(material.publicBundle.identityKey);
    expect(Object.keys(data.device).sort()).toEqual([
      "algorithm",
      "deviceId",
      "fallbackKey",
      "identityKey",
      "oneTimeKeys",
      "publishedAt",
      "schemaVersion",
      "senderKey",
      "updatedAt",
      "userId",
    ]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain("recoveryKey");
    expect(serialized).not.toContain("archive");

    const list = await req("/api/v1/devices", tokenA);
    expect(list.status).toBe(200);
    const listBody = await jsonBody(list);
    const listData = listBody.data as unknown as DeviceListResponse;
    expect(listData.items).toHaveLength(1);
    expect(listData.items[0]!.deviceId).toBe(material.deviceId);
    expect(listData.items[0]!.isActive).toBe(true);
    expect(listData.items[0]!.status).toBe("active");
    expect(listData.items[0]!.backupLinked).toBe(false);

    const own = await req(`/api/v1/devices/${material.deviceId}/keys`, tokenA);
    expect(own.status).toBe(200);
    const ownBody = await jsonBody(own);
    const ownData = ownBody.data as unknown as DeviceKeyResponse;
    expect(ownData.device.identityKey).toBe(material.publicBundle.identityKey);
    expect(ownData.backupLink).toBeNull();

    // The public directory is visible to another authenticated user.
    const peer = await req("/api/v1/devices/user-a/public-keys", tokenB);
    expect(peer.status).toBe(200);
    const peerBody = await jsonBody(peer);
    const peerData = peerBody.data as unknown as DevicePublicKeysResponse;
    expect(peerData.userId).toBe("user-a");
    expect(peerData.device.deviceId).toBe(material.deviceId);
    expect(peerData.device.identityKey).toBe(material.publicBundle.identityKey);
    expect(JSON.stringify(peerBody)).not.toContain("privateKey");
  });

  it("requires an explicit replacement instead of silently adding a second device", async () => {
    const second = await generateDeviceIdentity({
      deviceId: "dev-int-a2",
      oneTimeKeyCount: 2,
    });

    const response = await enroll(second, tokenA);
    expect(response.status).toBe(409);
    const body = await jsonBody(response);
    expect(body.error?.code).toBe("DEVICE_REPLACEMENT_REQUIRED");

    const peer = await req("/api/v1/devices/user-a/public-keys", tokenB);
    const peerBody = await jsonBody(peer);
    expect((peerBody.data as unknown as DevicePublicKeysResponse).device.deviceId).toBe(
      "dev-int-a1",
    );
  });

  it("rejects an unauthorized replacement and an identity change on republish", async () => {
    const wrongPrevious = await generateDeviceIdentity({
      deviceId: "dev-int-a3",
      oneTimeKeyCount: 2,
    });
    const rejected = await enroll(wrongPrevious, tokenA, {
      previousDeviceId: "dev-int-unknown",
      mode: "reset",
    });
    expect(rejected.status).toBe(409);
    expect((await jsonBody(rejected)).error?.code).toBe("DEVICE_REPLACEMENT_REQUIRED");

    // Same device ID but a fresh identity key: republishing must never rotate
    // the active identity silently.
    const rotated = await generateDeviceIdentity({
      deviceId: "dev-int-a1",
      oneTimeKeyCount: 2,
    });
    const mismatch = await enroll(rotated, tokenA);
    expect(mismatch.status).toBe(400);
    expect((await jsonBody(mismatch)).error?.code).toBe("INVALID_REQUEST");
  });

  it("performs an explicit restore, clears old keys, and runs revocation hooks", async () => {
    clearHooks();
    const replacement = await generateDeviceIdentity({
      deviceId: "dev-int-a4",
      oneTimeKeyCount: 2,
    });

    const response = await enroll(replacement, tokenA, {
      previousDeviceId: "dev-int-a1",
      mode: "restore",
    });
    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    const data = body.data as unknown as DeviceEnrollmentResponse;
    expect(data.replacedDeviceId).toBe("dev-int-a1");
    expect(data.device.deviceId).toBe("dev-int-a4");

    expect(hooks.revokeAuthSessions).toHaveBeenCalledWith("user-a", "dev-int-a1");
    expect(hooks.deleteQueuedCiphertext).toHaveBeenCalledWith("user-a", "dev-int-a1");
    expect(hooks.notifyPeers).toHaveBeenCalledWith("user-a", "dev-int-a1", "replaced");

    const oldDevice = await req("/api/v1/devices/dev-int-a1/keys", tokenA);
    expect(oldDevice.status).toBe(403);
    expect((await jsonBody(oldDevice)).error?.code).toBe("DEVICE_REVOKED");

    const peer = await req("/api/v1/devices/user-a/public-keys", tokenB);
    const peerData = (await jsonBody(peer)).data as unknown as DevicePublicKeysResponse;
    expect(peerData.device.deviceId).toBe("dev-int-a4");
    expect(peerData.device.identityKey).toBe(replacement.publicBundle.identityKey);

    const list = await req("/api/v1/devices", tokenA);
    const listData = (await jsonBody(list)).data as unknown as DeviceListResponse;
    const oldSummary = listData.items.find((item) => item.deviceId === "dev-int-a1");
    expect(oldSummary?.isActive).toBe(false);
    expect(oldSummary?.status).toBe("replaced");
    expect(oldSummary?.replacedByDeviceId).toBe("dev-int-a4");
    expect(oldSummary?.backupLinked).toBe(false);
  });

  it("keeps owner-only reads and mutations enumeration-safe for strangers", async () => {
    const strangerOwn = await req("/api/v1/devices/dev-int-a4/keys", tokenB);
    expect(strangerOwn.status).toBe(404);
    expect((await jsonBody(strangerOwn)).error?.code).toBe("NOT_FOUND");

    const strangerRevoke = await req("/api/v1/devices/dev-int-a4/revoke", tokenB, {
      method: "POST",
      body: JSON.stringify({ reason: "logout" }),
    });
    expect(strangerRevoke.status).toBe(404);

    const missing = await req("/api/v1/devices/dev-missing/keys", tokenA);
    expect(missing.status).toBe(404);

    const unknownDirectory = await req("/api/v1/devices/user-unknown/public-keys", tokenA);
    expect(unknownDirectory.status).toBe(404);

    const badLimit = await req("/api/v1/devices?limit=0", tokenA);
    expect(badLimit.status).toBe(400);
    expect((await jsonBody(badLimit)).error?.code).toBe("INVALID_REQUEST");
  });
});

describe("P2-01 — sensitive-action session gates", () => {
  it("blocks unverified, stale, and unauthenticated enrollment", async () => {
    const unverified = await generateDeviceIdentity({
      deviceId: "dev-int-u1",
      oneTimeKeyCount: 2,
    });
    const unverifiedResponse = await enroll(unverified, tokenUnverified);
    expect(unverifiedResponse.status).toBe(403);
    expect((await jsonBody(unverifiedResponse)).error?.code).toBe("FORBIDDEN");

    const stale = await generateDeviceIdentity({
      deviceId: "dev-int-s1",
      oneTimeKeyCount: 2,
    });
    const staleResponse = await enroll(stale, tokenStale);
    expect(staleResponse.status).toBe(403);
    const staleBody = await jsonBody(staleResponse);
    expect(staleBody.error?.code).toBe("FORBIDDEN");
    expect(staleBody.error?.message).toContain("Recent authentication required");

    const staleRevoke = await req("/api/v1/devices/dev-int-s1/revoke", tokenStale, {
      method: "POST",
      body: JSON.stringify({ reason: "logout" }),
    });
    expect(staleRevoke.status).toBe(403);

    const staleBackup = await req("/api/v1/key-backups/link", tokenStale, {
      method: "POST",
      body: JSON.stringify({
        deviceId: "dev-int-s1",
        backupId: "backup-int-0001",
        kid: stale.publicBundle.oneTimeKeys[0]!.keyId,
        archiveFormat: "aes-256-gcm+hkdf-sha256",
        schemaVersion: 1,
      }),
    });
    expect(staleBackup.status).toBe(403);

    const anonymous = await req("/api/v1/devices/dev-int-s1/keys", undefined, {
      method: "POST",
      body: JSON.stringify({ bundle: stale.publicBundle }),
    });
    expect(anonymous.status).toBe(401);
    expect((await jsonBody(anonymous)).error?.code).toBe("UNAUTHENTICATED");
  });
});

describe("P2-01 — revocation boundary", () => {
  it("revokes immediately, clears published keys, and is idempotent", async () => {
    clearHooks();
    const material = await generateDeviceIdentity({
      deviceId: "dev-int-r1",
      oneTimeKeyCount: 2,
    });
    expect((await enroll(material, tokenR)).status).toBe(200);

    const invalidReason = await req("/api/v1/devices/dev-int-r1/revoke", tokenR, {
      method: "POST",
      body: JSON.stringify({ reason: "because" }),
    });
    expect(invalidReason.status).toBe(400);

    const response = await req("/api/v1/devices/dev-int-r1/revoke", tokenR, {
      method: "POST",
      body: JSON.stringify({ reason: "logout" }),
    });
    expect(response.status).toBe(200);
    const body = await jsonBody(response);
    const data = body.data as unknown as DeviceRevocationResponse;
    expect(Object.keys(body.data ?? {}).sort()).toEqual([
      "deviceId",
      "replacedByDeviceId",
      "revokedAt",
      "status",
    ]);
    expect(data.deviceId).toBe("dev-int-r1");
    expect(data.status).toBe("revoked");
    expect(data.replacedByDeviceId).toBeNull();
    expect(Date.parse(data.revokedAt)).not.toBeNaN();

    expect(hooks.revokeAuthSessions).toHaveBeenCalledWith("user-r", "dev-int-r1");
    expect(hooks.deleteQueuedCiphertext).toHaveBeenCalledWith("user-r", "dev-int-r1");
    expect(hooks.notifyPeers).toHaveBeenCalledWith("user-r", "dev-int-r1", "revoked");

    const own = await req("/api/v1/devices/dev-int-r1/keys", tokenR);
    expect(own.status).toBe(403);
    expect((await jsonBody(own)).error?.code).toBe("DEVICE_REVOKED");

    const peer = await req("/api/v1/devices/user-r/public-keys", tokenB);
    expect(peer.status).toBe(404);

    const list = await req("/api/v1/devices", tokenR);
    const listData = (await jsonBody(list)).data as unknown as DeviceListResponse;
    expect(listData.items).toHaveLength(1);
    expect(listData.items[0]!.status).toBe("revoked");
    expect(listData.items[0]!.isActive).toBe(false);
    expect(listData.items[0]!.revokedAt).toBe(data.revokedAt);

    const again = await req("/api/v1/devices/dev-int-r1/revoke", tokenR, {
      method: "POST",
      body: JSON.stringify({ reason: "logout" }),
    });
    expect(again.status).toBe(200);
    expect(hooks.revokeAuthSessions).toHaveBeenCalledTimes(1);
    expect(hooks.deleteQueuedCiphertext).toHaveBeenCalledTimes(1);

    const missing = await req("/api/v1/devices/dev-int-missing/revoke", tokenR, {
      method: "POST",
      body: JSON.stringify({ reason: "logout" }),
    });
    expect(missing.status).toBe(404);
  });
});

describe("P2-01 — key-backup linkage is metadata only", () => {
  it("links metadata, rejects private fields, and blocks cross-device reuse", async () => {
    clearHooks();
    const first = await generateDeviceIdentity({
      deviceId: "dev-int-c1",
      oneTimeKeyCount: 2,
    });
    expect((await enroll(first, tokenC)).status).toBe(200);
    const firstKid = first.publicBundle.oneTimeKeys[0]!.keyId;

    const base = {
      deviceId: first.deviceId,
      backupId: "backup-int-0001",
      kid: firstKid,
      archiveFormat: "aes-256-gcm+hkdf-sha256",
      schemaVersion: 1,
    };

    for (const forbidden of ["recoveryKey", "archive", "ciphertext", "plaintext", "manifest"]) {
      const rejected = await req("/api/v1/key-backups/link", tokenC, {
        method: "POST",
        body: JSON.stringify({ ...base, [forbidden]: "synthetic" }),
      });
      expect(rejected.status).toBe(400);
      expect((await jsonBody(rejected)).error?.code).toBe("INVALID_REQUEST");
    }

    const badFormat = await req("/api/v1/key-backups/link", tokenC, {
      method: "POST",
      body: JSON.stringify({ ...base, archiveFormat: "aes-256-cbc" }),
    });
    expect(badFormat.status).toBe(400);

    const linked = await req("/api/v1/key-backups/link", tokenC, {
      method: "POST",
      body: JSON.stringify(base),
    });
    expect(linked.status).toBe(200);
    const linkedBody = await jsonBody(linked);
    const linkedData = linkedBody.data as unknown as KeyBackupLinkResponse;
    expect(Object.keys(linkedBody.data ?? {}).sort()).toEqual(["deviceId", "link"]);
    expect(linkedData.deviceId).toBe(first.deviceId);
    expect(linkedData.link.backupId).toBe("backup-int-0001");
    expect(linkedData.link.kid).toBe(firstKid);
    expect(linkedData.link.archiveFormat).toBe("aes-256-gcm+hkdf-sha256");
    expect(Object.keys(linkedData.link).sort()).toEqual([
      "archiveFormat",
      "backupId",
      "createdAt",
      "kid",
      "schemaVersion",
    ]);

    const own = await req(`/api/v1/devices/${first.deviceId}/keys`, tokenC);
    const ownData = (await jsonBody(own)).data as unknown as DeviceKeyResponse;
    expect(ownData.backupLink?.backupId).toBe("backup-int-0001");

    const list = await req("/api/v1/devices", tokenC);
    const listData = (await jsonBody(list)).data as unknown as DeviceListResponse;
    expect(listData.items[0]!.backupLinked).toBe(true);

    // A revoked device cannot link a backup.
    expect(
      (
        await req(`/api/v1/devices/${first.deviceId}/revoke`, tokenC, {
          method: "POST",
          body: JSON.stringify({ reason: "logout" }),
        })
      ).status,
    ).toBe(200);
    const revokedLink = await req("/api/v1/key-backups/link", tokenC, {
      method: "POST",
      body: JSON.stringify({ ...base, backupId: "backup-int-0002" }),
    });
    expect(revokedLink.status).toBe(403);
    expect((await jsonBody(revokedLink)).error?.code).toBe("DEVICE_REVOKED");

    // A new device cannot reuse the previous device's backup metadata.
    const second = await generateDeviceIdentity({
      deviceId: "dev-int-c2",
      oneTimeKeyCount: 2,
    });
    expect((await enroll(second, tokenC)).status).toBe(200);
    const secondKid = second.publicBundle.oneTimeKeys[0]!.keyId;

    const duplicateBackup = await req("/api/v1/key-backups/link", tokenC, {
      method: "POST",
      body: JSON.stringify({ ...base, deviceId: second.deviceId, kid: secondKid }),
    });
    expect(duplicateBackup.status).toBe(409);
    expect((await jsonBody(duplicateBackup)).error?.code).toBe("IDEMPOTENCY_CONFLICT");

    const duplicateKid = await req("/api/v1/key-backups/link", tokenC, {
      method: "POST",
      body: JSON.stringify({
        ...base,
        deviceId: second.deviceId,
        backupId: "backup-int-0003",
        kid: firstKid,
      }),
    });
    expect(duplicateKid.status).toBe(409);

    const fresh = await req("/api/v1/key-backups/link", tokenC, {
      method: "POST",
      body: JSON.stringify({
        ...base,
        deviceId: second.deviceId,
        backupId: "backup-int-0003",
        kid: secondKid,
      }),
    });
    expect(fresh.status).toBe(200);

    const unknownDevice = await req("/api/v1/key-backups/link", tokenC, {
      method: "POST",
      body: JSON.stringify({ ...base, deviceId: "dev-int-unknown", kid: secondKid }),
    });
    expect(unknownDevice.status).toBe(404);
  });
});
