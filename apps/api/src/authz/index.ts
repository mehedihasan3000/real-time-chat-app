/**
 * Authorization foundation v0 (P1-07, FR-SEC-008 / INT-002 / INT-004).
 *
 * Carries the TC-SEC-005 v0 contract for P1-08 (API skeleton) and P1-09
 * (Socket.IO foundation). Provisional under Release-gated DEC-023 for
 * contract shapes; no production authorization claim.
 */
export * from "./checks.js";
export * from "./principal.js";
export type * from "./resources.js";
export * from "./middleware.js";
export * from "./socket.js";
