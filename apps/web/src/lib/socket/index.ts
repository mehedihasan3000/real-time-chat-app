/**
 * Browser socket client foundation v0 (P1-09).
 *
 * Memory-only tokens, 4-minute reauthentication (within the 5-minute JWT
 * max), and fail-closed `session:expired` handling. See `client.ts`.
 */
export * from "./client.js";
