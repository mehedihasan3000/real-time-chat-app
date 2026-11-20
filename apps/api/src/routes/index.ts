import { Router, type Request, type Response } from "express";

import {
  failureEnvelope,
  successEnvelope,
  validateBlockCreate,
  validateConversationHistoryQuery,
  validateConversationListQuery,
  validateCreateConversationRequest,
  validateDeviceEnrollmentRequest,
  validateDeviceRevocationRequest,
  validateDiscoveryUsername,
  validateDisplayName,
  validateDisposition,
  validateKeyBackupLinkRequest,
  validateMessageSendRequest,
  validatePageLimit,
  validateReportCreate,
  validateSubmitMessageReceiptRequest,
  validateUpdateReadProgressRequest,
  validateUpdateReceiptPreferencesRequest,
  validateUsername,
  type ConversationCreateResponse,
  type ConversationDetailResponse,
  type ConversationListResponse,
  type ConversationReceiptListResponse,
  type DeviceEnrollmentResponse,
  type DeviceKeyResponse,
  type DeviceListResponse,
  type DevicePublicKeysResponse,
  type DeviceRevocationResponse,
  type KeyBackupLinkResponse,
  type MessageReceiptDetailResponse,
  type MessageReceiptEvent,
  type MessageSendResponse,
  type ReadProgressResponse,
  type ReceiptPreferencesView,
} from "@chat/contracts";

import { requireAuth } from "../auth/middleware.js";
import type { createVerifier } from "../auth/jwt.js";
import type { SessionLookup } from "../auth/session.js";
import {
  attachPrincipal,
  attachPrincipalForRead,
  requireConversationMember,
  type PrincipalRequest,
} from "../authz/middleware.js";
import { meHandler } from "./me.js";
import {
  canAccessCall,
  canAccessKeyBackup,
  guardProtected,
  guardSensitive,
  sendAuthzDenial,
  type AuthzResult,
} from "../authz/index.js";
import type { RoleLookup } from "../authz/index.js";
import type {
  CallResource,
  ConversationResource,
  KeyBackupResource,
  ResourceLookup,
} from "../authz/index.js";
import {
  MemoryDeviceKeyStore,
  deviceSummaryView,
  ownerBundleView,
  type DeviceKeyStore,
} from "../keys/store.js";
import { sendEmptyList, sendPlaceholder, sendValidationFailure } from "./placeholder.js";
import type { MetricsRegistry } from "../observability/index.js";
import { guardOperator } from "../authz/index.js";
import { MemoryProfileStore, type BlockPredicate, type ProfileStore } from "../profiles/store.js";
import { MemoryBlockStore, type BlockStore } from "../blocks/store.js";
import {
  MemoryReportStore,
  operatorView,
  reportedView,
  reporterView,
  type ReportStore,
} from "../reports/store.js";
import {
  ConversationRateLimiter,
  MemoryConversationStore,
  checkConversationPairEligibility,
  toConversationSummary,
  type ConversationRecord,
  type ConversationStore,
  type UserEligibilityLookup,
} from "../conversations/index.js";
import {
  MemoryMessageStore,
  MessageRateLimiter,
  checkMessageSendEligibility,
  toMessageAckSummary,
  type MessageRecord,
  type MessageStore,
} from "../messages/index.js";
import { fetchConversationHistoryPage } from "../history/index.js";
import {
  MemoryReceiptStore,
  getOwnConversationReadProgress,
  getSingleMessageSenderReceipt,
  listConversationSenderReceipts,
  submitMessageReceipt,
  toReceiptPreferencesView,
  updateOwnConversationReadProgress,
  type ReceiptStore,
} from "../receipts/index.js";
import { findOperatorKey } from "../security/input.js";

/**
 * API skeleton v0 (P1-08, INT-001/INT-002, ERR-001, OPS-010).
 *
 * Every protected route flows through `requireAuth` (P1-06 JWT/JWKS) and
 * then `attachPrincipal` (P1-07 server-derived principal + object checks).
 * Unauthenticated requests get 401; nonparticipants get uniform 404
 * NOT_FOUND. Placeholders return documented empty/503 shapes and never
 * mutate private stores. No undocumented public fields are emitted
 * (`PUBLIC_FIELDS` in `@chat/contracts` is the allowlist).
 */
export interface ApiRouterOptions {
  verifier: ReturnType<typeof createVerifier>;
  sessionLookup: SessionLookup;
  roleLookup?: RoleLookup;
  conversationLookup?: ResourceLookup<ConversationResource>;
  conversationStore?: ConversationStore;
  conversationRateLimiter?: ConversationRateLimiter;
  messageStore?: MessageStore;
  messageRateLimiter?: MessageRateLimiter;
  onMessageCommitted?: (
    record: MessageRecord,
    conversation: ConversationRecord,
  ) => Promise<void> | void;
  userEligibilityLookup?: UserEligibilityLookup;
  callLookup?: ResourceLookup<CallResource>;
  keyBackupLookup?: ResourceLookup<KeyBackupResource>;
  deviceKeyStore?: DeviceKeyStore;
  metrics?: MetricsRegistry;
  profileStore?: ProfileStore;
  isBlocked?: BlockPredicate;
  blockStore?: BlockStore;
  reportStore?: ReportStore;
  receiptStore?: ReceiptStore;
  onReceiptAdvanced?: (
    event: MessageReceiptEvent,
    conversation: ConversationRecord,
  ) => Promise<void> | void;
  now?: () => Date;
}

