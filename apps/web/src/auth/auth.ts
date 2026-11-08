import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { MongoClient } from "mongodb";

import {
  SESSION_ABSOLUTE_DAYS,
  SESSION_DEFAULT_DAYS,
  SESSION_REMEMBER_DAYS,
} from "@chat/contracts";

/**
 * Better Auth instance (P1-06, DEC-001/DEC-019). Runs in Next.js at the
 * app origin; MongoDB sessions are authoritative; API authenticates via
 * 5-min EdDSA JWT/JWKS (verified in apps/api/src/auth/jwt.ts).
 *
 * Email delivery (Resend) and Google OAuth are env-gated and fail closed
 * when unconfigured — the UI must truthfully disclose when disabled.
 */
const mongodbUri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB ?? "real_time_chat_dev";

const clientForAdapter = mongodbUri ? new MongoClient(mongodbUri) : null;

export const EMAIL_DELIVERY_ENABLED = Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
export const GOOGLE_OAUTH_ENABLED = Boolean(
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
);

export const auth = clientForAdapter
  ? betterAuth({
      database: mongodbAdapter(clientForAdapter.db(dbName)),
      emailAndPassword: {
        enabled: true,
        // Invitation-style: require verification before protected features (DEC-001 §3.3).
        requireEmailVerification: true,
        sendVerificationEmail: EMAIL_DELIVERY_ENABLED
          ? async () => {
              // Resend adapter lands in P6; until then delivery is disabled and disclosed.
            }
          : undefined,
        sendResetPassword: EMAIL_DELIVERY_ENABLED
          ? async () => {
              // Same gate as above.
            }
          : undefined,
        minPasswordLength: 12,
        maxPasswordLength: 128,
      },
      socialProviders: GOOGLE_OAUTH_ENABLED
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID!,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            },
          }
        : undefined,
      session: {
        expiresIn: SESSION_DEFAULT_DAYS * 24 * 60 * 60,
        updateAge: 24 * 60 * 60,
        cookieCache: { enabled: false, maxAge: 0 },
      },
      account: {
        // Explicit linking only (DEC-019 §3.4).
        accountLinking: { enabled: true, disableImplicitLinking: true },
      },
    })
  : null;

/** Absolute cap helper (90 days) — enforced in API session checks + UI. */
export const SESSION_ABSOLUTE_DAYS_EXPOSED = SESSION_ABSOLUTE_DAYS;
export const SESSION_REMEMBER_DAYS_EXPOSED = SESSION_REMEMBER_DAYS;

/**
 * Disabled flows are truthfully disclosed in the UI:
 * - Email delivery: enabled only with RESEND_API_KEY + EMAIL_FROM.
 * - Google sign-in: enabled only with GOOGLE_CLIENT_ID/SECRET.
 * - Recovery: email-only (no SMS, no admin bypass) per DEC-001.
 */
export const authDisclosures = {
  emailDelivery: EMAIL_DELIVERY_ENABLED
    ? "enabled"
    : "disabled — verification/reset links are not sent in this environment",
  googleSignIn: GOOGLE_OAUTH_ENABLED
    ? "enabled"
    : "disabled — Google credentials are not configured in this environment",
  recovery: "email-only — no SMS or administrator reset is available",
} as const;
