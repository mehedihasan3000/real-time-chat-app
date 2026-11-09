import {
  normalizeUsername,
  validateDisplayName,
  validateUsername,
  type ProfileResponse,
} from "@chat/contracts";

/**
 * Profile store v0 (P1-17, FR-PROF-001/002/004, DATA-002).
 *
 * - Usernames are unique case-insensitively (normalized lowercase).
 * - Display names are per-user; they never affect another profile.
 * - The production store is the Mongo `users` collection (unique
 *   `username` index from P1-04); this in-memory implementation is the
 *   test/foundation double and fails closed nowhere — callers inject
 *   the real store in staging (GAP-17-01).
 */
export type ProfileRecord = ProfileResponse;

export interface ProfileStore {
  getByUserId(userId: string): Promise<ProfileRecord | null>;
  getByUsername(username: string): Promise<ProfileRecord | null>;
  claimUsername(userId: string, username: string): Promise<ProfileRecord | null>;
  updateDisplayName(userId: string, displayName: string): Promise<ProfileRecord | null>;
}

export type BlockPredicate = (a: string, b: string) => Promise<boolean> | boolean;

export class MemoryProfileStore implements ProfileStore {
  private readonly byUser = new Map<string, ProfileRecord>();
  private readonly usernameOwner = new Map<string, string>();

  constructor(seed: ProfileRecord[] = []) {
    for (const record of seed) {
      this.byUser.set(record.userId, record);
      this.usernameOwner.set(normalizeUsername(record.username), record.userId);
    }
  }

  async getByUserId(userId: string): Promise<ProfileRecord | null> {
    return this.byUser.get(userId) ?? null;
  }

  async getByUsername(username: string): Promise<ProfileRecord | null> {
    const owner = this.usernameOwner.get(normalizeUsername(username));
    return owner ? (this.byUser.get(owner) ?? null) : null;
  }

  /** Returns null when the normalized username is already taken. */
  async claimUsername(userId: string, username: string): Promise<ProfileRecord | null> {
    const normalized = normalizeUsername(username);
    const existing = this.usernameOwner.get(normalized);
    if (existing && existing !== userId) return null;
    const current = this.byUser.get(userId);
    if (!current) return null;
    if (existing === userId) return current;
    // A user may hold one username; claiming a new one frees the old key.
    this.usernameOwner.delete(normalizeUsername(current.username));
    const next = { ...current, username: normalized };
    this.byUser.set(userId, next);
    this.usernameOwner.set(normalized, userId);
    return next;
  }

  async updateDisplayName(userId: string, displayName: string): Promise<ProfileRecord | null> {
    const validated = validateDisplayName(displayName);
    if (!validated.ok) return null;
    const current = this.byUser.get(userId);
    if (!current) return null;
    const next = { ...current, displayName: validated.value };
    this.byUser.set(userId, next);
    return next;
  }
}

/** Validate a username claim (normalization + policy) before any store call. */
export function canClaimUsername(
  username: unknown,
): { ok: true; username: string } | { ok: false; message: string } {
  const validated = validateUsername(username);
  if (!validated.ok) return { ok: false, message: validated.message };
  return { ok: true, username: validated.value };
}
