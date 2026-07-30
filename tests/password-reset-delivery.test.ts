import assert from "node:assert/strict";
import test from "node:test";

import { deliverPasswordResetEmail } from "../lib/password-reset-delivery.ts";

test("password resets are delivered through Zoho without exposing credentials", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const result = await deliverPasswordResetEmail({
    recipient: "owner@example.test",
    resetUrl: "https://www.sutracmdb.com/reset-password?token=single-use-value",
    expiresAt: "2026-07-30T12:00:00.000Z",
  }, {
    SUTRA_PUBLIC_ORIGIN: "https://www.sutracmdb.com",
    SUTRA_INVITATION_FROM: "Sutra Support <support@sutracmdb.com>",
    SUTRA_INVITATION_EMAIL_PROVIDER: "zoho",
    SUTRA_ZOHO_DATACENTER: "in",
    SUTRA_ZOHO_MAIL_ACCOUNT_ID: "60080685470",
    SUTRA_ZOHO_CLIENT_ID: "1000.SUTRA_TEST_CLIENT",
    SUTRA_ZOHO_CLIENT_SECRET: "test-client-secret-not-real",
    SUTRA_ZOHO_REFRESH_TOKEN: `1000.${"r".repeat(48)}`,
  }, (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return calls.length === 1
      ? Response.json({ access_token: `1000.${"a".repeat(48)}` })
      : Response.json({ status: { code: 200 } });
  }) as typeof fetch);

  assert.deepEqual(result, {
    status: "accepted",
    transport: "email-api",
    provider: "zoho",
    errorCode: null,
    httpStatus: 200,
  });
  const body = JSON.parse(String(calls[1]?.init.body));
  assert.equal(body.fromAddress, "support@sutracmdb.com");
  assert.equal(body.toAddress, "owner@example.test");
  assert.match(body.content, /single-use-value/u);
  assert.doesNotMatch(JSON.stringify(result), /test-client-secret|1000\.rrrr/u);
});

test("password-reset delivery rejects a link on a foreign origin before egress", async () => {
  let calls = 0;
  const result = await deliverPasswordResetEmail({
    recipient: "owner@example.test",
    resetUrl: "https://attacker.example/reset-password?token=single-use-value",
    expiresAt: "2026-07-30T12:00:00.000Z",
  }, {
    SUTRA_PUBLIC_ORIGIN: "https://www.sutracmdb.com",
    SUTRA_INVITATION_FROM: "Sutra Support <support@sutracmdb.com>",
    SUTRA_INVITATION_EMAIL_PROVIDER: "zoho",
    SUTRA_ZOHO_DATACENTER: "in",
    SUTRA_ZOHO_MAIL_ACCOUNT_ID: "60080685470",
    SUTRA_ZOHO_CLIENT_ID: "1000.SUTRA_TEST_CLIENT",
    SUTRA_ZOHO_CLIENT_SECRET: "test-client-secret-not-real",
    SUTRA_ZOHO_REFRESH_TOKEN: `1000.${"r".repeat(48)}`,
  }, (async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  }) as typeof fetch);

  assert.equal(calls, 0);
  assert.equal(result.errorCode, "EMAIL_CONFIGURATION_INVALID");
});
