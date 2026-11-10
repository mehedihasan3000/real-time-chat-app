/**
 * Client crypto workspace (P2-01).
 *
 * The current `device/` provider is an explicitly provisional
 * `dev-webcrypto-v0` identity/key-directory foundation. It is not Olm, does
 * not encrypt messages, and must not be described as end-to-end encryption.
 * P2-02 adds the approved vodozemac/Olm binding and envelope encrypt/decrypt.
 */
export * from "./device/index.js";

export const cryptoPackageVersion = "0.1.0";
