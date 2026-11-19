/**
 * Client crypto workspace (`P2-01` device foundation + `P2-02` Olm/vodozemac integration).
 *
 * - `device/`: single-device public-key directory contracts, safety-number
 *   derivation, TOFU/key-change guard, capability preflight, and the
 *   provisional `dev-webcrypto-v0` identity helper from `P2-01`.
 * - `olm/`: approved `vodozemac` 0.11.2 WASM binding (`DEC-018`), Olm account
 *   and Double Ratchet session management, versioned envelope encrypt/decrypt,
 *   sealed state persistence, and fail-closed error handling (`P2-02`).
 *
 * Non-claim (`FR-SEC-026` / `P6-02`): no public E2EE claim is made before
 * qualified independent security review of the implemented boundaries.
 */
export * from "./device/index.js";
export * from "./envelope/index.js";
export * from "./olm/index.js";

export const cryptoPackageVersion = "0.2.0";
