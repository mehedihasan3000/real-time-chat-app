import { isFreshSession, SESSION_CACHE_SECONDS } from "@chat/contracts";

/**
 * Session-state gate (DEC-019 §3.2). JWT is a 5-min cache; Mongo session
 * is authoritative for sensitive/socket actions. Reads may cache sid for
 * 60s; sensitive actions bypass cache.
 */
export interface SessionRecord {
  sid: string;
  userId: string;
  revoked: boolean;
  authenticatedAt: Date;
}

export type SessionLookup = (sid: string) => Promise<SessionRecord | null>;

const readCache = new Map<string, { record: SessionRecord; cachedAt: number }>();

export function clearSessionCache(): void {
  readCache.clear();
}

export async function getSessionForRead(
  lookup: SessionLookup,
  sid: string,
  now = Date.now(),
): Promise<SessionRecord | null> {
  const hit = readCache.get(sid);
  if (hit && now - hit.cachedAt <= SESSION_CACHE_SECONDS * 1000) {
    return hit.record;
  }
  const record = await lookup(sid);
  if (record && !record.revoked) {
    readCache.set(sid, { record, cachedAt: now });
  } else {
    readCache.delete(sid);
  }
  return record && !record.revoked ? record : null;
}

/** Sensitive actions always hit Mongo (no cache). */
export async function getSessionForSensitive(
  lookup: SessionLookup,
  sid: string,
): Promise<SessionRecord | null> {
  const record = await lookup(sid);
  return record && !record.revoked ? record : null;
}

export function requireVerifiedForProtected(
  record: SessionRecord | null,
  emailVerified: boolean,
): boolean {
  // Unverified users are blocked from protected features (DEC-001 §3.3).
  return Boolean(record && emailVerified);
}

export function requireFreshForSensitive(record: SessionRecord | null, now = new Date()): boolean {
  if (!record) return false;
  return isFreshSession(record.authenticatedAt, now);
}
