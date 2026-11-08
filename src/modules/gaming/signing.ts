import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function signRequest(
  secretHex: string,
  timestamp: string,
  nonce: string,
  method: string,
  path: string,
  body: Uint8Array | string,
) {
  const digest = createHash("sha256").update(body).digest("hex");
  const canonical = [
    timestamp,
    nonce,
    method.toUpperCase(),
    path.split("?")[0],
    digest,
  ].join("\n");
  return createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update(canonical)
    .digest("hex");
}

export function verifyPostback(
  secret: string,
  headers: Record<string, unknown>,
  path: string,
  raw: Buffer,
  now = Date.now(),
) {
  const ts = headers["x-timestamp"];
  const nonce = headers["x-nonce"];
  const signature = headers["x-sign"];
  if (
    !/^[a-fA-F0-9]{64}$/.test(secret) ||
    typeof ts !== "string" ||
    !/^\d{10,11}$/.test(ts) ||
    Math.abs(now / 1000 - Number(ts)) > 300 ||
    typeof nonce !== "string" ||
    !nonce.length ||
    nonce.length > 128 ||
    typeof signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(signature)
  )
    return null;
  const expected = signRequest(secret, ts, nonce, "POST", path, raw);
  if (
    !timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex"),
    )
  )
    return null;
  return createHash("sha256").update(nonce).digest("hex");
}
