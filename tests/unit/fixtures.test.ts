import { describe, expect, it } from "vitest";

import {
  aiConsentStates,
  bengaliContent,
  callStates,
  deliveryStates,
  deviceKeyStates,
  directNetworkProfile,
  duplicateMessage,
  emptyStates,
  englishContent,
  keyStates,
  mixedUnicodeContent,
  networkProfiles,
  participantA,
  participantB,
  participants,
  relayNetworkProfile,
  relayLossyNetworkProfile,
  sessionStates,
  syntheticPairKey,
  syntheticThread,
  syntheticUsers,
  tamperedDuplicateMessage,
  unrelatedUser,
  unicodeEdgeCases,
} from "../fixtures/index.js";
import {
  createProviderMocks,
  SyntheticAiProvider,
  SyntheticProviderError,
} from "../fixtures/providers.js";

describe("synthetic user fixtures", () => {
  it("provide two participants and one unrelated user", () => {
    expect(syntheticUsers).toHaveLength(3);
    expect(participants).toHaveLength(2);
    expect(participantA.role).toBe("participant");
    expect(participantB.role).toBe("participant");
    expect(unrelatedUser.role).toBe("unrelated");
  });

  it("use unique synthetic identifiers and usernames", () => {
    expect(new Set(syntheticUsers.map((user) => user.userId)).size).toBe(3);
    expect(new Set(syntheticUsers.map((user) => user.username)).size).toBe(3);
    expect(new Set(syntheticUsers.map((user) => user.displayName)).size).toBe(3);
  });

  it("keep usernames inside the recorded ASCII policy", () => {
    for (const user of syntheticUsers) {
      expect(user.username).toMatch(/^[a-z][a-z0-9_]{2,23}$/);
    }
  });

  it("cover both locales and Bengali display text", () => {
    expect(syntheticUsers.some((user) => user.locale === "en")).toBe(true);
    expect(syntheticUsers.some((user) => user.locale === "bn")).toBe(true);
    expect(participantB.displayName).toMatch(/[\u0980-\u09ff]/);
  });

  it("derive the pair key from sorted participant IDs", () => {
    expect(syntheticPairKey).toBe([participantA.userId, participantB.userId].sort().join(":"));
  });

  it("are explicitly marked synthetic", () => {
    for (const user of syntheticUsers) {
      expect(user.synthetic).toBe(true);
    }
  });
});

describe("synthetic content fixtures", () => {
  it("cover English, Bengali, and mixed Unicode content", () => {
    expect(englishContent.locale).toBe("en");
    expect(bengaliContent.locale).toBe("bn");
    expect(mixedUnicodeContent.locale).toBe("mixed");
    expect(bengaliContent.body).toMatch(/[\u0980-\u09ff]/);
    expect(mixedUnicodeContent.body).toContain(unicodeEdgeCases.emoji);
  });

  it("preserve Unicode edge cases without normalization loss", () => {
    expect(unicodeEdgeCases.combiningMark).toBe("e\u0301");
    expect(unicodeEdgeCases.familyEmoji).toBe("👨‍👩‍👧‍👦");
    expect(unicodeEdgeCases.zeroWidthJoiner).toBe("\u200d");
    expect(unicodeEdgeCases.nonBreakingSpace).toBe("\u00a0");
    expect(unicodeEdgeCases.longWord).toHaveLength(120);
  });

  it("model a retryable duplicate and a conflicting reuse", () => {
    expect(duplicateMessage.clientMessageId).toBe(syntheticThread[0]!.clientMessageId);
    expect(duplicateMessage.body).toBe(syntheticThread[0]!.body);
    expect(tamperedDuplicateMessage.clientMessageId).toBe(duplicateMessage.clientMessageId);
    expect(tamperedDuplicateMessage.body).not.toBe(duplicateMessage.body);
  });

  it("use UTC instants and synthetic IDs", () => {
    for (const message of syntheticThread) {
      expect(message.sentAt).toMatch(/Z$/);
      expect(message.id).toMatch(/^synth-/);
      expect(message.synthetic).toBe(true);
    }
  });
});

