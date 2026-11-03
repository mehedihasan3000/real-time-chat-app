/**
 * Synthetic state descriptors for the harness.
 *
 * These are test inputs, not runtime state. The current skeleton does not
 * implement auth, devices, calls, receipts, or AI, so a fixture never proves
 * those behaviors exist. It only gives later suites a shared, honest vocabulary.
 */
export const sessionStates = ["verified", "unverified", "expired", "revoked", "invalid"] as const;

export const deviceKeyStates = ["active", "rotated", "revoked", "missing"] as const;

export const callStates = [
  "incoming",
  "ringing",
  "connected",
  "ended",
  "missed",
  "failed",
] as const;

export const aiConsentStates = ["not_requested", "granted", "refused", "revoked"] as const;

export const deliveryStates = ["sent", "delivered", "read", "failed", "unknown"] as const;

export type SessionState = (typeof sessionStates)[number];
export type DeviceKeyState = (typeof deviceKeyStates)[number];
export type CallState = (typeof callStates)[number];
export type AiConsentState = (typeof aiConsentStates)[number];
export type DeliveryState = (typeof deliveryStates)[number];

export type KeyStateFixture = {
  readonly id: string;
  readonly surface: "auth" | "conversation" | "call" | "ai" | "states";
  readonly state: string;
  readonly expected: string;
  readonly honestLimitation: string;
  readonly synthetic: true;
};

export const keyStates: ReadonlyArray<KeyStateFixture> = [
  {
    id: "state-session-unverified",
    surface: "auth",
    state: "unverified",
    expected: "Profile setup is available; protected messaging, calls, and AI are unavailable.",
    honestLimitation: "No Better Auth session or email provider is wired into this skeleton.",
    synthetic: true,
  },
  {
    id: "state-session-expired",
    surface: "auth",
    state: "expired",
    expected: "The user is asked to sign in again; no protected action is accepted.",
    honestLimitation: "Expiry is a fixture label; no real token lifecycle runs here.",
    synthetic: true,
  },
  {
    id: "state-device-revoked",
    surface: "conversation",
    state: "revoked",
    expected: "Sending is blocked and the device must re-enroll.",
    honestLimitation: "No device keys or encryption protocol exist in this task.",
    synthetic: true,
  },
  {
    id: "state-call-relay-required",
    surface: "call",
    state: "relay",
    expected: "The call continues only through an approved relay path.",
    honestLimitation: "No WebRTC, TURN, or media permission behavior is implemented.",
    synthetic: true,
  },
  {
    id: "state-ai-consent-refused",
    surface: "ai",
    state: "refused",
    expected: "The AI action is unavailable and no content leaves the device.",
    honestLimitation: "AI remains a labelled preview; the mock adapter is network-free.",
    synthetic: true,
  },
  {
    id: "state-delivery-unknown",
    surface: "conversation",
    state: "unknown",
    expected: "The UI shows an indeterminate delivery state, not a false success.",
    honestLimitation: "No transport or receipt pipeline exists yet.",
    synthetic: true,
  },
  {
    id: "state-raw-provider-error",
    surface: "states",
    state: "unknown-error",
    expected: "Only stable error-code copy is shown; raw provider text is never rendered.",
    honestLimitation: "This fixture exercises copy mapping, not a real provider failure.",
    synthetic: true,
  },
];

export const emptyStates = [
  "no-conversations",
  "no-messages",
  "no-search-results",
  "no-calls",
  "no-ai-history",
] as const;

export type EmptyState = (typeof emptyStates)[number];
