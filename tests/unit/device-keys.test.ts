import { describe, expect, it, vi } from "vitest";

import {
  DEVICE_KEY_SCHEMA_VERSION,
  ERROR_HTTP_STATUS,
  validateDeviceEnrollmentRequest,
  validateDevicePublicKeyBundle,
  validateKeyBackupLinkRequest,
  type DeviceKeyBundle,
} from "@chat/contracts";
import {
  DeviceApiError,
  DeviceDirectoryVerificationError,
  DeviceEnrollmentClient,
  PeerKeyGuard,
  acceptPeerKeyChange,
  assertPrivateKeysNonExtractable,
  canSendToPeer,
  detectCryptoCapabilities,
  findForbiddenField,
  generateDeviceIdentity,
  markPeerVerified,
  observePeerIdentity,
  refreshOneTimeKeys,
  safetyNumberFor,
  toPublicBundle,
  type DeviceIdentityMaterial,
} from "@chat/crypto";
import {
  MemoryDeviceKeyStore,
  deviceSummaryView,
  directoryEntryView,
  ownerBundleView,
} from "../../apps/api/src/keys/store.js";

const T0 = new Date("2026-11-10T10:00:00.000Z");
const T1 = new Date("2026-11-10T11:00:00.000Z");

async function identity(deviceId: string, count = 2): Promise<DeviceIdentityMaterial> {
  return generateDeviceIdentity({ deviceId, oneTimeKeyCount: count, now: T0 });
}

