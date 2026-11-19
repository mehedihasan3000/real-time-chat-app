import {
  encodeHistoryCursor,
  type ConversationHistoryQuery,
  type HistoryMessageItem,
  type HistoryPageResponse,
} from "@chat/contracts";

import type { ConversationStore } from "../conversations/store.js";
import type { MessageRecord, MessageStore } from "../messages/store.js";
import { toHistoryMessageItem } from "./view.js";

export interface FetchHistoryPageInput {
  conversationId: string;
  query: ConversationHistoryQuery;
  messageStore: MessageStore;
  conversationStore: ConversationStore;
}

/**
 * Retrieve a bounded, deduplicated, ascending-`seq` ciphertext history or
 * catch-up page for an authorized conversation participant (`P2-07`,
 * `FR-CHAT-012`, `FR-HIST-002`, `INT-006`, `DEC-021` §7, `DEC-023` provisional).
 *
 * Invariants:
 * - Default/`before` pages query newest-first below `before.seq` and return rows
 *   sorted ascending by `seq`, with `nextCursor` pointing to `items[0].seq`
 *   when `hasMore` is `true` and `null` otherwise (no `latestSeq` field emitted).
 * - Catch-up `after` pages query oldest-first above `after.seq` and return rows
 *   sorted ascending by `seq`, with `nextCursor` pointing to the highest `seq`
 *   in the page when `hasMore` is `true`, plus diagnostic `latestSeq`.
 */
export async function fetchConversationHistoryPage(
  input: FetchHistoryPageInput,
): Promise<HistoryPageResponse> {
  const result = await input.messageStore.queryHistoryPage({
    conversationId: input.conversationId,
    limit: input.query.limit,
    beforeSeq: input.query.before?.seq ?? null,
    afterSeq: input.query.after?.seq ?? null,
  });

  // Defensive deduplication by messageId and strict ascending server seq order.
  const deduped = new Map<string, MessageRecord>();
  for (const record of result.items) {
    if (record.conversationId !== input.conversationId) continue;
    if (!deduped.has(record.id)) {
      deduped.set(record.id, record);
    }
  }

  const orderedAsc = [...deduped.values()].sort((a, b) => a.seq - b.seq);
  const items: HistoryMessageItem[] = orderedAsc.map(toHistoryMessageItem);

  let nextCursor: string | null = null;
  if (result.hasMore && items.length > 0) {
    const boundarySeq = input.query.mode === "after" ? items[items.length - 1]!.seq : items[0]!.seq;
    nextCursor = encodeHistoryCursor(input.conversationId, boundarySeq);
  }

  if (input.query.mode === "after") {
    const storedConversation = await input.conversationStore.getById(input.conversationId);
    const highestItemSeq = items[items.length - 1]?.seq ?? 0;
    const latestSeq = Math.max(storedConversation?.lastSeq ?? 0, result.latestSeq, highestItemSeq);
    return {
      items,
      nextCursor,
      hasMore: result.hasMore,
      latestSeq,
    };
  }

  return {
    items,
    nextCursor,
    hasMore: result.hasMore,
  };
}
