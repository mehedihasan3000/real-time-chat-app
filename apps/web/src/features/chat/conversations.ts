import {
  CONVERSATION_SCHEMA_VERSION,
  PAGE_DEFAULT,
  isErrorCode,
  isOpaqueId,
  validateConversationCreateResponse,
  validateConversationDetailResponse,
  validateConversationListResponse,
  validatePageLimit,
  type ConversationCreateResponse,
  type ConversationDetailResponse,
  type ConversationListResponse,
  type ConversationPeerSummary,
  type ConversationSummary,
  type Envelope,
  type ErrorCode,
} from "@chat/contracts";

import type { MessageKey } from "../../i18n/catalog";
import { errorCopyFor, type ErrorCopy } from "../../i18n/errors";
import { avatarFor } from "../profile/avatar";

/**
 * Web chat conversation create/list client and state helpers (P2-03).
 *
 * Provisional under Release-gated DEC-023:
 * - Authenticates with Bearer JWTs only (`credentials: "omit"`).
 * - Validates every server response against strict contract allowlists and the
 *   2-participant invariant before surfacing it to UI state.
 * - Exposes explicit empty, forbidden, blocked-by-viewer, unavailable,
 *   unauthenticated, and stale-completion-safe states (`ERR-001`–`ERR-003`).
 */
export type ConversationsClientErrorCode = ErrorCode | "INVALID_RESPONSE";

export class ConversationsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ConversationsClientErrorCode,
    public readonly retryable: boolean,
    public readonly requestId: string | null = null,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(`Conversations API error (${code})`);
    this.name = "ConversationsApiError";
  }
}

export interface ConversationsClientOptions {
  apiOrigin: string;
  expectedUserId: string;
  getToken: () => Promise<string> | string;
  fetchImpl?: typeof fetch;
}

export type ConversationListState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "empty" }
  | {
      status: "ready";
      items: ConversationSummary[];
      nextCursor: string | null;
      hasMore: boolean;
    }
  | {
      status: "unauthenticated";
      code: "UNAUTHENTICATED" | "SESSION_REVOKED";
      copy: ErrorCopy;
    }
  | { status: "forbidden"; code: "FORBIDDEN"; copy: ErrorCopy }
  | {
      status: "error";
      code: ErrorCode | null;
      retryable: boolean;
      retryAfterSeconds: number | null;
      copy: ErrorCopy;
    };

export type ConversationOpenState =
  | { status: "loading" }
  | {
      status: "ready";
      conversation: ConversationSummary;
      created: boolean;
      composeAllowed: boolean;
      noticeKey: MessageKey | null;
    }
  | {
      status: "unavailable";
      code: "USER_UNAVAILABLE" | "BLOCKED" | "NOT_FOUND";
      copy: ErrorCopy;
    }
  | { status: "forbidden"; code: "FORBIDDEN"; copy: ErrorCopy }
  | {
      status: "unauthenticated";
      code: "UNAUTHENTICATED" | "SESSION_REVOKED";
      copy: ErrorCopy;
    }
  | {
      status: "error";
      code: ErrorCode | null;
      retryable: boolean;
      retryAfterSeconds: number | null;
      copy: ErrorCopy;
    };

function assertExactOrigin(apiOrigin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(apiOrigin);
  } catch {
    throw new ConversationsApiError(0, "INVALID_REQUEST", false);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new ConversationsApiError(0, "INVALID_REQUEST", false);
  }
  return parsed.origin;
}

function assertViewerParticipation(
  expectedUserId: string,
  conversation: ConversationSummary,
): void {
  if (
    conversation.participantIds.length !== 2 ||
    !conversation.participantIds.includes(expectedUserId) ||
    conversation.peer.userId === expectedUserId
  ) {
    throw new ConversationsApiError(502, "INVALID_RESPONSE", false);
  }
}

