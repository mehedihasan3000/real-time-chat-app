# `@chat/crypto` WASM Binding (`chat-olm-wasm`)

**Task:** `P2-02` — E2EE library integration (`DEC-018`)  
**Protocol / Library:** Olm (Double Ratchet) via [`vodozemac`](https://crates.io/crates/vodozemac) `=0.11.2` (Apache-2.0; Least Authority audit)  
**Target:** `wasm32-unknown-unknown` (`cdylib`)

## Security Boundary

- Exposes only the minimal account and 1:1 session surface required by `DEC-018` (`docs/crypto-device-key-lifecycle.md` §3–§4).
- Private identity (`Ed25519`), sender (`Curve25519`), one-time prekey, fallback prekey, and Double Ratchet keys remain inside WASM memory handles and are **never** exported in raw form to JavaScript (`FR-SEC-002`).
- Persistence crosses the WASM boundary only as encrypted `vodozemac` pickles keyed with a 32-byte key and wrapped at rest by a non-extractable Web Crypto `AES-256-GCM` `CryptoKey` (`FR-SEC-006`).
- Randomness is supplied by the host CSPRNG (`crypto.getRandomValues` via `env.host_fill_random`) and checked against missing or degenerate/constant entropy before use (`FR-SEC-004`).
- No public E2EE claim is made before independent security review (`FR-SEC-026` / `P6-02`).

## Rebuilding the WASM Artifact

```bash
cd packages/crypto/wasm
cargo build --target wasm32-unknown-unknown --release
cp target/wasm32-unknown-unknown/release/chat_olm_wasm.wasm chat_olm_wasm.wasm
```
