import type { Locale } from "@chat/contracts";

/**
 * Synthetic identities for the test harness.
 *
 * Every value here is invented for tests. The records are not backed by Better
 * Auth, MongoDB, or any provider, and they must never be replaced with real
 * account data. Display names intentionally cover English, Bengali, and mixed
 * Unicode so localization and rendering tests have honest inputs.
 */
export type SyntheticRole = "participant" | "unrelated";

export type SyntheticUser = {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly locale: Locale;
  readonly timeZone: string;
  readonly role: SyntheticRole;
  readonly synthetic: true;
};

export const participantA = {
  userId: "synth-user-alpha",
  username: "synth_alpha",
  displayName: "Ayesha Rahman",
  locale: "en",
  timeZone: "Asia/Dhaka",
  role: "participant",
  synthetic: true,
} as const satisfies SyntheticUser;

export const participantB = {
  userId: "synth-user-beta",
  username: "synth_beta",
  displayName: "সাদিয়া আক্তার",
  locale: "bn",
  timeZone: "Asia/Dhaka",
  role: "participant",
  synthetic: true,
} as const satisfies SyntheticUser;

export const unrelatedUser = {
  userId: "synth-user-gamma",
  username: "synth_gamma",
  displayName: "Mira Sen",
  locale: "en",
  timeZone: "UTC",
  role: "unrelated",
  synthetic: true,
} as const satisfies SyntheticUser;

export const participants = [participantA, participantB] as const;
export const syntheticUsers = [participantA, participantB, unrelatedUser] as const;

/** Deterministic sorted pair key used by the conversation contract fixtures. */
export const syntheticPairKey = [participantA.userId, participantB.userId].sort().join(":");
