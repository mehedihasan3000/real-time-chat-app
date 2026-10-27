/**
 * Shared, transport-agnostic contracts between the web client and the API.
 *
 * This package is intentionally minimal in the scaffold. Canonical message,
 * auth, and conversation contracts are gated by DEC-023 and land with the
 * tasks that implement them.
 */

export const contractsVersion = "0.1.0";

export interface HealthResponse {
  status: "ok";
  service: "api";
  contractsVersion: string;
}
