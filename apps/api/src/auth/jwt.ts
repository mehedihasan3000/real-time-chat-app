import * as jose from "jose";

export interface VerifiedJwtClaims {
  sub: string;
  sid: string;
  emailVerified: boolean;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  kid?: string;
}

/**
 * Verify a 5-minute EdDSA JWT via JWKS (DEC-019 §3.1).
 * - alg allowlist: EdDSA only (rejects none/symmetric)
 * - checks: signature, iss (app origin), aud (api origin), exp/iat, kid
 * - clock-skew tolerance: 5s (jose default window via clockTolerance)
 */
export function createVerifier(config: {
  appOrigin: string;
  apiOrigin: string;
  jwksUri?: string;
  resolveKey?: jose.JWTVerifyGetKey;
}) {
  const jwks = config.jwksUri ? jose.createRemoteJWKSet(new URL(config.jwksUri)) : null;

  return async function verify(token: string): Promise<VerifiedJwtClaims> {
    const keyFor = config.resolveKey ?? (jwks ? jwks : null);
    if (!keyFor) {
      throw new Error("JWKS not configured: set jwksUri or resolveKey in tests.");
    }
    const { payload } = await jose.jwtVerify(token, keyFor, {
      issuer: config.appOrigin,
      audience: config.apiOrigin,
      algorithms: ["EdDSA"],
      clockTolerance: 5,
    });
    const sub = payload.sub;
    const sid = payload.sid as string | undefined;
    if (typeof sub !== "string" || typeof sid !== "string") {
      throw new Error("JWT missing sub/sid claims");
    }
    return {
      sub,
      sid,
      emailVerified: payload.email_verified === true,
      iss: String(payload.iss ?? ""),
      aud: String(payload.aud ?? ""),
      exp: Number(payload.exp),
      iat: Number(payload.iat),
      kid: typeof payload.kid === "string" ? payload.kid : undefined,
    };
  };
}

/** Mint a synthetic Ed25519 JWT for tests (no real user data). */
export async function mintTestToken(opts: {
  sub: string;
  sid: string;
  emailVerified: boolean;
  iss: string;
  aud: string;
  expiresInSeconds?: number;
  keyPair?: {
    privateKey: import("jose").CryptoKey;
    publicKey: import("jose").CryptoKey;
    kid: string;
  };
}) {
  const keyPair =
    opts.keyPair ??
    ((await jose.generateKeyPair("Ed25519", { extractable: true })) as unknown as {
      privateKey: import("jose").CryptoKey;
      publicKey: import("jose").CryptoKey;
      kid: string;
    });
  const kid = keyPair.kid ?? "test-kid";
  const token = await new jose.SignJWT({
    sub: opts.sub,
    sid: opts.sid,
    email_verified: opts.emailVerified,
  })
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuer(opts.iss)
    .setAudience(opts.aud)
    .setIssuedAt()
    .setExpirationTime(`${opts.expiresInSeconds ?? 300}s`)
    .sign(keyPair.privateKey as never);
  return { token, keyPair: { ...keyPair, kid } };
}
