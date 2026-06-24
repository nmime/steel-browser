import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { JwtClaims } from "./auth.types.js";

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeCompare(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  if (aBuffer.length !== bBuffer.length) return false;
  return timingSafeEqual(aBuffer, bBuffer);
}

export function generateApiKey(): string {
  return `sk_steel_${randomBytes(32).toString("base64url")}`;
}

export function signJwt(claims: JwtClaims, secret: string, expiresInSeconds = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload: JwtClaims = {
    iat: now,
    exp: now + expiresInSeconds,
    iss: "steel-browser",
    ...claims,
  };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

export function verifyJwt(token: string, secret: string): JwtClaims {
  const [header, payload, signature] = token.split(".");
  if (!header || !payload || !signature) throw new Error("invalid jwt");
  const unsigned = `${header}.${payload}`;
  const expected = createHmac("sha256", secret).update(unsigned).digest("base64url");
  if (!safeCompare(signature, expected)) throw new Error("invalid jwt signature");
  const parsedHeader = JSON.parse(decodeBase64Url(header).toString("utf8"));
  if (parsedHeader.alg !== "HS256") throw new Error("unsupported jwt alg");
  const claims = JSON.parse(decodeBase64Url(payload).toString("utf8")) as JwtClaims;
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) throw new Error("jwt expired");
  return claims;
}

export function hashPassword(password: string, salt = "steel-browser-local-auth"): string {
  return scryptSync(password, salt, 32).toString("hex");
}

export function verifyPassword(
  userPassword: string,
  password?: string,
  passwordHash?: string,
): boolean {
  if (passwordHash) return safeCompare(hashPassword(userPassword), passwordHash);
  return Boolean(password && safeCompare(userPassword, password));
}
