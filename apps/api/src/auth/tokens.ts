import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  generateKeyPair,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from "jose";
import type { Config } from "../config.js";

/** Access tokens: EdDSA (Ed25519) JWTs, 10 min (ADR-004). Refresh tokens: opaque, stored only as SHA-256. */
export interface JwtKeys {
  privateKey: CryptoKey | KeyObject;
  publicKey: CryptoKey | KeyObject;
  ephemeral: boolean;
}

export const ACCESS_TTL_SEC = 600;
export const REFRESH_TTL_SEC = 7 * 24 * 3600;
export const SESSION_IDLE_SEC = 30 * 60;
export const REAUTH_WINDOW_SEC = 5 * 60;
const ALG = "Ed25519";

export async function loadKeys(cfg: Config): Promise<JwtKeys> {
  if (cfg.JWT_PRIVATE_KEY_PEM && cfg.JWT_PUBLIC_KEY_PEM) {
    return {
      privateKey: await importPKCS8(cfg.JWT_PRIVATE_KEY_PEM.replace(/\\n/g, "\n"), ALG),
      publicKey: await importSPKI(cfg.JWT_PUBLIC_KEY_PEM.replace(/\\n/g, "\n"), ALG),
      ephemeral: false,
    };
  }
  // development/test only (config refuses this in staging/production): per-process keys.
  const { privateKey, publicKey } = await generateKeyPair(ALG);
  return { privateKey, publicKey, ephemeral: true };
}

export interface AccessClaims {
  sub: string;
  sid: string;
}

export async function signAccessToken(keys: JwtKeys, c: AccessClaims): Promise<string> {
  return new SignJWT({ sid: c.sid })
    .setProtectedHeader({ alg: ALG })
    .setSubject(c.sub)
    .setIssuer("fincore")
    .setAudience("fincore-api")
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(`${ACCESS_TTL_SEC}s`)
    .sign(keys.privateKey);
}

export async function verifyAccessToken(
  keys: JwtKeys,
  token: string,
): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, keys.publicKey, {
      issuer: "fincore",
      audience: "fincore-api",
      algorithms: [ALG],
    });
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;
    return { sub: payload.sub, sid: payload.sid };
  } catch {
    return null;
  }
}

export const newOpaqueToken = () => randomBytes(32).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest();