function serverBundle(
  material: DeviceIdentityMaterial,
  userId = "user-a",
  publishedAt = T0.toISOString(),
): DeviceKeyBundle {
  return {
    schemaVersion: DEVICE_KEY_SCHEMA_VERSION,
    algorithm: material.algorithm,
    userId,
    deviceId: material.deviceId,
    identityKey: material.publicBundle.identityKey,
    senderKey: material.publicBundle.senderKey,
    oneTimeKeys: material.publicBundle.oneTimeKeys.map((key) => ({ ...key })),
    fallbackKey: {
      ...material.publicBundle.fallbackKey,
      publishedAt,
      expiresAt: new Date(Date.parse(publishedAt) + 30 * 86_400_000).toISOString(),
    },
    publishedAt,
    updatedAt: publishedAt,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("TC-SEC-004 v0 — device directory contracts", () => {
  it("accepts a public-only bundle and rejects private material or malformed keys", async () => {
    const material = await identity("device-contract-1");
    expect(validateDevicePublicKeyBundle(material.publicBundle).ok).toBe(true);

    const withPrivate = {
      ...material.publicBundle,
      privateKey: "synthetic-private-material",
    };
    expect(validateDevicePublicKeyBundle(withPrivate).ok).toBe(false);

    const shortKey = {
      ...material.publicBundle,
      identityKey: "too-short",
    };
    expect(validateDevicePublicKeyBundle(shortKey).ok).toBe(false);

    const duplicate = {
      ...material.publicBundle,
      oneTimeKeys: [
        material.publicBundle.oneTimeKeys[0],
        {
          ...material.publicBundle.oneTimeKeys[1],
          keyId: material.publicBundle.oneTimeKeys[0]!.keyId,
        },
      ],
    };
    expect(validateDevicePublicKeyBundle(duplicate).ok).toBe(false);

    const badAlgorithm = { ...material.publicBundle, algorithm: "custom-crypto" };
    expect(validateDevicePublicKeyBundle(badAlgorithm).ok).toBe(false);

    const wrongDevice = validateDevicePublicKeyBundle(material.publicBundle, "device-contract-2");
    expect(wrongDevice.ok).toBe(false);
  });

  it("requires explicit replacement mode and history-loss acknowledgement", async () => {
    const previous = await identity("device-previous-1");
    const next = await identity("device-next-1");

    const missingReplace = validateDeviceEnrollmentRequest({ bundle: next.publicBundle });
    expect(missingReplace.ok).toBe(true);

    const replacement = validateDeviceEnrollmentRequest({
      bundle: next.publicBundle,
      replace: {
        previousDeviceId: previous.deviceId,
        mode: "reset",
        acknowledgeHistoryLoss: true,
      },
    });
    expect(replacement.ok).toBe(true);

    const noAck = validateDeviceEnrollmentRequest({
      bundle: next.publicBundle,
      replace: {
        previousDeviceId: previous.deviceId,
        mode: "reset",
        acknowledgeHistoryLoss: false,
      },
    });
    expect(noAck.ok).toBe(false);

    const selfReplace = validateDeviceEnrollmentRequest({
      bundle: next.publicBundle,
      replace: {
        previousDeviceId: next.deviceId,
        mode: "reset",
        acknowledgeHistoryLoss: true,
      },
    });
    expect(selfReplace.ok).toBe(false);
  });

  it("keeps backup linkage metadata-only and rejects recovery/archive/plaintext fields", async () => {
    const material = await identity("device-backup-1");
    const base = {
      deviceId: material.deviceId,
      backupId: "backup-0001",
      kid: material.publicBundle.oneTimeKeys[0]!.keyId,
      archiveFormat: "aes-256-gcm+hkdf-sha256",
      schemaVersion: 1,
    };
    expect(validateKeyBackupLinkRequest(base).ok).toBe(true);
    for (const forbidden of ["recoveryKey", "archive", "ciphertext", "plaintext", "manifest"]) {
      expect(validateKeyBackupLinkRequest({ ...base, [forbidden]: "synthetic" }).ok).toBe(false);
    }
    expect(ERROR_HTTP_STATUS.DEVICE_REVOKED).toBe(403);
    expect(ERROR_HTTP_STATUS.DEVICE_REPLACEMENT_REQUIRED).toBe(409);
  });
});

describe("TC-SEC-004 v0 — one-active-device store and revocation boundary", () => {
  it("enrolls one active device and exposes only public material", async () => {
    const store = new MemoryDeviceKeyStore();
    const material = await identity("device-store-1");

    const enrolled = await store.enroll("user-a", material.publicBundle, undefined, T0);
    expect(enrolled.ok).toBe(true);
    if (!enrolled.ok) return;
    expect(enrolled.record.status).toBe("active");
    expect(enrolled.replacedDeviceId).toBeNull();

    const list = await store.listOwn("user-a", 50);
    expect(list).toHaveLength(1);
    expect(deviceSummaryView(list[0]!).isActive).toBe(true);

    const directory = await store.getActivePublicKeys("user-a");
    expect(directory?.identityKey).toBe(material.publicBundle.identityKey);
    expect(findForbiddenField(directory)).toBeNull();
    expect(findForbiddenField(ownerBundleView(enrolled.record))).toBeNull();
    expect(JSON.stringify(directoryEntryView(enrolled.record))).not.toContain("privateKey");
    expect(store.audit.map((entry) => entry.action)).toContain("device.enrolled");
  });

  it("republishes keys without changing identity and preserves fallback publication time", async () => {
    const store = new MemoryDeviceKeyStore();
    const material = await identity("device-store-2");
    const first = await store.enroll("user-a", material.publicBundle, undefined, T0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const fallbackPublishedAt = first.record.fallbackKey?.publishedAt;

    const refreshed = await refreshOneTimeKeys(material, 3);
    const second = await store.enroll("user-a", refreshed.publicBundle, undefined, T1);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.record.identityKey).toBe(material.publicBundle.identityKey);
    expect(second.record.oneTimeKeys).toHaveLength(3);
    expect(second.record.fallbackKey?.publishedAt).toBe(fallbackPublishedAt);
    expect(second.record.updatedAt).toBe(T1.toISOString());
    expect(store.audit.map((entry) => entry.action)).toContain("device.republished");

    const differentIdentity = await generateDeviceIdentity({
      deviceId: material.deviceId,
      oneTimeKeyCount: 2,
      now: T1,
    });
    const mismatch = await store.enroll("user-a", differentIdentity.publicBundle, undefined, T1);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.code).toBe("IDENTITY_MISMATCH");
  });

  it("does not silently add a second device and rejects an unauthorized replacement", async () => {
    const store = new MemoryDeviceKeyStore();
    const first = await identity("device-store-3a");
    const second = await identity("device-store-3b");
    await store.enroll("user-a", first.publicBundle, undefined, T0);

    const silent = await store.enroll("user-a", second.publicBundle, undefined, T1);
    expect(silent.ok).toBe(false);
    if (!silent.ok) expect(silent.code).toBe("REPLACEMENT_REQUIRED");
    expect((await store.getActivePublicKeys("user-a"))?.deviceId).toBe(first.deviceId);

    const wrongPrevious = await store.enroll(
      "user-a",
      second.publicBundle,
      { previousDeviceId: "device-unknown-1", mode: "reset", acknowledgeHistoryLoss: true },
      T1,
    );
    expect(wrongPrevious.ok).toBe(false);
    if (!wrongPrevious.ok) expect(wrongPrevious.code).toBe("REPLACEMENT_REQUIRED");
    expect((await store.getActivePublicKeys("user-a"))?.deviceId).toBe(first.deviceId);
  });

  it("replaces explicitly, clears old keys, and runs revocation hooks", async () => {
    const hooks = {
      revokeAuthSessions: vi.fn(),
      deleteQueuedCiphertext: vi.fn(),
      notifyPeers: vi.fn(),
    };
    const store = new MemoryDeviceKeyStore(hooks);
    const first = await identity("device-store-4a");
    const second = await identity("device-store-4b");
    await store.enroll("user-a", first.publicBundle, undefined, T0);

    const replaced = await store.enroll(
      "user-a",
      second.publicBundle,
      { previousDeviceId: first.deviceId, mode: "restore", acknowledgeHistoryLoss: true },
      T1,
    );
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.replacedDeviceId).toBe(first.deviceId);

    const old = await store.getOwn("user-a", first.deviceId);
    expect(old?.status).toBe("replaced");
    expect(old?.identityKey).toBe("");
    expect(old?.oneTimeKeys).toEqual([]);
    expect(old?.fallbackKey).toBeNull();
    expect(old?.replacedByDeviceId).toBe(second.deviceId);

    expect((await store.getActivePublicKeys("user-a"))?.deviceId).toBe(second.deviceId);
    expect(hooks.revokeAuthSessions).toHaveBeenCalledWith("user-a", first.deviceId);
    expect(hooks.deleteQueuedCiphertext).toHaveBeenCalledWith("user-a", first.deviceId);
    expect(hooks.notifyPeers).toHaveBeenCalledWith("user-a", first.deviceId, "replaced");

    const oldRepublish = await store.enroll("user-a", first.publicBundle, undefined, T1);
    expect(oldRepublish.ok).toBe(false);
    if (!oldRepublish.ok) expect(oldRepublish.code).toBe("DEVICE_REVOKED");
    expect(store.audit.map((entry) => entry.action)).toContain("device.replaced");
  });

  it("revokes immediately, clears published keys, and is idempotent", async () => {
    const hooks = {
      revokeAuthSessions: vi.fn(),
      deleteQueuedCiphertext: vi.fn(),
      notifyPeers: vi.fn(),
    };
    const store = new MemoryDeviceKeyStore(hooks);
    const material = await identity("device-store-5");
    await store.enroll("user-a", material.publicBundle, undefined, T0);

    const revoked = await store.revoke("user-a", material.deviceId, "logout", T1);
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;
    expect(revoked.record.status).toBe("revoked");
    expect(revoked.record.identityKey).toBe("");
    expect(revoked.record.isActive).toBe(false);
    expect(await store.getActivePublicKeys("user-a")).toBeNull();
    expect(hooks.revokeAuthSessions).toHaveBeenCalledTimes(1);
    expect(hooks.deleteQueuedCiphertext).toHaveBeenCalledTimes(1);
    expect(hooks.notifyPeers).toHaveBeenCalledWith("user-a", material.deviceId, "revoked");

    const again = await store.revoke("user-a", material.deviceId, "logout", T1);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.alreadyRevoked).toBe(true);
    expect(hooks.revokeAuthSessions).toHaveBeenCalledTimes(1);
  });

  it("links backup metadata only, rejects a revoked device, and prevents cross-device reuse", async () => {
    const store = new MemoryDeviceKeyStore();
    const first = await identity("device-store-6a");
    const second = await identity("device-store-6b");
    await store.enroll("user-a", first.publicBundle, undefined, T0);

    const link = await store.linkBackup(
      "user-a",
      {
        deviceId: first.deviceId,
        backupId: "backup-0002",
        kid: first.publicBundle.oneTimeKeys[0]!.keyId,
        archiveFormat: "aes-256-gcm+hkdf-sha256",
        schemaVersion: 1,
      },
      T1,
    );
    expect(link.ok).toBe(true);
    if (!link.ok) return;
    expect(link.link.backupId).toBe("backup-0002");
    expect(deviceSummaryView(link.record).backupLinked).toBe(true);
    expect(findForbiddenField(link.link)).toBeNull();

    const idempotent = await store.linkBackup(
      "user-a",
      {
        deviceId: first.deviceId,
        backupId: "backup-0002",
        kid: first.publicBundle.oneTimeKeys[0]!.keyId,
        archiveFormat: "aes-256-gcm+hkdf-sha256",
        schemaVersion: 1,
      },
      T1,
    );
    expect(idempotent.ok).toBe(true);

    await store.revoke("user-a", first.deviceId, "logout", T1);
    const revokedLink = await store.linkBackup(
      "user-a",
      {
        deviceId: first.deviceId,
        backupId: "backup-0003",
        kid: first.publicBundle.oneTimeKeys[0]!.keyId,
        archiveFormat: "aes-256-gcm+hkdf-sha256",
        schemaVersion: 1,
      },
      T1,
    );
    expect(revokedLink.ok).toBe(false);
    if (!revokedLink.ok) expect(revokedLink.code).toBe("DEVICE_REVOKED");

    await store.enroll("user-a", second.publicBundle, undefined, T1);
    const reused = await store.linkBackup(
      "user-a",
      {
        deviceId: second.deviceId,
        backupId: "backup-0002",
        kid: second.publicBundle.oneTimeKeys[0]!.keyId,
        archiveFormat: "aes-256-gcm+hkdf-sha256",
        schemaVersion: 1,
      },
      T1,
    );
    expect(reused.ok).toBe(false);
    if (!reused.ok) expect(reused.code).toBe("CONFLICT");
  });
});

