import { generatedAvatar, type GeneratedAvatar } from "@chat/contracts";

/**
 * Generated initials avatar v0 (P1-17, FR-PROF-003 / DEC-027).
 *
 * Deterministic from the opaque `userId` (same user → same color across
 * sessions/devices); the first grapheme of the display name (or username)
 * renders correctly for Bengali and mixed scripts. No upload, no
 * third-party request, no stored binary. `avatar: null` is the only
 * persisted value; this helper is the sole view derivation.
 */
export function avatarFor(userId: string, displayName: string, username: string): GeneratedAvatar {
  return generatedAvatar(userId, displayName, username);
}

/** CSS background for the generated avatar (hex from the 0-359 hue). */
export function avatarColor(hue: number): string {
  return `hsl(${hue} 60% 50%)`;
}
