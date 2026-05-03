import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyLinearSignature } from "./verify.ts";

const secret = "shh";
const sign = (body: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

test("verifyLinearSignature accepts a correctly signed body", () => {
  const body = JSON.stringify({ hello: "world" });
  assert.equal(verifyLinearSignature(body, sign(body), secret), true);
});

test("verifyLinearSignature rejects a tampered body", () => {
  const body = JSON.stringify({ hello: "world" });
  const tampered = body.replace("world", "WORLD");
  assert.equal(verifyLinearSignature(tampered, sign(body), secret), false);
});

test("verifyLinearSignature rejects a missing signature", () => {
  assert.equal(verifyLinearSignature("body", undefined, secret), false);
});

test("verifyLinearSignature rejects when the secret is empty", () => {
  assert.equal(verifyLinearSignature("body", sign("body"), ""), false);
});

test("verifyLinearSignature is case-insensitive on the hex signature", () => {
  const body = "x";
  const sig = sign(body).toUpperCase();
  assert.equal(verifyLinearSignature(body, sig, secret), true);
});
