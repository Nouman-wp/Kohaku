import { createECDH, createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { HSP_AUDIENCE, hspHash, type HspCartContents } from "./hsp.ts";

/**
 * Node-only HSP helpers: the request signing, JWTs and webhook signatures of the HashKey
 * Merchant API. Kept out of the main entry so the browser bundle never pulls in node:crypto.
 */

export function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function jsonPart(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ request signing

/**
 * HMAC-SHA256 request signature of the HashKey Merchant API:
 *   message = METHOD \n PATH \n QUERY \n sha256(body) \n timestamp \n nonce
 * The body hash is over the exact bytes sent (empty string for no body).
 */
export function hspRequestSignature(o: { method: string; path: string; query: string; body: string; timestamp: string; nonce: string; appSecret: string }): string {
  const bodyHash = o.body ? createHash("sha256").update(o.body, "utf8").digest("hex") : "";
  const message = [o.method.toUpperCase(), o.path, o.query, bodyHash, o.timestamp, o.nonce].join("\n");
  return createHmac("sha256", o.appSecret).update(message, "utf8").digest("hex");
}

export function hspRequestHeaders(o: { method: string; path: string; query?: string; body?: string; appKey: string; appSecret: string }): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString("hex");
  const signature = hspRequestSignature({ method: o.method, path: o.path, query: o.query ?? "", body: o.body ?? "", timestamp, nonce, appSecret: o.appSecret });
  return { "X-App-Key": o.appKey, "X-Timestamp": timestamp, "X-Nonce": nonce, "X-Signature": signature };
}

/** Server side of the same scheme (used by Kohaku's local HSP gateway). */
export function checkHspRequest(
  headers: Record<string, string | string[] | undefined>,
  req: { method: string; path: string; query: string; body: string },
  creds: { appKey: string; appSecret: string },
  now = Date.now(),
  seen?: Set<string>,
): string | null {
  const h = (k: string) => String(headers[k.toLowerCase()] ?? "");
  if (h("x-app-key") !== creds.appKey) return "unknown app key";
  const ts = h("x-timestamp");
  const nonce = h("x-nonce");
  if (!/^\d+$/.test(ts) || !nonce) return "missing timestamp or nonce";
  if (Math.abs(now / 1000 - Number(ts)) > 300) return "stale request";
  const expected = Buffer.from(hspRequestSignature({ ...req, timestamp: ts, nonce, appSecret: creds.appSecret }), "hex");
  const given = Buffer.from(h("x-signature"), "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "bad request signature";
  if (seen) {
    if (seen.has(nonce)) return "replayed nonce";
    seen.add(nonce);
    if (seen.size > 10_000) seen.clear();
  }
  return null;
}

// ------------------------------------------------------------------ webhook signatures

/** `X-Signature: t=<unix>,v1=<hex>` with v1 = HMAC-SHA256(appSecret, `${t}.${rawBody}`). */
export function signHspWebhook(secret: string, rawBody: string, ts = Math.floor(Date.now() / 1000)): string {
  return `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${rawBody}`, "utf8").digest("hex")}`;
}

export function parseHspSignatureHeader(header: string): { ts: string; v1: string } | null {
  let ts = "";
  let v1 = "";
  for (const part of header.split(",")) {
    const p = part.trim();
    if (p.startsWith("t=")) ts = p.slice(2);
    else if (p.startsWith("v1=")) v1 = p.slice(3);
  }
  return ts && v1 ? { ts, v1 } : null;
}

// ------------------------------------------------------------------ HS256 (user_authorization)

export function signHs256(payload: Record<string, unknown>, key: Buffer | string): string {
  const input = `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  return `${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

export function verifyHs256(token: string, key: Buffer | string): Record<string, unknown> | null {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  const expected = createHmac("sha256", key).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return jsonPart(p);
}

/**
 * The payer's `user_authorization`: HS256 keyed with the payer address (as HSP's checkout
 * does), committing to both mandates through `transaction_data`.
 */
export function userAuthorization(o: { payer: string; cartContents: unknown; paymentContents: unknown; expiresAt: number }): string {
  const iat = Math.floor(Date.now() / 1000);
  return signHs256(
    {
      aud: HSP_AUDIENCE,
      nonce: `0x${randomBytes(32).toString("hex")}`,
      iat,
      exp: Math.max(o.expiresAt, iat + 60),
      iss: o.payer,
      transaction_data: [hspHash(o.cartContents), hspHash(o.paymentContents)],
    },
    Buffer.from(o.payer),
  );
}

// ------------------------------------------------------------------ ES256K (merchant_authorization)

/** A secp256k1 merchant key from a 0x-hex private key or a PEM. */
export function merchantKey(key: string): KeyObject {
  const k = key.trim().replace(/\\n/g, "\n");
  if (k.includes("BEGIN")) return createPrivateKey(k);
  const d = Buffer.from(k.replace(/^0x/, ""), "hex");
  if (d.length !== 32) throw new Error("merchant key must be a 32-byte hex secp256k1 key or a PEM");
  const ecdh = createECDH("secp256k1");
  ecdh.setPrivateKey(d);
  const pub = ecdh.getPublicKey();
  return createPrivateKey({
    key: { kty: "EC", crv: "secp256k1", d: b64url(d), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
    format: "jwk",
  });
}

/** The public half, as the PEM a merchant registers with HashKey. */
export function merchantPublicPem(key: KeyObject): string {
  return createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
}

export function signEs256k(payload: Record<string, unknown>, key: KeyObject): string {
  const input = `${b64url(JSON.stringify({ alg: "ES256K", typ: "JWT" }))}.${b64url(JSON.stringify(payload))}`;
  return `${input}.${sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

export function verifyEs256k(token: string, key: KeyObject): Record<string, unknown> | null {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  try {
    const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey(key), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    return ok ? jsonPart(p) : null;
  } catch {
    return null;
  }
}

/** merchant_authorization for a cart: commits to sha256(canonical contents) as `cart_hash`. */
export function merchantAuthorization(contents: HspCartContents, merchantName: string, key: KeyObject, ttlSeconds = 3600): string {
  const iat = Math.floor(Date.now() / 1000);
  return signEs256k(
    {
      iss: merchantName,
      sub: merchantName,
      aud: HSP_AUDIENCE,
      iat,
      exp: iat + ttlSeconds,
      jti: `JWT-${iat}-${randomBytes(4).toString("hex")}`,
      cart_hash: hspHash(contents),
    },
    key,
  );
}
