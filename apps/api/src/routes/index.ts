import { Router, type Request, type Response } from "express";

import {
  failureEnvelope,
  successEnvelope,
  validateDiscoveryUsername,
  validateHistoryQuery,
  validateReportReason,
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
  } = options;

  const auth = requireAuth(verifier);
  const sensitive = attachPrincipal(sessionLookup, roleLookup);
  const read = attachPrincipalForRead(sessionLookup, roleLookup);
  const member = requireConversationMember({ conversationLookup, idField: "id" });

  // Readiness (OPS-010, public): no topology, credentials, or dependency detail.
  router.get("/ready", (_request: Request, response: Response) => {
    response.status(200).json(successEnvelope({ ready: true, service: "api" }));
  });

  // Me (INT-002): principal-derived only. No email, token, or session secret.
  router.get("/me", auth, read, meHandler);

  // Discovery (FR-PROF-004 / DEC-020): exact normalized username only.
  // v0 store is empty by default → neutral no-result; blocked users omitted
  // by construction (nothing is listed). No prefix/email lookup exists.
  router.get("/discovery", auth, read, (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    const username = validateDiscoveryUsername(request.query.username);
    if (!username.ok) {
      sendValidationFailure(response, username);
      return;
    }
    sendEmptyList(response, { items: [] });
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

  // Blocks (DEC-008 §3/§6): own-list empty; create/delete are placeholders
  // that cannot leak block state cross-user or mutate any store.
  router.get("/blocks", auth, read, (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    sendEmptyList(response, { items: [] });
  });
  router.post("/blocks", auth, sensitive, (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    sendPlaceholder(response);
  });
  router.delete("/blocks/:id", auth, sensitive, (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    sendPlaceholder(response);
  });

  // Reports/appeals (DEC-008 §4/§6): metadata-only in the skeleton.
  // Excerpts/plaintext are rejected — no server-side decryption/scanning.
  router.get("/reports", auth, read, (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    sendEmptyList(response, { items: [] });
  });
  router.post("/reports", auth, sensitive, (request: PrincipalRequest, response: Response) => {
    if (principalOrDenial(request, response)) return;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const reason = validateReportReason(body.reason);
    if (!reason.ok) {
      sendValidationFailure(response, reason);
      return;
    }
    if ("optionalExcerpts" in body && body.optionalExcerpts !== undefined) {
      response
        .status(400)
        .json(
          failureEnvelope(
            "INVALID_REQUEST",
            "Report excerpts are not accepted in the skeleton.",
            false,
          ),
        );
      return;
    }
    sendPlaceholder(response);
  });
  router.post(
    "/reports/:id/appeal",
    auth,
    sensitive,
    (request: PrincipalRequest, response: Response) => {
      if (principalOrDenial(request, response)) return;
      sendPlaceholder(response);
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
