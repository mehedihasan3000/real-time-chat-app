import { Router, type Request, type Response } from "express";

import {
  failureEnvelope,
  successEnvelope,
  validateBlockCreate,
  validateDiscoveryUsername,
  validateDisplayName,
  validateDisposition,
  validateHistoryQuery,
  validatePageLimit,
  validateReportCreate,
  validateUsername,
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
  canAccessDevice,
  canAccessKeyBackup,
  guardProtected,
  sendAuthzDenial,
  type AuthzResult,
} from "../authz/index.js";
import type { RoleLookup } from "../authz/index.js";
import type {
  CallResource,
  ConversationResource,
  DeviceResource,
  KeyBackupResource,
  ResourceLookup,
} from "../authz/index.js";
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
  callLookup?: ResourceLookup<CallResource>;
  deviceLookup?: ResourceLookup<DeviceResource>;
  keyBackupLookup?: ResourceLookup<KeyBackupResource>;
  metrics?: MetricsRegistry;
  profileStore?: ProfileStore;
  isBlocked?: BlockPredicate;
  blockStore?: BlockStore;
  reportStore?: ReportStore;
}

const denyNullConversation: ResourceLookup<ConversationResource> = async () => null;
const denyNullCall: ResourceLookup<CallResource> = async () => null;
const denyNullDevice: ResourceLookup<DeviceResource> = async () => null;
const denyNullBackup: ResourceLookup<KeyBackupResource> = async () => null;

function principalOrDenial(request: PrincipalRequest, response: Response): boolean {
  const result = guardProtected(request.principal ?? null);
  if (sendAuthzDenial(response, result)) return true;
  return false;
}

export function createApiRouter(options: ApiRouterOptions): Router {
  const router = Router();
  const {
    verifier,
    sessionLookup,
    roleLookup,
    conversationLookup = denyNullConversation,
    callLookup = denyNullCall,
    deviceLookup = denyNullDevice,
    keyBackupLookup = denyNullBackup,
    profileStore = new MemoryProfileStore(),
    isBlocked,
    blockStore = new MemoryBlockStore(),
    reportStore = new MemoryReportStore(),
  } = options;
  const blockedBetween: BlockPredicate = isBlocked ?? ((a, b) => blockStore.isBlocked(a, b));

  const auth = requireAuth(verifier);
  const sensitive = attachPrincipal(sessionLookup, roleLookup);
  const read = attachPrincipalForRead(sessionLookup, roleLookup);
  const member = requireConversationMember({ conversationLookup, idField: "id" });

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

  // Conversations (FR-HIST-001 + DEC-023 §9.1).
  router.get("/conversations", auth, read, (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    sendEmptyList(response, { items: [], nextCursor: null, hasMore: false });
  });
  router.post(
    "/conversations",
    auth,
    sensitive,
    (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      sendPlaceholder(response);
    },
  );

  // History (FR-HIST-002): bounded pagination + member-only.
  router.get(
    "/conversations/:id/messages",
    auth,
    read,
    member,
    (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      const query = validateHistoryQuery(request.query as unknown as Record<string, unknown>);
      if (!query.ok) {
        sendValidationFailure(response, query);
        return;
      }
      sendEmptyList(response, { items: [], nextCursor: null, hasMore: false });
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

  // Device keys (DEC-002): owner-only; enrollment is sensitive (fresh session).
  router.get("/devices", auth, read, (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    sendEmptyList(response, { items: [] });
  });
  router.get(
    "/devices/:id/keys",
    auth,
    read,
    async (request: PrincipalRequest, response: Response) => {
      const id = request.params.id as string | undefined;
      const device = id ? await deviceLookup(id) : null;
      const result: AuthzResult = canAccessDevice(request.principal ?? null, device);
      if (sendAuthzDenial(response, result)) return;
      sendEmptyList(response, { items: [] });
    },
  );
  router.post(
    "/devices/:id/keys",
    auth,
    sensitive,
    (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      sendPlaceholder(response);
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