describe("TC-SEC-004 v0 — capability preflight and key generation", () => {
  it("fails closed when required browser capabilities are absent", async () => {
    const nodeReport = await detectCryptoCapabilities();
    expect(nodeReport.provisional).toBe(true);
    expect(nodeReport.indexedDb).toBe(false);
    expect(nodeReport.ready).toBe(false);
    expect(nodeReport.missing).toContain("indexeddb");

    const fakeReady = await detectCryptoCapabilities({
      crypto: globalThis.crypto,
      indexedDB: {},
      navigator: { locks: {} },
      WebAssembly: globalThis.WebAssembly,
      isSecureContext: true,
    });
    expect(fakeReady.ready).toBe(true);
    expect(fakeReady.missing).toEqual([]);

    const insecure = await detectCryptoCapabilities({
      crypto: globalThis.crypto,
      indexedDB: {},
      navigator: { locks: {} },
      WebAssembly: globalThis.WebAssembly,
      isSecureContext: false,
    });
    expect(insecure.ready).toBe(false);
    expect(insecure.missing).toContain("secure-context");

    const noCrypto = await detectCryptoCapabilities({ isSecureContext: true });
    expect(noCrypto.missing).toContain("web-crypto");
    expect(noCrypto.missing).toContain("ed25519");
    expect(noCrypto.missing).toContain("x25519");
  });

  it("generates non-extractable private keys and a public-only request bundle", async () => {
    const material = await generateDeviceIdentity({
      deviceId: "device-generate-1",
      oneTimeKeyCount: 2,
      now: T0,
    });
    assertPrivateKeysNonExtractable(material);
    expect(material.identityKeyPair.privateKey.extractable).toBe(false);
    expect(material.senderKeyPair.privateKey.extractable).toBe(false);
    expect(findForbiddenField(material.publicBundle)).toBeNull();
    expect(JSON.stringify(toPublicBundle(material))).not.toContain("privateKey");
    expect(material.publicBundle.oneTimeKeys).toHaveLength(2);
    expect(validateDevicePublicKeyBundle(material.publicBundle).ok).toBe(true);
  });
});