const denyNullConversation: ResourceLookup<ConversationResource> = async () => null;
const denyNullCall: ResourceLookup<CallResource> = async () => null;
const denyNullBackup: ResourceLookup<KeyBackupResource> = async () => null;

function principalOrDenial(request: PrincipalRequest, response: Response): boolean {
  const result = guardProtected(request.principal ?? null);
  if (sendAuthzDenial(response, result)) return true;
  return false;
}

/** Sensitive actions additionally require a fresh session (DEC-019 §3.2). */
function sensitiveOrDenial(request: PrincipalRequest, response: Response): boolean {
  const result = guardSensitive(request.principal ?? null);
  if (sendAuthzDenial(response, result)) return true;
  return false;
}

function sendSafeError(
  response: Response,
  status: number,
  code: Parameters<typeof failureEnvelope>[0],
  message: string,
): void {
  response.status(status).json(failureEnvelope(code, message, false));
}

export function createApiRouter(options: ApiRouterOptions): Router {
  const router = Router();
  const {
    verifier,
    sessionLookup,
    roleLookup,
    conversationLookup = denyNullConversation,
    conversationStore = new MemoryConversationStore(),
    conversationRateLimiter = new ConversationRateLimiter(),
    messageStore = new MemoryMessageStore(),
    messageRateLimiter = new MessageRateLimiter(),
    onMessageCommitted,
    userEligibilityLookup,
    callLookup = denyNullCall,
    keyBackupLookup = denyNullBackup,
    deviceKeyStore = new MemoryDeviceKeyStore(),
    profileStore = new MemoryProfileStore(),
    isBlocked,
    blockStore = new MemoryBlockStore(),
    reportStore = new MemoryReportStore(),
    receiptStore = new MemoryReceiptStore(),
    onReceiptAdvanced,
    now = () => new Date(),
  } = options;
  const blockedBetween: BlockPredicate = isBlocked ?? ((a, b) => blockStore.isBlocked(a, b));
  const effectiveConversationLookup: ResourceLookup<ConversationResource> = async (id: string) => {
    const stored = await conversationStore.getById(id);
    if (stored) return stored;
    return conversationLookup(id);
  };

  const auth = requireAuth(verifier);
  const sensitive = attachPrincipal(sessionLookup, roleLookup, now);
  const read = attachPrincipalForRead(sessionLookup, roleLookup, now);
  const member = requireConversationMember({
    conversationLookup: effectiveConversationLookup,
    idField: "id",
  });

  // Readiness (OPS-010, public): no topology, credentials, or dependency detail.
  router.get("/ready", (_request: Request, response: Response) => {
    response.status(200).json(successEnvelope({ ready: true, service: "api" }));
  });

  // Operational metrics (OPS-011): operator-only aggregates, no content.
  // Regular users receive 403; unauthenticated requests receive 401.
  router.get("/metrics", auth, read, (request: PrincipalRequest, response: Response) => {
    const gate = guardOperator(request.principal ?? null);
    if (sendAuthzDenial(response, gate)) return;
    const snapshot = options.metrics?.snapshot() ?? { counters: {}, durations: {} };
    response.status(200).json(successEnvelope(snapshot as unknown as Record<string, unknown>));
  });

  // Me (INT-002): principal-derived only. No email, token, or session secret.
  router.get("/me", auth, read, meHandler);

  // Profiles (P1-17, FR-PROF-001/002): own profile + username claim.
  // The userId always comes from the server principal — client-supplied
  // requester IDs are never trusted (INT-002).
  router.get("/profiles/me", auth, read, async (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    const profile = await profileStore.getByUserId(request.principal?.userId ?? "");
    if (!profile) {
      response.status(404).json(failureEnvelope("NOT_FOUND", "Profile not found.", false));
      return;
    }
    response.status(200).json(successEnvelope(profile));
  });
  router.patch(
    "/profiles/me",
    auth,
    sensitive,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const validated = validateDisplayName(body.displayName);
      if (!validated.ok) {
        sendValidationFailure(response, validated);
        return;
      }
      const updated = await profileStore.updateDisplayName(
        request.principal?.userId ?? "",
        validated.value,
      );
      if (!updated) {
        response.status(404).json(failureEnvelope("NOT_FOUND", "Profile not found.", false));
        return;
      }
      response.status(200).json(successEnvelope(updated));
    },
  );
  router.post(
    "/profiles/username",
    auth,
    sensitive,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      const body = (request.body ?? {}) as Record<string, unknown>;
      const validated = validateUsername(body.username);
      if (!validated.ok) {
        sendValidationFailure(response, validated);
        return;
      }
      const claimed = await profileStore.claimUsername(
        request.principal?.userId ?? "",
        validated.value,
      );
      if (!claimed) {
        response
          .status(409)
          .json(failureEnvelope("IDEMPOTENCY_CONFLICT", "Username is unavailable.", false));
        return;
      }
      response.status(200).json(successEnvelope(claimed));
    },
  );

  // Discovery (FR-PROF-004 / DEC-020): exact normalized username only.
  // Blocked pairs are omitted; nonexistent usernames get the same neutral
  // empty result. No prefix/email lookup exists.
  router.get("/discovery", auth, read, async (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    const username = validateDiscoveryUsername(request.query.username);
    if (!username.ok) {
      sendValidationFailure(response, username);
      return;
    }
    const found = await profileStore.getByUsername(username.value);
    if (!found || found.userId === request.principal?.userId) {
      sendEmptyList(response, { items: [] });
      return;
    }
    if (await blockedBetween(request.principal?.userId ?? "", found.userId)) {
      sendEmptyList(response, { items: [] });
      return;
    }
    sendEmptyList(response, {
      items: [
        {
          userId: found.userId,
          username: found.username,
          displayName: found.displayName,
          avatar: null,
        },
      ],
    });
  });

  // Conversations (P2-03, FR-CHAT-001, FR-HIST-001, FR-PRIV-003, DATA-002;
  // DEC-008, DEC-016, DEC-020, DEC-023): one immutable direct conversation
  // per participant pair, two distinct eligible participants, participant-only
  // listing/retrieval, silent bilateral block enforcement.
  router.get(
    "/conversations",
    auth,
    read,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      if (findOperatorKey(request.query)) {
        sendSafeError(response, 400, "INVALID_REQUEST", "Invalid query parameters.");
        return;
      }
      const query = validateConversationListQuery(request.query as unknown);
      if (!query.ok) {
        sendValidationFailure(response, query);
        return;
      }
      const requesterUserId = request.principal?.userId ?? "";
      const list = await conversationStore.listForUser(requesterUserId, query.value);
      const items = await Promise.all(
        list.items.map((record) =>
          toConversationSummary(record, requesterUserId, { profileStore, blockStore }),
        ),
      );
      const data: ConversationListResponse = {
        items,
        nextCursor: list.nextCursor,
        hasMore: list.hasMore,
      };
      response.status(200).json(successEnvelope(data));
    },
  );
  router.get(
    "/conversations/:id",
    auth,
    read,
    member,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      const requesterUserId = request.principal?.userId ?? "";
      const id = request.params.id as string | undefined;
      const stored = id ? await conversationStore.getById(id) : null;
      if (!stored || !stored.participantIds.includes(requesterUserId)) {
        sendSafeError(response, 404, "NOT_FOUND", "Resource not found.");
        return;
      }
      const conversation = await toConversationSummary(stored, requesterUserId, {
        profileStore,
        blockStore,
      });
      const data: ConversationDetailResponse = { conversation };
      response.status(200).json(successEnvelope(data));
    },
  );
  router.post(
    "/conversations",
    auth,
    sensitive,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      if (findOperatorKey(request.body)) {
        sendSafeError(response, 400, "INVALID_REQUEST", "Invalid request body.");
        return;
      }
      const validated = validateCreateConversationRequest(request.body ?? {});
      if (!validated.ok) {
        sendValidationFailure(response, validated);
        return;
      }
      const requesterUserId = request.principal?.userId ?? "";
      if (requesterUserId === validated.value.peerUserId) {
        sendSafeError(
          response,
          400,
          "INVALID_REQUEST",
          "You cannot start a conversation with yourself.",
        );
        return;
      }
      const currentTime = now();
      const limitCheck = conversationRateLimiter.consume(requesterUserId, currentTime);
      if (!limitCheck.allowed) {
        response.setHeader("Retry-After", String(limitCheck.retryAfterSeconds));
        response
          .status(429)
          .json(failureEnvelope("RATE_LIMITED", "Conversation creation rate limit reached.", true));
        return;
      }
      const eligibility = await checkConversationPairEligibility(
        requesterUserId,
        validated.value.peerUserId,
        {
          profileStore,
          blockStore,
          isBlocked,
          userEligibilityLookup,
        },
      );
      if (!eligibility.ok) {
        if (eligibility.reason === "BLOCKED_BY_REQUESTER") {
          sendSafeError(response, 403, "BLOCKED", "You have blocked this user.");
          return;
        }
        sendSafeError(response, 404, "USER_UNAVAILABLE", "This user is unavailable.");
        return;
      }
      const result = await conversationStore.upsertDirect(
        requesterUserId,
        validated.value.peerUserId,
        currentTime,
      );
      const conversation = await toConversationSummary(result.conversation, requesterUserId, {
        profileStore,
        blockStore,
      });
      const data: ConversationCreateResponse = {
        conversation,
        created: result.created,
      };
      response.status(result.created ? 201 : 200).json(successEnvelope(data));
    },
  );

  // History (P2-07, FR-HIST-002, INT-006, DEC-021 §7, DEC-023 provisional):
  // member-only, conversation-scoped opaque cursor, bounded 50/100, ciphertext-only.
  router.get(
    "/conversations/:id/messages",
    auth,
    read,
    member,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      const conversationId = request.params.id as string;
      if (findOperatorKey(request.query)) {
        sendSafeError(response, 400, "INVALID_REQUEST", "Invalid history query parameters.");
        return;
      }
      const query = validateConversationHistoryQuery(
        request.query as unknown as Record<string, unknown>,
        conversationId,
      );
      if (!query.ok) {
        sendValidationFailure(response, query);
        return;
      }
      try {
        const page = await fetchConversationHistoryPage({
          conversationId,
          query: query.value,
          messageStore,
          conversationStore,
        });
        response.setHeader("Cache-Control", "no-store");
        response.status(200).json(successEnvelope(page));
      } catch {
        response
          .status(503)
          .json(
            failureEnvelope(
              "TEMPORARILY_UNAVAILABLE",
              "Message history is temporarily unavailable.",
              true,
            ),
          );
      }
    },
  );
  router.post(
    "/conversations/:id/messages",
    auth,
    sensitive,
    member,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      if (findOperatorKey(request.body)) {
        sendSafeError(response, 400, "INVALID_REQUEST", "Invalid request body.");
        return;
      }
      const validated = validateMessageSendRequest(request.body ?? {});
      if (!validated.ok) {
        sendValidationFailure(response, validated);
        return;
      }

      const requesterUserId = request.principal?.userId ?? "";
      const conversationId = request.params.id as string | undefined;
      const storedConversation = conversationId
        ? await conversationStore.getById(conversationId)
        : null;
      if (!storedConversation || !storedConversation.participantIds.includes(requesterUserId)) {
        sendSafeError(response, 404, "NOT_FOUND", "Resource not found.");
        return;
      }

      const currentTime = now();
      const limitCheck = messageRateLimiter.consume(requesterUserId, currentTime);
      if (!limitCheck.allowed) {
        response.setHeader("Retry-After", String(limitCheck.retryAfterSeconds));
        response
          .status(429)
          .json(failureEnvelope("RATE_LIMITED", "Message send rate limit reached.", true));
        return;
      }

      const eligibility = await checkMessageSendEligibility(
        storedConversation,
        requesterUserId,
        validated.value.request.senderDeviceId,
        {
          deviceKeyStore,
          blockStore,
          isBlocked,
          userEligibilityLookup,
        },
      );
      if (!eligibility.ok) {
        sendSafeError(response, eligibility.status, eligibility.code, eligibility.message);
        return;
      }

      const commitResult = await messageStore.submitDurable({
        conversationId: storedConversation.id,
        senderUserId: requesterUserId,
        senderDeviceId: validated.value.request.senderDeviceId,
        clientMessageId: validated.value.request.clientMessageId,
        protocolVersion: validated.value.request.protocolVersion,
        encryptedEnvelope: validated.value.request.encryptedEnvelope,
        conversationStore,
        now: currentTime,
      });

      if (!commitResult.ok) {
        if (commitResult.code === "IDEMPOTENCY_CONFLICT") {
          sendSafeError(
            response,
            409,
            "IDEMPOTENCY_CONFLICT",
            "Message send identity was reused with different content.",
          );
          return;
        }
        if (commitResult.code === "NOT_FOUND") {
          sendSafeError(response, 404, "NOT_FOUND", "Resource not found.");
          return;
        }
        response
          .status(503)
          .json(
            failureEnvelope(
              "TEMPORARILY_UNAVAILABLE",
              "Message persistence is temporarily unavailable.",
              true,
            ),
          );
        return;
      }

      if (!commitResult.idempotent && onMessageCommitted) {
        try {
          await onMessageCommitted(commitResult.record, storedConversation);
        } catch {
          // Live post-commit publish must never turn a durable commit into a false failure.
        }
      }

      const data: MessageSendResponse = {
        message: toMessageAckSummary(commitResult.record),
        idempotent: commitResult.idempotent,
      };
      response.status(commitResult.idempotent ? 200 : 201).json(successEnvelope(data));
    },
  );

  // Read-sharing privacy preferences (P2-11, FR-CHAT-010, DEC-020 §7.2):
  // strictly opt-in and default-off (false), derived solely from server principal.
  router.get(
    "/me/receipt-preferences",
    auth,
    read,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      response.setHeader("Cache-Control", "no-store");
      const userId = request.principal?.userId ?? "";
      const stored = await receiptStore.getPreferences(userId);
      const data: ReceiptPreferencesView = toReceiptPreferencesView(userId, stored, now());
      response.status(200).json(successEnvelope(data));
    },
  );
  router.patch(
    "/me/receipt-preferences",
    auth,
    sensitive,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      response.setHeader("Cache-Control", "no-store");
      if (findOperatorKey(request.body)) {
        sendSafeError(response, 400, "INVALID_REQUEST", "Invalid request body.");
        return;
      }
      const validated = validateUpdateReceiptPreferencesRequest(request.body ?? {});
      if (!validated.ok) {
        sendValidationFailure(response, validated);
        return;
      }
      const userId = request.principal?.userId ?? "";
      const stored = await receiptStore.setPreferences(
        userId,
        validated.value.readReceiptsEnabled,
        now(),
      );
      const data: ReceiptPreferencesView = toReceiptPreferencesView(userId, stored, now());
      response.status(200).json(successEnvelope(data));
    },
  );

  // Delivery & read receipts (P2-11, FR-CHAT-009..011, DEC-020, INT-002):
  // receipts are visible ONLY to message senders; recipients advance state
  // only with active bound device evidence.
  router.get(
    "/conversations/:id/receipts",
    auth,
    read,
    member,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      response.setHeader("Cache-Control", "no-store");
      const requesterUserId = request.principal?.userId ?? "";
      const conversationId = request.params.id as string | undefined;
      const storedConversation = conversationId
        ? await conversationStore.getById(conversationId)
        : null;
      if (!storedConversation || !storedConversation.participantIds.includes(requesterUserId)) {
        sendSafeError(response, 404, "NOT_FOUND", "Resource not found.");
        return;
      }
      const data: ConversationReceiptListResponse = await listConversationSenderReceipts(
        storedConversation,
        requesterUserId,
        receiptStore,
      );
      response.status(200).json(successEnvelope(data));
    },
  );
  router.get(
    "/conversations/:id/messages/:messageId/receipt",
    auth,
    read,
    member,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      response.setHeader("Cache-Control", "no-store");
      const requesterUserId = request.principal?.userId ?? "";
      const conversationId = request.params.id as string | undefined;
      const messageId = request.params.messageId as string | undefined;
      const storedConversation = conversationId
        ? await conversationStore.getById(conversationId)
        : null;
      if (
        !storedConversation ||
        !storedConversation.participantIds.includes(requesterUserId) ||
        !messageId
      ) {
        sendSafeError(response, 404, "NOT_FOUND", "Resource not found.");
        return;
      }
      const result = await getSingleMessageSenderReceipt(
        storedConversation,
        messageId,
        requesterUserId,
        messageStore,
        receiptStore,
      );
      if (!result.ok) {
        sendSafeError(response, result.status, result.code, result.message);
        return;
      }
      const data: MessageReceiptDetailResponse = result.response;
      response.status(200).json(successEnvelope(data));
    },
  );
  router.post(
    "/conversations/:id/messages/:messageId/receipt",
    auth,
    sensitive,
    member,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      response.setHeader("Cache-Control", "no-store");
      if (findOperatorKey(request.body)) {
        sendSafeError(response, 400, "INVALID_REQUEST", "Invalid request body.");
        return;
      }
      const validated = validateSubmitMessageReceiptRequest(request.body ?? {});
      if (!validated.ok) {
        sendValidationFailure(response, validated);
        return;
      }
      const requesterUserId = request.principal?.userId ?? "";
      const conversationId = request.params.id as string | undefined;
      const messageId = request.params.messageId as string | undefined;
      const storedConversation = conversationId
        ? await conversationStore.getById(conversationId)
        : null;
      if (
        !storedConversation ||
        !storedConversation.participantIds.includes(requesterUserId) ||
        !messageId
      ) {
        sendSafeError(response, 404, "NOT_FOUND", "Resource not found.");
        return;
      }
      const result = await submitMessageReceipt(
        storedConversation,
        messageId,
        requesterUserId,
        validated.value,
        {
          messageStore,
          receiptStore,
          deviceKeyStore,
          blockStore,
          isBlocked,
          now,
        },
      );
      if (!result.ok) {
        sendSafeError(response, result.status, result.code, result.message);
        return;
      }
      if (result.event && onReceiptAdvanced) {
        try {
          await onReceiptAdvanced(result.event, storedConversation);
        } catch {
          // Live receipt fan-out failures never turn committed persistence into 500.
        }
      }
      response.status(200).json(successEnvelope(result.response));
    },
  );

  // Private per-user read high-water mark & unread count (P2-11, FR-HIST-004, DATA-006).
  router.get(
    "/conversations/:id/read-progress",
    auth,
    read,
    member,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      response.setHeader("Cache-Control", "no-store");
      const requesterUserId = request.principal?.userId ?? "";
      const conversationId = request.params.id as string | undefined;
      const storedConversation = conversationId
        ? await conversationStore.getById(conversationId)
        : null;
      if (!storedConversation || !storedConversation.participantIds.includes(requesterUserId)) {
        sendSafeError(response, 404, "NOT_FOUND", "Resource not found.");
        return;
      }
      const data: ReadProgressResponse = await getOwnConversationReadProgress(
        storedConversation,
        requesterUserId,
        messageStore,
        receiptStore,
      );
      response.status(200).json(successEnvelope(data));
    },
  );
  router.post(
    "/conversations/:id/read-progress",
    auth,
    sensitive,
    member,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      response.setHeader("Cache-Control", "no-store");
      if (findOperatorKey(request.body)) {
        sendSafeError(response, 400, "INVALID_REQUEST", "Invalid request body.");
        return;
      }
      const validated = validateUpdateReadProgressRequest(request.body ?? {});
      if (!validated.ok) {
        sendValidationFailure(response, validated);
        return;
      }
      const requesterUserId = request.principal?.userId ?? "";
      const conversationId = request.params.id as string | undefined;
      const storedConversation = conversationId
        ? await conversationStore.getById(conversationId)
        : null;
      if (!storedConversation || !storedConversation.participantIds.includes(requesterUserId)) {
        sendSafeError(response, 404, "NOT_FOUND", "Resource not found.");
        return;
      }
      const data: ReadProgressResponse = await updateOwnConversationReadProgress(
        storedConversation,
        requesterUserId,
        validated.value,
        messageStore,
        receiptStore,
        now(),
      );
      response.status(200).json(successEnvelope(data));
    },
  );

  // Calls (FR-CALL + DEC-022): participant-scoped; no TURN credentials yet.
  router.get("/calls", auth, read, (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    sendEmptyList(response, { items: [] });
  });
  router.post("/calls", auth, sensitive, (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    sendPlaceholder(response);
  });
  router.get("/calls/:id", auth, read, async (request: PrincipalRequest, response: Response) => {
    const id = request.params.id as string | undefined;
    const call = id ? await callLookup(id) : null;
    const result: AuthzResult = canAccessCall(request.principal ?? null, call);
    if (sendAuthzDenial(response, result)) return;
    sendEmptyList(response, { items: [] });
  });
  router.post(
    "/calls/:id/end",
    auth,
    sensitive,
    (request: PrincipalRequest, response: Response) => {
      // Placeholder: authenticated callers receive the documented 503; no
      // call state is mutated. Participant check lands with P3 signaling.
      if (principalOrDenial(request, response)) return;
      sendPlaceholder(response);
    },
  );

  // Device directory v0 (P2-01, DEC-002/DEC-004). All device routes are
  // owner-scoped except the peer-visible public-key directory. Enrollment,
  // replacement, revocation, and backup linkage are sensitive (fresh session).
  router.get("/devices", auth, read, async (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    const limit = validatePageLimit(request.query.limit);
    if (!limit.ok) {
      sendValidationFailure(response, limit);
      return;
    }
    const records = await deviceKeyStore.listOwn(request.principal?.userId ?? "", limit.value);
    const data: DeviceListResponse = { items: records.map(deviceSummaryView) };
    response.status(200).json(successEnvelope(data));
  });
  router.get(
    "/devices/:id/keys",
    auth,
    read,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      const id = request.params.id as string | undefined;
      const record = id ? await deviceKeyStore.getOwn(request.principal?.userId ?? "", id) : null;
      // A device owned by another user is indistinguishable from a missing
      // device (uniform 404); the owner sees an explicit revoked state.
      if (!record) {
        sendSafeError(response, 404, "NOT_FOUND", "Resource not found.");
        return;
      }
      if (record.status !== "active") {
        sendSafeError(
          response,
          403,
          "DEVICE_REVOKED",
          "This device is revoked and has no published keys.",
        );
        return;
      }
      const data: DeviceKeyResponse = {
        device: ownerBundleView(record),
        backupLink: record.backupLink,
      };
      response.status(200).json(successEnvelope(data));
    },
  );
  router.post(
    "/devices/:id/keys",
    auth,
    sensitive,
    async (request: PrincipalRequest, response: Response) => {
      if (sensitiveOrDenial(request, response)) return;
      const id = request.params.id as string | undefined;
      const validated = validateDeviceEnrollmentRequest(request.body ?? {}, id);
      if (!validated.ok) {
        sendValidationFailure(response, validated);
        return;
      }
      const result = await deviceKeyStore.enroll(
        request.principal?.userId ?? "",
        validated.value.bundle,
        validated.value.replace,
      );
      if (!result.ok) {
        if (result.code === "REPLACEMENT_REQUIRED" || result.code === "INVALID_REPLACEMENT") {
          sendSafeError(
            response,
            409,
            "DEVICE_REPLACEMENT_REQUIRED",
            "An active device already exists; explicit restore or reset is required.",
          );
          return;
        }
        if (result.code === "IDENTITY_MISMATCH") {
          sendSafeError(
            response,
            400,
            "INVALID_REQUEST",
            "The identity key cannot change for an active device.",
          );
          return;
        }
        sendSafeError(
          response,
          403,
          "DEVICE_REVOKED",
          "This device is revoked and cannot publish keys.",
        );
        return;
      }
      const data: DeviceEnrollmentResponse = {
        device: ownerBundleView(result.record),
        replacedDeviceId: result.replacedDeviceId,
        backupRequired: true,
      };
      response.status(200).json(successEnvelope(data));
    },
  );
  router.post(
    "/devices/:id/revoke",
    auth,
    sensitive,
    async (request: PrincipalRequest, response: Response) => {
      if (sensitiveOrDenial(request, response)) return;
      const id = request.params.id as string | undefined;
      const validated = validateDeviceRevocationRequest(request.body ?? {});
      if (!validated.ok) {
        sendValidationFailure(response, validated);
        return;
      }
      if (!id) {
        sendSafeError(response, 404, "NOT_FOUND", "Resource not found.");
        return;
      }
      const result = await deviceKeyStore.revoke(
        request.principal?.userId ?? "",
        id,
        validated.value.reason,
      );
      if (!result.ok) {
        sendSafeError(response, 404, "NOT_FOUND", "Resource not found.");
        return;
      }
      const data: DeviceRevocationResponse = {
        deviceId: result.record.deviceId,
        status: result.record.status,
        revokedAt: result.record.revokedAt ?? new Date().toISOString(),
        replacedByDeviceId: result.record.replacedByDeviceId,
      };
      response.status(200).json(successEnvelope(data));
    },
  );
  router.get(
    "/devices/:userId/public-keys",
    auth,
    read,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      const userId = request.params.userId as string | undefined;
      if (!userId || userId.length > 128) {
        sendSafeError(response, 404, "NOT_FOUND", "Resource not found.");
        return;
      }
      const device = await deviceKeyStore.getActivePublicKeys(userId);
      if (!device) {
        // No active device and an unknown user share the same safe shape.
        sendSafeError(response, 404, "NOT_FOUND", "Resource not found.");
        return;
      }
      const data: DevicePublicKeysResponse = { userId, device };
      response.status(200).json(successEnvelope(data));
    },
  );
  router.post(
    "/key-backups/link",
    auth,
    sensitive,
    async (request: PrincipalRequest, response: Response) => {
      if (sensitiveOrDenial(request, response)) return;
      const validated = validateKeyBackupLinkRequest(request.body ?? {});
      if (!validated.ok) {
        sendValidationFailure(response, validated);
        return;
      }
      const result = await deviceKeyStore.linkBackup(
        request.principal?.userId ?? "",
        validated.value,
      );
      if (!result.ok) {
        if (result.code === "NOT_FOUND") {
          sendSafeError(response, 404, "NOT_FOUND", "Resource not found.");
          return;
        }
        if (result.code === "DEVICE_REVOKED") {
          sendSafeError(
            response,
            403,
            "DEVICE_REVOKED",
            "A revoked device cannot link a key backup.",
          );
          return;
        }
        sendSafeError(
          response,
          409,
          "IDEMPOTENCY_CONFLICT",
          "That backup is already linked to another device.",
        );
        return;
      }
      const data: KeyBackupLinkResponse = {
        deviceId: result.record.deviceId,
        link: result.link,
      };
      response.status(200).json(successEnvelope(data));
    },
  );

  // Key backup (DEC-003): owner-only, opaque ciphertext; placeholder reads.
  router.get("/key-backups", auth, read, (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    sendEmptyList(response, { items: [] });
  });
  router.get(
    "/key-backups/:id",
    auth,
    read,
    async (request: PrincipalRequest, response: Response) => {
      const id = request.params.id as string | undefined;
      const backup = id ? await keyBackupLookup(id) : null;
      const result: AuthzResult = canAccessKeyBackup(request.principal ?? null, backup);
      if (sendAuthzDenial(response, result)) return;
      sendEmptyList(response, { items: [] });
    },
  );
  router.post("/key-backups", auth, sensitive, (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    sendPlaceholder(response);
  });

  // Blocks (DEC-008 §3/§6/§7): private list, 50 max, silent to blocked user.
  router.get("/blocks", auth, read, async (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    const limit = validatePageLimit(request.query.limit);
    if (!limit.ok) {
      sendValidationFailure(response, limit);
      return;
    }
    const items = await blockStore.list(request.principal?.userId ?? "", limit.value);
    sendEmptyList(response, {
      items: items.map((b) => ({ blockedUserId: b.blockedUserId })),
    });
  });
  router.post("/blocks", auth, sensitive, async (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    const validated = validateBlockCreate(request.body ?? {});
    if (!validated.ok) {
      sendValidationFailure(response, validated);
      return;
    }
    const blocker = request.principal?.userId ?? "";
    const result = await blockStore.create(blocker, validated.value.blockedUserId);
    if (result === "SELF") {
      response
        .status(400)
        .json(failureEnvelope("INVALID_REQUEST", "You cannot block yourself.", false));
      return;
    }
    if (result === "LIMIT") {
      response.status(429).json(failureEnvelope("RATE_LIMITED", "Block limit reached.", false));
      return;
    }
    response.status(200).json(successEnvelope({ blockedUserId: result.blockedUserId }));
  });
  router.delete(
    "/blocks/:id",
    auth,
    sensitive,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      await blockStore.remove(request.principal?.userId ?? "", request.params.id as string);
      response.status(200).json(successEnvelope({ removed: true }));
    },
  );

  // Reports/appeals (DEC-008 §4/§6/§7): metadata-only + consented excerpts.
  // No server-side decryption/scanning; reporter identity never disclosed.
  router.get("/reports", auth, read, async (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    const items = await reportStore.listOwn(request.principal?.userId ?? "", 50);
    sendEmptyList(response, { items: items.map(reporterView) });
  });
  router.post(
    "/reports",
    auth,
    sensitive,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      const validated = validateReportCreate(request.body ?? {});
      if (!validated.ok) {
        sendValidationFailure(response, validated);
        return;
      }
      const created = await reportStore.create(request.principal?.userId ?? "", validated.value);
      if (!created.ok) {
        if (created.code === "SELF") {
          response
            .status(400)
            .json(failureEnvelope("INVALID_REQUEST", "You cannot report yourself.", false));
          return;
        }
        if (created.code === "RATE_LIMITED") {
          response
            .status(429)
            .json(failureEnvelope("RATE_LIMITED", "Daily report limit reached.", true));
          return;
        }
        response
          .status(409)
          .json(
            failureEnvelope("IDEMPOTENCY_CONFLICT", "Duplicate report within 24 hours.", false),
          );
        return;
      }
      response.status(200).json(successEnvelope(reporterView(created.record)));
    },
  );
  router.post(
    "/reports/:id/appeal",
    auth,
    sensitive,
    async (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      const report = await reportStore.getById(request.params.id as string);
      // Reports are invisible to anyone but the reporter; appeals are by
      // the reported user against a disposition. All others get 404.
      if (!report || report.reportedUserId !== request.principal?.userId) {
        response.status(404).json(failureEnvelope("NOT_FOUND", "Resource not found.", false));
        return;
      }
      const outcome = await reportStore.appeal(report.reportId, request.principal?.userId ?? "");
      if (outcome === "OK") {
        response
          .status(200)
          .json(
            successEnvelope(reportedView((await reportStore.getById(report.reportId)) as never)),
          );
        return;
      }
      if (outcome === "NO_DISPOSITION") {
        response
          .status(400)
          .json(failureEnvelope("INVALID_REQUEST", "No disposition to appeal.", false));
        return;
      }
      if (outcome === "WINDOW") {
        response
          .status(400)
          .json(failureEnvelope("INVALID_REQUEST", "Appeal window has closed.", false));
        return;
      }
      response
        .status(409)
        .json(failureEnvelope("IDEMPOTENCY_CONFLICT", "Appeal already submitted.", false));
    },
  );

  // Moderation queue (operator-only). Audit-trailed, no auto-disposition.
  router.get(
    "/moderation/queue",
    auth,
    read,
    async (request: PrincipalRequest, response: Response) => {
      const gate = guardOperator(request.principal ?? null);
      if (sendAuthzDenial(response, gate)) return;
      const items = await reportStore.queue(50);
      sendEmptyList(response, { items: items.map(operatorView) });
    },
  );
  router.post(
    "/moderation/reports/:id/dispose",
    auth,
    sensitive,
    async (request: PrincipalRequest, response: Response) => {
      const gate = guardOperator(request.principal ?? null);
      if (sendAuthzDenial(response, gate)) return;
      const validated = validateDisposition((request.body ?? {}).disposition);
      if (!validated.ok) {
        sendValidationFailure(response, validated);
        return;
      }
      const before = await reportStore.getById(request.params.id as string);
      if (!before) {
        response.status(404).json(failureEnvelope("NOT_FOUND", "Resource not found.", false));
        return;
      }
      await reportStore.dispose(before.reportId, validated.value);
      response
        .status(200)
        .json(successEnvelope(reportedView((await reportStore.getById(before.reportId)) as never)));
    },
  );

  // AI placeholders (FR-AI): no provider call, no plaintext stored.
  for (const feature of ["smart-reply", "translation", "summary"] as const) {
    router.post(
      `/ai/${feature}`,
      auth,
      sensitive,
      (request: PrincipalRequest, response: Response) => {
        if (principalOrDenial(request, response)) return;
        sendPlaceholder(response);
      },
    );
  }

  return router;
}