describe("synthetic state fixtures", () => {
  it("cover the required state families", () => {
    expect(sessionStates).toEqual(["verified", "unverified", "expired", "revoked", "invalid"]);
    expect(deviceKeyStates).toContain("revoked");
    expect(callStates).toContain("incoming");
    expect(callStates).toContain("failed");
    expect(aiConsentStates).toContain("refused");
    expect(deliveryStates).toContain("unknown");
    expect(emptyStates.length).toBeGreaterThan(0);
  });

  it("label key states with an honest limitation", () => {
    const surfaces = new Set(keyStates.map((state) => state.surface));

    expect(surfaces).toEqual(new Set(["auth", "conversation", "call", "ai", "states"]));
    for (const state of keyStates) {
      expect(state.expected.length).toBeGreaterThan(0);
      expect(state.honestLimitation.length).toBeGreaterThan(0);
      expect(state.synthetic).toBe(true);
    }
  });
});

describe("synthetic network profiles", () => {
  it("keep direct and forced-relay paths distinct", () => {
    expect(directNetworkProfile.forceRelay).toBe(false);
    expect(directNetworkProfile.iceTransportPolicy).toBe("all");
    expect(relayNetworkProfile.forceRelay).toBe(true);
    expect(relayNetworkProfile.iceTransportPolicy).toBe("relay");
    expect(relayLossyNetworkProfile.forceRelay).toBe(true);
    expect(relayLossyNetworkProfile.packetLossPercent).toBeGreaterThan(0);
  });

  it("expose every profile through one catalog", () => {
    expect(networkProfiles.map((profile) => profile.id)).toEqual([
      "direct",
      "relay",
      "relay-lossy",
    ]);
    for (const profile of networkProfiles) {
      expect(profile.synthetic).toBe(true);
      expect(profile.latencyMs).toBeGreaterThan(0);
    }
  });
});

describe("synthetic provider doubles", () => {
  it("return deterministic synthetic responses and record requests", async () => {
    const provider = new SyntheticAiProvider({ model: "synthetic-model" });
    const request = { operation: "summarize", input: "Synthetic fixture input." };

    const first = await provider.complete(request);
    const second = await provider.complete(request);

    expect(first).toEqual(second);
    expect(first.synthetic).toBe(true);
    expect(first.provider).toBe("synthetic-mock");
    expect(first.text).toContain("[synthetic:summarize]");
    expect(provider.requests).toHaveLength(2);
  });

  it("fail with a stable code instead of raw provider text", async () => {
    const provider = new SyntheticAiProvider({
      failWith: { code: "RATE_LIMITED", retryable: true },
    });

    await expect(
      provider.complete({ operation: "summarize", input: "Synthetic input." }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "SyntheticProviderError",
        synthetic: true,
        failure: { code: "RATE_LIMITED", retryable: true },
      }),
    );

    try {
      await provider.complete({ operation: "summarize", input: "Synthetic input." });
    } catch (error) {
      expect(error).toBeInstanceOf(SyntheticProviderError);
    }
  });

  it("record only minimal email routing metadata", async () => {
    const { email } = createProviderMocks();

    await email.send({ to: "synthetic@example.test", template: "verification" });

    expect(email.sent).toEqual([
      { to: "synthetic@example.test", template: "verification", synthetic: true },
    ]);
    expect(JSON.stringify(email.sent)).not.toMatch(/token|link|body/i);
  });
});

describe("fixture hygiene", () => {
  it("contains no obvious secret, credential, or production connection material", () => {
    const serialized = JSON.stringify({
      syntheticUsers,
      syntheticThread,
      keyStates,
      networkProfiles,
    });

    expect(serialized).not.toMatch(/mongodb(\+srv)?:\/\//);
    expect(serialized).not.toMatch(/\bsk-[a-zA-Z0-9]/);
    expect(serialized).not.toMatch(/\bghp_[a-zA-Z0-9]/);
    expect(serialized).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/);
    expect(serialized).not.toMatch(/password\s*[:=]/i);
  });

  it("contains no real-looking email or phone identifiers", () => {
    const serialized = JSON.stringify(syntheticUsers);

    expect(serialized).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(serialized).not.toMatch(/\+\d{7,}/);
  });
});
