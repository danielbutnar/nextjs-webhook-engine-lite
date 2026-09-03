import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyHmacOptions {
  payload: string;
  signature: string | null;
  secret: string;
  algorithm?: string;
}

/**
 * Validates HMAC SHA-256 signatures against timing side-channel attacks.
 * Normalizes signature prefixes and guards against Node.js RangeError crashes
 * by strictly validating buffer length alignment prior to timingSafeEqual execution.
 */
export function verifyHmacSignature({
  payload,
  signature,
  secret,
  algorithm = "sha256",
}: VerifyHmacOptions): boolean {
  if (!signature || !secret) {
    return false;
  }

  // Normalize standard prefix conventions (e.g., GitHub, Stripe, Shopify: "sha256=...")
  const normalizedSignature = signature.startsWith("sha256=")
    ? signature.slice(7)
    : signature;

  const computedHex = createHmac(algorithm, secret)
    .update(payload, "utf8")
    .digest("hex");

  const bufferA = Buffer.from(normalizedSignature, "utf8");
  const bufferB = Buffer.from(computedHex, "utf8");

  // crypto.timingSafeEqual throws an unhandled RangeError if buffer lengths differ
  if (bufferA.byteLength !== bufferB.byteLength) {
    return false;
  }

  return timingSafeEqual(bufferA, bufferB);
}