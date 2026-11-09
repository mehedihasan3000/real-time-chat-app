import { BLOCK_MAX, type BlockRecord } from "@chat/contracts";

/**
 * Block store v0 (P1-18, DEC-008 §3).
 *
 * - 50 concurrent blocks max per user (hard limit).
 * - Unique `{blockerUserId, blockedUserId}`; reverse lookup for discovery
 *   omission. List is private to the blocker; no history is retained.
 * - Production backing is the Mongo `blocks` collection (P1-04).
 */
export interface BlockStore {
  create(blockerUserId: string, blockedUserId: string): Promise<BlockRecord | "LIMIT" | "SELF">;
  remove(blockerUserId: string, blockedUserId: string): Promise<void>;
  list(blockerUserId: string, limit: number): Promise<BlockRecord[]>;
  isBlocked(a: string, b: string): Promise<boolean>;
  count(blockerUserId: string): Promise<number>;
}

export class MemoryBlockStore implements BlockStore {
  private readonly blocks = new Map<string, BlockRecord>();

  private key(blocker: string, blocked: string): string {
    return `${blocker}→${blocked}`;
  }

  async create(
    blockerUserId: string,
    blockedUserId: string,
  ): Promise<BlockRecord | "LIMIT" | "SELF"> {
    if (blockerUserId === blockedUserId) return "SELF";
    const existing = this.blocks.get(this.key(blockerUserId, blockedUserId));
    if (existing) return existing;
    const owned = [...this.blocks.values()].filter((b) => b.blockerUserId === blockerUserId);
    if (owned.length >= BLOCK_MAX) return "LIMIT";
    const record: BlockRecord = {
      blockerUserId,
      blockedUserId,
      createdAt: new Date().toISOString(),
    };
    this.blocks.set(this.key(blockerUserId, blockedUserId), record);
    return record;
  }

  async remove(blockerUserId: string, blockedUserId: string): Promise<void> {
    this.blocks.delete(this.key(blockerUserId, blockedUserId));
  }

  async list(blockerUserId: string, limit: number): Promise<BlockRecord[]> {
    return [...this.blocks.values()]
      .filter((b) => b.blockerUserId === blockerUserId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  /** Bilateral: either direction blocks discovery/presence for the pair. */
  async isBlocked(a: string, b: string): Promise<boolean> {
    return this.blocks.has(this.key(a, b)) || this.blocks.has(this.key(b, a));
  }

  async count(blockerUserId: string): Promise<number> {
    return [...this.blocks.values()].filter((b) => b.blockerUserId === blockerUserId).length;
  }
}
