# Synthetic test fixtures

Everything in this directory is invented for the test harness. It contains no
real account, message, call, device, provider, or network data.

## Contents

| Module         | Purpose                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `users.ts`     | Two conversation participants plus one unrelated user, with English, Bengali, and mixed-Unicode display names.         |
| `content.ts`   | English, Bengali, and mixed-Unicode synthetic messages, Unicode edge cases, and duplicate/tampered idempotency inputs. |
| `states.ts`    | Shared labels for session, device/key, call, AI-consent, delivery, and empty states.                                   |
| `network.ts`   | Direct, forced-relay, and lossy forced-relay network profiles.                                                         |
| `providers.ts` | Deterministic, network-free AI and email provider doubles with stable failure codes.                                   |

## Rules

1. Keep every value synthetic. Do not paste production data, real message
   plaintext, tokens, cookies, SDP/ICE, keys, or provider output into a fixture.
2. A fixture is an input, not evidence that a capability exists. The current
   skeleton does not implement auth, messaging, calls, receipts, or real AI.
3. Provider doubles may demonstrate adapter wiring only. They do not satisfy a
   real-provider, real-device, or real-network acceptance criterion.
4. When a later task adds a real contract, extend the fixture rather than
   weakening the test. Record any unresolved threshold as blocked, not passed.
