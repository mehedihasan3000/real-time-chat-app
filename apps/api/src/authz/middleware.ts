import type { NextFunction, Response } from "express";

import { failureEnvelope } from "@chat/contracts";

import { derivePrincipalWithRole, type Principal, type RoleLookup } from "./principal.js";
import type { ConversationResource, ResourceLookup } from "./resources.js";
import { canAccessConversation, SESSION_REVOKED, type AuthzResult, type Denial } from "./checks.js";
import type { AuthenticatedRequest } from "../auth/middleware.js";
import type { SessionLookup } from "../auth/session.js";
import { getSessionForRead, getSessionForSensitive } from "../auth/session.js";

export interface PrincipalRequest extends AuthenticatedRequest {
  principal?: Principal;
}

function sendDenial(response: Response, denial: Denial): void {
  response
    .status(denial.httpStatus)
    .json(failureEnvelope(denial.code, denial.message, denial.retryable));
}

export function sendAuthzDenial(response: Response, result: AuthzResult): boolean {
  if (result.ok) return false;
  sendDenial(response, result.denial);
  return true;
}

/**
 * Derive the server principal from the already-verified JWT claims.
 * Must run AFTER requireAuth. Uses the direct session lookup (sensitive)
 * so a revoked sid fails immediately on every protected HTTP operation.
 */
export function attachPrincipal(
  sessionLookup: SessionLookup,
  roleLookup?: RoleLookup,
  now?: () => Date,
) {
  return async (
    request: PrincipalRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (!request.jwt) {
      sendDenial(response, SESSION_REVOKED);
      return;
    }
    const session = await getSessionForSensitive(sessionLookup, request.jwt.sid);
    const principal = await derivePrincipalWithRole(
      request.jwt,
      session,
      roleLookup,
      now ? now() : new Date(),
    );
    if (!principal) {
      sendDenial(response, SESSION_REVOKED);
      return;
    }
    request.principal = principal;
    next();
  };
}

/** Read-path principal: 60s cached sid check for ordinary reads (DEC-019). */
export function attachPrincipalForRead(
  sessionLookup: SessionLookup,
  roleLookup?: RoleLookup,
  now?: () => Date,
) {
  return async (
    request: PrincipalRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (!request.jwt) {
      sendDenial(response, SESSION_REVOKED);
      return;
    }
    const session = await getSessionForRead(sessionLookup, request.jwt.sid);
    const principal = await derivePrincipalWithRole(
      request.jwt,
      session,
      roleLookup,
      now ? now() : new Date(),
    );
    if (!principal) {
      sendDenial(response, SESSION_REVOKED);
      return;
    }
    request.principal = principal;
    next();
  };
}

export interface ConversationMemberOptions {
  conversationLookup: ResourceLookup<ConversationResource>;
  /** Param/body/query field carrying the conversation ID. Default "id". */
  idField?: string;
}

/**
 * Object-level middleware (INT-002): the route authorizes against the
 * authenticated principal and the server-resolved conversation record.
 * Client-supplied membership fields are ignored. Missing and
 * nonparticipant both yield 404 NOT_FOUND (enumeration-safe).
 */
export function requireConversationMember(options: ConversationMemberOptions) {
  const idField = options.idField ?? "id";
  return async (
    request: PrincipalRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    const id =
      (request.params?.[idField] as string | undefined) ??
      (request.body?.[idField] as string | undefined) ??
      (request.query?.[idField] as string | undefined);
    if (!id || typeof id !== "string") {
      sendDenial(response, {
        code: "INVALID_REQUEST",
        httpStatus: 400,
        message: "Conversation identifier is required.",
        retryable: false,
      });
      return;
    }
    const conversation = await options.conversationLookup(id);
    const result = canAccessConversation(request.principal ?? null, conversation);
    if (!result.ok) {
      sendDenial(response, result.denial);
      return;
    }
    next();
  };
}
