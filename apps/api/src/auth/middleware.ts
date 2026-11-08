import type { NextFunction, Request, Response } from "express";

import { failureEnvelope, ERROR_HTTP_STATUS } from "@chat/contracts";
import { createVerifier, type VerifiedJwtClaims } from "./jwt.js";
import {
  getSessionForRead,
  getSessionForSensitive,
  requireFreshForSensitive,
  requireVerifiedForProtected,
  type SessionLookup,
} from "./session.js";

export interface AuthenticatedRequest extends Request {
  jwt?: VerifiedJwtClaims;
  session?: { sid: string; userId: string };
}

/**
 * Express Bearer-JWT middleware (DEC-019 §3.1). API uses Authorization
 * header only — no session cookie, so no CSRF on API mutations.
 */
export function requireAuth(verifier: ReturnType<typeof createVerifier>) {
  return async (request: AuthenticatedRequest, response: Response, next: NextFunction) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return response
        .status(ERROR_HTTP_STATUS.UNAUTHENTICATED)
        .json(failureEnvelope("UNAUTHENTICATED", "Missing bearer token.", false));
    }
    try {
      const claims = await verifier(header.slice("Bearer ".length));
      request.jwt = claims;
      return next();
    } catch {
      return response
        .status(ERROR_HTTP_STATUS.UNAUTHENTICATED)
        .json(failureEnvelope("UNAUTHENTICATED", "Invalid or expired token.", false));
    }
  };
}

export function requireVerified() {
  return (request: AuthenticatedRequest, response: Response, next: NextFunction) => {
    if (!request.jwt) {
      return response
        .status(ERROR_HTTP_STATUS.UNAUTHENTICATED)
        .json(failureEnvelope("UNAUTHENTICATED", "Authentication required.", false));
    }
    if (!request.jwt.emailVerified) {
      return response
        .status(ERROR_HTTP_STATUS.FORBIDDEN)
        .json(failureEnvelope("FORBIDDEN", "Email verification required.", false));
    }
    return next();
  };
}

/** Sensitive mutations + socket handshake/refresh: direct Mongo sid check + 15-min freshness. */
export function requireSensitive(lookup: SessionLookup) {
  return async (request: AuthenticatedRequest, response: Response, next: NextFunction) => {
    if (!request.jwt) {
      return response
        .status(ERROR_HTTP_STATUS.UNAUTHENTICATED)
        .json(failureEnvelope("UNAUTHENTICATED", "Authentication required.", false));
    }
    const record = await getSessionForSensitive(lookup, request.jwt.sid);
    if (!record || record.userId !== request.jwt.sub) {
      return response
        .status(ERROR_HTTP_STATUS.SESSION_REVOKED)
        .json(failureEnvelope("SESSION_REVOKED", "Session is no longer valid.", false));
    }
    if (!requireVerifiedForProtected(record, request.jwt.emailVerified)) {
      return response
        .status(ERROR_HTTP_STATUS.FORBIDDEN)
        .json(failureEnvelope("FORBIDDEN", "Email verification required.", false));
    }
    if (!requireFreshForSensitive(record)) {
      return response
        .status(ERROR_HTTP_STATUS.FORBIDDEN)
        .json(failureEnvelope("FORBIDDEN", "Recent authentication required.", false));
    }
    request.session = { sid: record.sid, userId: record.userId };
    return next();
  };
}

/** Ordinary reads: 60s cached sid check. */
export function requireReadSession(lookup: SessionLookup) {
  return async (request: AuthenticatedRequest, response: Response, next: NextFunction) => {
    if (!request.jwt) {
      return response
        .status(ERROR_HTTP_STATUS.UNAUTHENTICATED)
        .json(failureEnvelope("UNAUTHENTICATED", "Authentication required.", false));
    }
    const record = await getSessionForRead(lookup, request.jwt.sid);
    if (!record || record.userId !== request.jwt.sub) {
      return response
        .status(ERROR_HTTP_STATUS.SESSION_REVOKED)
        .json(failureEnvelope("SESSION_REVOKED", "Session is no longer valid.", false));
    }
    request.session = { sid: record.sid, userId: record.userId };
    return next();
  };
}
