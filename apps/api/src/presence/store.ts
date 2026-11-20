import {
  DEFAULT_ACTIVITY_SHARING_ENABLED,
  PRESENCE_LEASE_TTL_MS,
  TYPING_COALESCE_MS,
  TYPING_EXPIRY_MS,
  type PresenceState,
} from "@chat/contracts";

/**
 * Volatile in-memory presence and typing store (`P2-12`, `FR-PRES-001`..`004`,
 * `DEC-002`, `DEC-014`, `DEC-015`, `DEC-016`, `DEC-020` §6.3).
 *
 * Security & privacy invariants:
 * - Connection leases (`60_000 ms`) and typing states (`5_000 ms`) live strictly
 *   in volatile memory (`DEC-014`, `DEC-015`). Neither is persisted as message
 *   or activity history, and no `lastSeen` timestamp is ever stored or exposed.
 * - Multi-tab connections for the same `userId` are aggregated so closing one
 *   of multiple active tabs does not transition the user offline (`FR-PRES-002`).
 * - A fresh server process epoch starts with `seenUsersInEpoch` empty so
 *   unconnected peers report `"unknown"` until a connection lease is
 *   established (`FR-PRES-001`, `TC-PRES-001`).
 */

export interface ActivityPreferencesRecord {
  userId: string;
  activitySharingEnabled: boolean;
  updatedAt: string;
}

export interface ConnectionTouchResult {
  previousStatus: PresenceState;
  currentStatus: PresenceState;
  changed: boolean;
  activeConnectionCount: number;
  expiresAtMs: number;
}

export interface ConnectionDisconnectResult {
  previousStatus: PresenceState;
  currentStatus: PresenceState;
  changed: boolean;
  activeConnectionCount: number;
  clearedTypingConversationIds: string[];
}

export interface TypingSetInput {
  conversationId: string;
  userId: string;
  connectionId?: string;
  isTyping: boolean;
  now: Date;
}

export interface TypingSetResult {
  accepted: boolean;
  coalesced: boolean;
  isTyping: boolean;
  expiresAt: string | null;
}

export interface PresenceStore {
  getPreferences(userId: string): Promise<ActivityPreferencesRecord | null>;
  setPreferences(
    userId: string,
    activitySharingEnabled: boolean,
    updatedAt: string,
  ): Promise<{ record: ActivityPreferencesRecord; clearedTypingConversationIds: string[] }>;

  touchConnection(userId: string, connectionId: string, now: Date): ConnectionTouchResult;
  disconnectConnection(userId: string, connectionId: string, now: Date): ConnectionDisconnectResult;
  getRawPresenceStatus(userId: string, now: Date): PresenceState;
  getActiveConnectionCount(userId: string, now: Date): number;

  setTyping(input: TypingSetInput): TypingSetResult;
  isUserTyping(
    conversationId: string,
    userId: string,
    now: Date,
  ): { isTyping: boolean; expiresAt: string | null };
  clearUserTyping(userId: string, conversationId?: string): string[];
  simulateServerRestart(): void;
}

interface ConnectionLeaseEntry {
  connectedAtMs: number;
  expiresAtMs: number;
}

interface TypingLeaseEntry {
  conversationId: string;
  userId: string;
  connectionId?: string;
  expiresAtMs: number;
}

function typingPairKey(conversationId: string, userId: string): string {
  return `${conversationId}::${userId}`;
}

export class InMemoryPresenceStore implements PresenceStore {
  private readonly preferences = new Map<string, ActivityPreferencesRecord>();
  private readonly connectionsByUser = new Map<string, Map<string, ConnectionLeaseEntry>>();
  private readonly seenUsersInEpoch = new Set<string>();
  private readonly typingByPair = new Map<string, TypingLeaseEntry>();
  private readonly lastStartSignalAtByPair = new Map<string, number>();

  async getPreferences(userId: string): Promise<ActivityPreferencesRecord | null> {
    const existing = this.preferences.get(userId);
    return existing ? { ...existing } : null;
  }

  async setPreferences(
    userId: string,
    activitySharingEnabled: boolean,
    updatedAt: string,
  ): Promise<{ record: ActivityPreferencesRecord; clearedTypingConversationIds: string[] }> {
    const record: ActivityPreferencesRecord = {
      userId,
      activitySharingEnabled,
      updatedAt,
    };
    this.preferences.set(userId, record);
    const clearedTypingConversationIds = activitySharingEnabled ? [] : this.clearUserTyping(userId);
    return { record: { ...record }, clearedTypingConversationIds };
  }

