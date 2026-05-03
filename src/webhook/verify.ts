import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Linear signs webhook bodies as HMAC-SHA256 over the raw request bytes,
 * delivered in the `Linear-Signature` header (lowercase hex).
 * https://linear.app/developers/webhooks
 */
export function verifyLinearSignature(
  rawBody: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const got = signature.trim().toLowerCase();
  if (expected.length !== got.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(got, "hex"));
  } catch {
    return false;
  }
}
