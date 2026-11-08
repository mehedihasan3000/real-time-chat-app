import { auth } from "./auth.js";

/**
 * Server-only helpers. The browser JWT is memory-only (never persisted);
 * the session cookie is host-only HttpOnly SameSite=Lax (configured by
 * Better Auth defaults). These helpers are never exposed to the client.
 */
export async function getServerSession() {
  if (!auth) return null;
  // Better Auth session lookup happens via the auth handler / headers in
  // Next.js server components; this placeholder documents the boundary.
  return null;
}

/** Fresh token is obtained via /api/auth/token before API calls. */
export const AUTH_TOKEN_ENDPOINT = "/api/auth/token";