  private pruneExpiredConnections(
    userId: string,
    nowMs: number,
  ): Map<string, ConnectionLeaseEntry> {
    let map = this.connectionsByUser.get(userId);
    if (!map) {
      return new Map();
    }
    const hadEntries = map.size > 0;
    for (const [connId, entry] of map.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        map.delete(connId);
      }
    }
    if (map.size === 0) {
      this.connectionsByUser.delete(userId);
      if (hadEntries) {
        this.clearUserTyping(userId);
      }
      map = new Map();
    }
    return map;
  }

  getRawPresenceStatus(userId: string, now: Date): PresenceState {
    const nowMs = now.getTime();
    const active = this.pruneExpiredConnections(userId, nowMs);
    if (active.size > 0) {
      return "online";
    }
    if (!this.seenUsersInEpoch.has(userId)) {
      return "unknown";
    }
    return "offline";
  }

  getActiveConnectionCount(userId: string, now: Date): number {
    return this.pruneExpiredConnections(userId, now.getTime()).size;
  }

  touchConnection(userId: string, connectionId: string, now: Date): ConnectionTouchResult {
    const nowMs = now.getTime();
    const previousStatus = this.getRawPresenceStatus(userId, now);
    this.seenUsersInEpoch.add(userId);

    let map = this.connectionsByUser.get(userId);
    if (!map) {
      map = new Map();
      this.connectionsByUser.set(userId, map);
    }
    const existing = map.get(connectionId);
    const expiresAtMs = nowMs + PRESENCE_LEASE_TTL_MS;
    map.set(connectionId, {
      connectedAtMs: existing?.connectedAtMs ?? nowMs,
      expiresAtMs,
    });

    if (previousStatus !== "online") {
      // Never replay stale typing from a prior offline/restart epoch on reconnect (FR-PRES-003).
      this.clearUserTyping(userId);
    }

    const currentStatus: PresenceState = "online";
    return {
      previousStatus,
      currentStatus,
      changed: previousStatus !== currentStatus,
      activeConnectionCount: map.size,
      expiresAtMs,
    };
  }

  disconnectConnection(
    userId: string,
    connectionId: string,
    now: Date,
  ): ConnectionDisconnectResult {
    const nowMs = now.getTime();
    const previousStatus = this.getRawPresenceStatus(userId, now);
    const map = this.connectionsByUser.get(userId);
    if (map) {
      map.delete(connectionId);
      this.pruneExpiredConnections(userId, nowMs);
    }

    const currentStatus = this.getRawPresenceStatus(userId, now);
    const activeConnectionCount = this.getActiveConnectionCount(userId, now);
    const clearedSet = new Set<string>();

    if (currentStatus !== "online") {
      for (const convId of this.clearUserTyping(userId)) {
        clearedSet.add(convId);
      }
    } else {
      // Clear any typing specifically tied to the closing tab without clearing other live tabs.
      for (const [key, entry] of this.typingByPair.entries()) {
        if (entry.userId === userId && entry.connectionId === connectionId) {
          this.typingByPair.delete(key);
          clearedSet.add(entry.conversationId);
        }
      }
    }

    return {
      previousStatus,
      currentStatus,
      changed: previousStatus !== currentStatus,
      activeConnectionCount,
      clearedTypingConversationIds: Array.from(clearedSet),
    };
  }

  setTyping(input: TypingSetInput): TypingSetResult {
    const key = typingPairKey(input.conversationId, input.userId);
    const nowMs = input.now.getTime();

    if (!input.isTyping) {
      this.typingByPair.delete(key);
      return {
        accepted: true,
        coalesced: false,
        isTyping: false,
        expiresAt: null,
      };
    }

    const lastStartMs = this.lastStartSignalAtByPair.get(key);
    const existing = this.typingByPair.get(key);
    if (typeof lastStartMs === "number" && nowMs - lastStartMs < TYPING_COALESCE_MS) {
      const stillActive = Boolean(existing && existing.expiresAtMs > nowMs);
      return {
        accepted: false,
        coalesced: true,
        isTyping: stillActive,
        expiresAt: stillActive && existing ? new Date(existing.expiresAtMs).toISOString() : null,
      };
    }

    const expiresAtMs = nowMs + TYPING_EXPIRY_MS;
    this.typingByPair.set(key, {
      conversationId: input.conversationId,
      userId: input.userId,
      connectionId: input.connectionId,
      expiresAtMs,
    });
    this.lastStartSignalAtByPair.set(key, nowMs);

    return {
      accepted: true,
      coalesced: false,
      isTyping: true,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  isUserTyping(
    conversationId: string,
    userId: string,
    now: Date,
  ): { isTyping: boolean; expiresAt: string | null } {
    if (this.getRawPresenceStatus(userId, now) !== "online") {
      return { isTyping: false, expiresAt: null };
    }
    const key = typingPairKey(conversationId, userId);
    const entry = this.typingByPair.get(key);
    if (!entry) {
      return { isTyping: false, expiresAt: null };
    }
    const nowMs = now.getTime();
    if (entry.expiresAtMs <= nowMs) {
      this.typingByPair.delete(key);
      return { isTyping: false, expiresAt: null };
    }
    return {
      isTyping: true,
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
    };
  }

  clearUserTyping(userId: string, conversationId?: string): string[] {
    const affected: string[] = [];
    for (const [key, entry] of this.typingByPair.entries()) {
      if (entry.userId !== userId) continue;
      if (conversationId && entry.conversationId !== conversationId) continue;
      this.typingByPair.delete(key);
      affected.push(entry.conversationId);
    }
    return affected;
  }

  simulateServerRestart(): void {
    // Only volatile leases and typing vanish across process restart; persisted user
    // preferences (`activitySharingEnabled`) survive independently (`DEC-020`, `FR-PRES-001`).
    this.connectionsByUser.clear();
    this.seenUsersInEpoch.clear();
    this.typingByPair.clear();
    this.lastStartSignalAtByPair.clear();
  }
}

export function resolveActivitySharingEnabled(record: ActivityPreferencesRecord | null): boolean {
  return record ? record.activitySharingEnabled : DEFAULT_ACTIVITY_SHARING_ENABLED;
}