export class ConversationsClient {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ConversationsClientOptions) {
    if (!isOpaqueId(options.expectedUserId)) {
      throw new ConversationsApiError(0, "INVALID_REQUEST", false);
    }
    this.origin = assertExactOrigin(options.apiOrigin);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async createOrGet(peerUserId: string): Promise<ConversationCreateResponse> {
    if (!isOpaqueId(peerUserId) || peerUserId === this.options.expectedUserId) {
      throw new ConversationsApiError(400, "INVALID_REQUEST", false);
    }
    const raw = await this.request("/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: CONVERSATION_SCHEMA_VERSION,
        peerUserId,
      }),
    });
    const validated = validateConversationCreateResponse(raw);
    if (!validated.ok) {
      throw new ConversationsApiError(502, "INVALID_RESPONSE", false);
    }
    assertViewerParticipation(this.options.expectedUserId, validated.value.conversation);
    return validated.value;
  }

  async list(options: { limit?: number; before?: string } = {}): Promise<ConversationListResponse> {
    const limitCheck = validatePageLimit(options.limit);
    if (!limitCheck.ok) {
      throw new ConversationsApiError(400, "INVALID_REQUEST", false);
    }
    const params = new URLSearchParams();
    if (options.limit !== undefined) {
      params.set("limit", String(limitCheck.value));
    } else if (options.before !== undefined) {
      params.set("limit", String(PAGE_DEFAULT));
    }
    if (options.before !== undefined) {
      params.set("before", options.before);
    }
    const query = params.toString();
    const path = query ? `/api/v1/conversations?${query}` : "/api/v1/conversations";
    const raw = await this.request(path, { method: "GET" });
    const validated = validateConversationListResponse(raw);
    if (!validated.ok) {
      throw new ConversationsApiError(502, "INVALID_RESPONSE", false);
    }
    for (const item of validated.value.items) {
      assertViewerParticipation(this.options.expectedUserId, item);
    }
    return validated.value;
  }

  async get(conversationId: string): Promise<ConversationDetailResponse> {
    if (!isOpaqueId(conversationId)) {
      throw new ConversationsApiError(400, "INVALID_REQUEST", false);
    }
    const raw = await this.request(`/api/v1/conversations/${encodeURIComponent(conversationId)}`, {
      method: "GET",
    });
    const validated = validateConversationDetailResponse(raw);
    if (!validated.ok) {
      throw new ConversationsApiError(502, "INVALID_RESPONSE", false);
    }
    assertViewerParticipation(this.options.expectedUserId, validated.value.conversation);
    return validated.value;
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const token = await this.options.getToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
    };
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const response = await this.fetchImpl(`${this.origin}${path}`, {
      ...init,
      headers,
      credentials: "omit",
    });

    const retryHeader = response.headers.get("retry-after");
    const retryAfterSeconds =
      retryHeader && /^\d+$/.test(retryHeader.trim()) ? Number(retryHeader.trim()) : null;

    let body: Envelope<unknown> | null = null;
    try {
      body = (await response.json()) as Envelope<unknown>;
    } catch {
      throw new ConversationsApiError(
        response.status,
        "INVALID_RESPONSE",
        response.status >= 500,
        null,
        retryAfterSeconds,
      );
    }

    if (!body || typeof body !== "object") {
      throw new ConversationsApiError(
        response.status,
        "INVALID_RESPONSE",
        false,
        null,
        retryAfterSeconds,
      );
    }

    const requestId = typeof body.requestId === "string" ? body.requestId : null;
    if (!response.ok || !body.ok) {
      const code =
        !body.ok && body.error && isErrorCode(body.error.code)
          ? body.error.code
          : response.status === 401
            ? "UNAUTHENTICATED"
            : "INTERNAL_ERROR";
      const retryable =
        !body.ok && body.error && typeof body.error.retryable === "boolean"
          ? body.error.retryable
          : response.status === 429 || response.status >= 500;
      throw new ConversationsApiError(
        response.status,
        code,
        retryable,
        requestId,
        retryAfterSeconds,
      );
    }

    return body.data;
  }
}

export function mapConversationListError(error: unknown): ConversationListState {
  if (error instanceof ConversationsApiError) {
    if (error.code === "UNAUTHENTICATED" || error.code === "SESSION_REVOKED") {
      return { status: "unauthenticated", code: error.code, copy: errorCopyFor(error.code) };
    }
    if (error.code === "FORBIDDEN") {
      return { status: "forbidden", code: "FORBIDDEN", copy: errorCopyFor("FORBIDDEN") };
    }
    const code = error.code === "INVALID_RESPONSE" ? null : error.code;
    return {
      status: "error",
      code,
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
      copy: errorCopyFor(code),
    };
  }
  return {
    status: "error",
    code: null,
    retryable: true,
    retryAfterSeconds: null,
    copy: errorCopyFor(null),
  };
}

export function mapConversationOpenError(error: unknown): ConversationOpenState {
  if (error instanceof ConversationsApiError) {
    if (error.code === "UNAUTHENTICATED" || error.code === "SESSION_REVOKED") {
      return { status: "unauthenticated", code: error.code, copy: errorCopyFor(error.code) };
    }
    if (error.code === "FORBIDDEN") {
      return { status: "forbidden", code: "FORBIDDEN", copy: errorCopyFor("FORBIDDEN") };
    }
    if (
      error.code === "USER_UNAVAILABLE" ||
      error.code === "BLOCKED" ||
      error.code === "NOT_FOUND"
    ) {
      return { status: "unavailable", code: error.code, copy: errorCopyFor(error.code) };
    }
    const code = error.code === "INVALID_RESPONSE" ? null : error.code;
    return {
      status: "error",
      code,
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
      copy: errorCopyFor(code),
    };
  }
  return {
    status: "error",
    code: null,
    retryable: true,
    retryAfterSeconds: null,
    copy: errorCopyFor(null),
  };
}

export function toConversationOpenReadyState(
  conversation: ConversationSummary,
  created: boolean,
): Extract<ConversationOpenState, { status: "ready" }> {
  return {
    status: "ready",
    conversation,
    created,
    composeAllowed: !conversation.blockedByViewer,
    noticeKey: conversation.blockedByViewer ? "conversations.blockedByYouNotice" : null,
  };
}

/**
 * Prevents stale, canceled, or cross-account async completions from overwriting
 * newer UI state (`ERR-003`).
 */
export interface RequestVersionGuard {
  begin(contextKey: string): number;
  isCurrent(contextKey: string, version: number): boolean;
  invalidate(): void;
}

export function createRequestVersionGuard(): RequestVersionGuard {
  let activeContext = "";
  let counter = 0;

  return {
    begin(contextKey: string): number {
      activeContext = contextKey;
      counter += 1;
      return counter;
    },
    isCurrent(contextKey: string, version: number): boolean {
      return activeContext === contextKey && version === counter;
    },
    invalidate(): void {
      counter += 1;
    },
  };
}

export function peerAvatarDescriptor(peer: ConversationPeerSummary) {
  return avatarFor(peer.userId, peer.displayName ?? "", peer.username ?? "");
}

export const CONVERSATION_TOMBSTONE_LABEL_KEY: MessageKey = "conversations.tombstoneUser";
