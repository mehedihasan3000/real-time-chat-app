import type { Response } from "express";

import { successEnvelope } from "@chat/contracts";

import type { PrincipalRequest } from "../authz/middleware.js";
import { guardProtected, sendAuthzDenial } from "../authz/index.js";

/** GET /api/me (also /api/v1/me) — principal-derived only. */
export function meHandler(request: PrincipalRequest, response: Response): void {
  const result = guardProtected(request.principal ?? null);
  if (sendAuthzDenial(response, result)) return;
  const principal = request.principal;
  response.status(200).json(
    successEnvelope({
      userId: principal?.userId ?? "",
      emailVerified: principal?.emailVerified ?? false,
      role: principal?.role ?? "user",
      sessionFresh: principal?.sessionFresh ?? false,
    }),
  );
}