describe("TC-SEC-004 v0 — safety number and peer key-change block", () => {
  it("derives a symmetric 60-digit safety number and changes on identity change", async () => {
    const first = await identity("device-safety-1");
    const second = await identity("device-safety-2");
    const third = await identity("device-safety-3");

    const a = await safetyNumberFor(
      { userId: "user-a", identityKey: first.publicBundle.identityKey },
      { userId: "user-b", identityKey: second.publicBundle.identityKey },
    );
    const b = await safetyNumberFor(
      { userId: "user-b", identityKey: second.publicBundle.identityKey },
      { userId: "user-a", identityKey: first.publicBundle.identityKey },
    );
    expect(a.digits).toBe(b.digits);
    expect(a.digits).toHaveLength(60);
    expect(a.groups).toHaveLength(12);
    expect(a.groups.every((group) => /^\d{5}$/.test(group))).toBe(true);

    const changed = await safetyNumberFor(
      { userId: "user-a", identityKey: first.publicBundle.identityKey },
      { userId: "user-b", identityKey: third.publicBundle.identityKey },
    );
    expect(changed.digits).not.toBe(a.digits);

    await expect(
      safetyNumberFor(
        { userId: "user-a", identityKey: first.publicBundle.identityKey },
        { userId: "user-a", identityKey: first.publicBundle.identityKey },
      ),
    ).rejects.toThrow();
  });

  it("blocks sending after a peer key change until explicit acceptance", async () => {
    const first = await identity("device-trust-1");
    const second = await identity("device-trust-2");
    const t0 = T0.toISOString();
    const t1 = T1.toISOString();

    const firstContact = observePeerIdentity(null, "user-b", first.publicBundle.identityKey, t0);
    expect(firstContact.status).toBe("first-contact");
    expect(firstContact.sendAllowed).toBe(true);
    expect(firstContact.verificationRequired).toBe(true);

    const unchanged = observePeerIdentity(
      firstContact.state,
      "user-b",
      first.publicBundle.identityKey,
      t1,
    );
    expect(unchanged.status).toBe("unchanged");
    expect(canSendToPeer(unchanged.state)).toBe(true);

    const changed = observePeerIdentity(
      firstContact.state,
      "user-b",
      second.publicBundle.identityKey,
      t1,
    );
    expect(changed.status).toBe("changed");
    expect(changed.sendAllowed).toBe(false);
    expect(changed.state.verified).toBe(false);
    expect(canSendToPeer(changed.state)).toBe(false);
    expect(() => markPeerVerified(changed.state, t1)).toThrow();

    const accepted = acceptPeerKeyChange(changed.state, second.publicBundle.identityKey, t1);
    expect(accepted.sendAllowed).toBe(true);
    expect(accepted.state.verified).toBe(false);
    expect(canSendToPeer(accepted.state)).toBe(true);

    const verified = markPeerVerified(accepted.state, t1);
    expect(verified.state.verified).toBe(true);
  });

  it("guards a peer across observations with a single guard instance", async () => {
    const first = await identity("device-trust-3");
    const second = await identity("device-trust-4");
    const guard = new PeerKeyGuard(undefined, () => T1);

    expect(guard.canSend("user-b")).toBe(false);
    const observed = guard.observe("user-b", first.publicBundle.identityKey);
    expect(observed.status).toBe("first-contact");
    expect(guard.canSend("user-b")).toBe(true);

    const changed = guard.observe("user-b", second.publicBundle.identityKey);
    expect(changed.status).toBe("changed");
    expect(guard.canSend("user-b")).toBe(false);

    const accepted = guard.accept("user-b");
    expect(accepted.state.identityKey).toBe(second.publicBundle.identityKey);
    expect(guard.canSend("user-b")).toBe(true);
  });
});

