import {
  BODY_MAX_BYTES,
  contractsVersion,
  failureEnvelope,
  type HealthResponse,
} from "@chat/contracts";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

import type { createVerifier } from "./auth/jwt.js";
import { requireAuth } from "./auth/middleware.js";
import type { SessionLookup } from "./auth/session.js";
import { attachPrincipalForRead } from "./authz/middleware.js";
import type { RoleLookup } from "./authz/index.js";
import type {
  CallResource,
  ConversationResource,
  DeviceResource,
  KeyBackupResource,
  ResourceLookup,
} from "./authz/index.js";
import { createApiRouter } from "./routes/index.js";
import { meHandler } from "./routes/me.js";

export interface CreateAppOptions {
  /** Injected by tests/staging wiring. Absent → protected routes fail closed (401). */
  verifier?: ReturnType<typeof createVerifier>;
  sessionLookup?: SessionLookup;
  roleLookup?: RoleLookup;
  conversationLookup?: ResourceLookup<ConversationResource>;
  callLookup?: ResourceLookup<CallResource>;
  deviceLookup?: ResourceLookup<DeviceResource>;
  keyBackupLookup?: ResourceLookup<KeyBackupResource>;
}

const DENY_VERIFIER = (async (): Promise<never> => {
  throw new Error("API verifier is not configured.");
}) as unknown as ReturnType<typeof createVerifier>;

const DENY_SESSION: SessionLookup = async () => null;

/**
 * Express application (P1-08 skeleton). `/health` stays public (existing
 * contract); `/api/v1/*` and `/api/me` are the versioned skeleton routes.
 * Protected routes fail closed (401) until a JWKS verifier + session
 * lookup are wired (P1-15 staging wiring; disclosed as a gap).
 */
export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: `${BODY_MAX_BYTES}b` }));

  app.get("/health", (_request: Request, response: Response) => {
    const body: HealthResponse = {
      status: "ok",
      service: "api",
      contractsVersion,
    };

    response.status(200).json(body);
  });

  const apiRouter = createApiRouter({
    verifier: options.verifier ?? DENY_VERIFIER,
    sessionLookup: options.sessionLookup ?? DENY_SESSION,
    roleLookup: options.roleLookup,
    conversationLookup: options.conversationLookup,
    callLookup: options.callLookup,
    deviceLookup: options.deviceLookup,
    keyBackupLookup: options.keyBackupLookup,
  });
  app.use("/api/v1", apiRouter);
  // `/api/me` alias (scope) → same principal-derived handler as /api/v1/me.
  app.get(
    "/api/me",
    requireAuth(options.verifier ?? DENY_VERIFIER),
    attachPrincipalForRead(options.sessionLookup ?? DENY_SESSION, options.roleLookup),
    meHandler,
  );

  app.use((_request: Request, response: Response) => {
    response.status(404).json(failureEnvelope("NOT_FOUND", "Resource not found.", false));
  });

  app.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { type?: string }).type === "entity.too.large"
    ) {
      response
        .status(413)
        .json(failureEnvelope("PAYLOAD_TOO_LARGE", "Request body is too large.", false));
      return;
    }
    if (error instanceof SyntaxError) {
      response
        .status(400)
        .json(failureEnvelope("INVALID_REQUEST", "Request body must be valid JSON.", false));
      return;
    }
    next(error);
  });

  return app;
}
