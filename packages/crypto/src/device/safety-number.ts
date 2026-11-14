import { base64UrlDecode } from "./encoding.js";

/**
 * Per-conversation safety number (P2-01, FR-SEC-005 / DEC-002 §4.3).
 *
 * Derived from both users' stable public identity keys, ordered by user ID so
 * both endpoints compute the same 60-digit value. This is a human-verification
 * display derivation, not an encryption primitive and not a substitute for
 * out-of-band comparison. No "verified" claim is made until users compare.
 */
export interface SafetyNumberParty {
  userId: string;
  identityKey: string;
}

export interface SafetyNumber {
  version: 1;
  algorithm: "sha-256";
  digits: string;
  groups: string[];
}

const GROUP_COUNT = 12;
const GROUP_DIGITS = 5;
const GROUP_BITS = 20;

function readBits(bytes: Uint8Array, bitOffset: number, bitCount: number): number {
  let value = 0;
  for (let index = 0; index < bitCount; index += 1) {
    const bit = bitOffset + index;
    const byte = bytes[bit >> 3] ?? 0;
    const current = (byte >> (7 - (bit & 7))) & 1;
    value = (value << 1) | current;
  }
  return value;
}

function assertParty(party: SafetyNumberParty): void {
  if (!party.userId) throw new Error("Safety number requires a user ID.");
  const key = base64UrlDecode(party.identityKey);
  if (key.length !== 32) throw new Error("Safety number identity key must be 32 bytes.");
}

export async function safetyNumberFor(
  first: SafetyNumberParty,
  second: SafetyNumberParty,
): Promise<SafetyNumber> {
  if (first.userId === second.userId) {
    throw new Error("A safety number requires two distinct users.");
  }
  assertParty(first);
  assertParty(second);

  const [left, right] = first.userId < second.userId ? [first, second] : [second, first];
  const encoder = new TextEncoder();
  const material = encoder.encode(
    ["chat-safety-number-v1", left.userId, left.identityKey, right.userId, right.identityKey].join(
      "\u0000",
    ),
  );
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", material));
  const groups: string[] = [];
  for (let index = 0; index < GROUP_COUNT; index += 1) {
    const value = readBits(digest, index * GROUP_BITS, GROUP_BITS) % 100_000;
    groups.push(String(value).padStart(GROUP_DIGITS, "0"));
  }
  return {
    version: 1,
    algorithm: "sha-256",
    digits: groups.join(""),
    groups,
  };
}