describe("TC-SEC-004 v0 — enrollment client verifies server responses", () => {
  it("sends public material only and verifies the published bundle", async () => {
    const material = await identity("device-client-1");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({
        ok: true,
        requestId: "synthetic-request",
        data: {
          device: serverBundle(material),
          replacedDeviceId: null,
          backupRequired: true,
        },
      });
    }) as typeof fetch;

    const client = new DeviceEnrollmentClient({
      apiOrigin: "http://127.0.0.1:3001",
      expectedUserId: "user-a",
      getToken: () => "synthetic-token",
      fetchImpl,
    });
    const response = await client.enroll(material);
    expect(response.device.identityKey).toBe(material.publicBundle.identityKey);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://127.0.0.1:3001/api/v1/devices/${material.deviceId}/keys`);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer synthetic-token");
    expect(calls[0]!.init.credentials).toBe("omit");

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(findForbiddenField(body)).toBeNull();
    expect(JSON.stringify(body)).not.toContain("privateKey");
    expect(JSON.stringify(body)).not.toContain("recoveryKey");
  });

  it("fails closed on a substituted identity key or a replacement-required response", async () => {
    const material = await identity("device-client-2");
    const substituted = serverBundle(material);
    substituted.identityKey = (await identity("device-client-3")).publicBundle.identityKey;

    const substitutionClient = new DeviceEnrollmentClient({
      apiOrigin: "http://127.0.0.1:3001",
      expectedUserId: "user-a",
      getToken: () => "synthetic-token",
      fetchImpl: (async () =>
        jsonResponse({
          ok: true,
          requestId: "synthetic-request",
          data: {
            device: substituted,
            replacedDeviceId: null,
            backupRequired: true,
          },
        })) as typeof fetch,
    });
    await expect(substitutionClient.enroll(material)).rejects.toBeInstanceOf(
      DeviceDirectoryVerificationError,
    );

    const conflictClient = new DeviceEnrollmentClient({
      apiOrigin: "http://127.0.0.1:3001",
      expectedUserId: "user-a",
      getToken: () => "synthetic-token",
      fetchImpl: (async () =>
        jsonResponse(
          {
            ok: false,
            requestId: "synthetic-request",
            error: {
              code: "DEVICE_REPLACEMENT_REQUIRED",
              message: "An active device already exists.",
              retryable: false,
            },
          },
          409,
        )) as typeof fetch,
    });
    await expect(conflictClient.enroll(material)).rejects.toMatchObject({
      name: "DeviceApiError",
      code: "DEVICE_REPLACEMENT_REQUIRED",
      status: 409,
    });
  });

  it("verifies peer directory entries and sends only backup-link metadata", async () => {
    const material = await identity("device-client-4");
    const directory = {
      userId: "user-a",
      device: {
        userId: "user-a",
        deviceId: material.deviceId,
        schemaVersion: 1,
        algorithm: material.algorithm,
        identityKey: material.publicBundle.identityKey,
        senderKey: material.publicBundle.senderKey,
        oneTimeKeys: material.publicBundle.oneTimeKeys,
        fallbackKey: {
          ...material.publicBundle.fallbackKey,
          publishedAt: T0.toISOString(),
          expiresAt: new Date(T0.getTime() + 30 * 86_400_000).toISOString(),
        },
        publishedAt: T0.toISOString(),
      },
    };
    const bodies: unknown[] = [];
    const client = new DeviceEnrollmentClient({
      apiOrigin: "http://127.0.0.1:3001",
      expectedUserId: "user-a",
      getToken: () => "synthetic-token",
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        if (String(_input).includes("public-keys")) {
          return jsonResponse({ ok: true, requestId: "synthetic-request", data: directory });
        }
        return jsonResponse({
          ok: true,
          requestId: "synthetic-request",
          data: {
            deviceId: material.deviceId,
            link: {
              backupId: "backup-0004",
              kid: material.publicBundle.oneTimeKeys[0]!.keyId,
              archiveFormat: "aes-256-gcm+hkdf-sha256",
              schemaVersion: 1,
              createdAt: T0.toISOString(),
            },
          },
        });
      }) as typeof fetch,
    });

    const peer = await client.getPeer("user-a");
    expect(peer.identityKey).toBe(material.publicBundle.identityKey);
    const linked = await client.linkBackup(
      material.deviceId,
      "backup-0004",
      material.publicBundle.oneTimeKeys[0]!.keyId,
    );
    expect(linked.link.backupId).toBe("backup-0004");
    expect(findForbiddenField(bodies[0])).toBeNull();
    expect(JSON.stringify(bodies[0])).toContain("aes-256-gcm+hkdf-sha256");
  });

  it("surfaces safe API errors without raw response text", async () => {
    const material = await identity("device-client-5");
    const client = new DeviceEnrollmentClient({
      apiOrigin: "http://127.0.0.1:3001",
      expectedUserId: "user-a",
      getToken: () => "synthetic-token",
      fetchImpl: (async () =>
        jsonResponse(
          {
            ok: false,
            requestId: "synthetic-request",
            error: { code: "DEVICE_REVOKED", message: "This device is revoked.", retryable: false },
          },
          403,
        )) as typeof fetch,
    });
    await expect(client.revoke(material.deviceId, "logout")).rejects.toBeInstanceOf(DeviceApiError);
  });
});
