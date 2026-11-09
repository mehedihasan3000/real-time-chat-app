import { exceedsAbsoluteCap, isFreshSession } from "@chat/contracts";

import type { VerifiedJwtClaims } from "../auth/jwt.js";
import type { SessionRecord } from "../auth/session.js";

/**
 * Server-derived principal (P1-07, FR-SEC-008 / INT-002).
 *
 * The principal is built ONLY from the verified JWT `sub` claim and the
 * authoritative MongoDB session record. Client-supplied ownership fields
 * (body/query `ownerId`, `participantIds`, `role`) are never read here.
 */
export interface Principal {
  /** Authenticated user ID from JWT `sub` (server-derived). */
  userId: string;
  /** Session ID from JWT `sid`. */
  sid: string;
  emailVerified: boolean;
  /** Effective role for vertical (role) checks. Default `user`. */
  role: "user" | "operator";
  /** Session is valid (not revoked/missing) at check time. */
  sessionValid: boolean;
  /** Session authenticated within the last 15 minutes (DEC-019). */
  sessionFresh: boolean;
  /** Authoritative authenticated-at timestamp for this session. */
  authenticatedAt: Date;
}

export type Role = Principal["role"];

export interface RoleLookup {
  (userId: string): Promise<Role> | Role;
}

const DEFAULT_ROLE_LOOKUP: RoleLookup = async (): Promise<Role> => "user";

/**
 * Derive a principal from verified claims + session record.
 * Returns null when the session is missing/revoked or `sid` does not
 * belong to `sub` — the caller maps that to a uniform denial.
 */
export function derivePrincipal(
  claims: VerifiedJwtClaims,
  session: SessionRecord | null,
  role: Role = "user",
  now = new Date(),
): Principal | null {
  if (!session || session.revoked) return null;
  if (session.userId !== claims.sub) return null;
  if (session.sid !== claims.sid) return null;

  const authenticatedAt = session.authenticatedAt;
  // Absolute cap (DEC-019): no session beyond 90 days from initial auth.
  // SessionRecord v0 carries only authenticatedAt; when an initial timestamp
  // is available later it is checked here. For v0, authenticatedAt doubles
  // as the freshness anchor and the cap is enforced in P1-06 session gates.
  const initialAt = (session as SessionRecord & { initialAuthenticatedAt?: Date })
    .initialAuthenticatedAt;
  if (initialAt && exceedsAbsoluteCap(initialAt, now)) return null;

  return {
    userId: claims.sub,
    sid: claims.sid,
    emailVerified: claims.emailVerified,
    role,
    sessionValid: true,
    sessionFresh: isFreshSession(authenticatedAt, now),
    authenticatedAt,
  };
}

export async function derivePrincipalWithRole(
  claims: VerifiedJwtClaims,
  session: SessionRecord | null,
  roleLookup: RoleLookup = DEFAULT_ROLE_LOOKUP,
  now = new Date(),
): Promise<Principal | null> {
  if (!session || session.revoked || session.userId !== claims.sub) return null;
  const role = await roleLookup(claims.sub);
  return derivePrincipal(claims, session, role, now);
}

/** Protected features require a verified principal (DEC-001 §3.3). */
export function isVerifiedPrincipal(principal: Principal): boolean {
  return principal.emailVerified === true;
}

/** Sensitive actions require a fresh session (DEC-019 §3.2). */
export function isFreshPrincipal(principal: Principal): boolean {
  return principal.sessionFresh === true;
}

/** Vertical role gate: moderation/disposition is operator-only. */
export function isOperator(principal: Principal): boolean {
  return principal.role === "operator";
}
