import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildInvitationProviderRequest,
  deliverInvitationEmail,
  type InvitationDeliveryEnv,
} from "../lib/invitation-delivery.ts";

const input = {
  recipient: "client@example.com",
  activationUrl: "https://www.sutracmdb.com/accept-invite?token=secret-token-value",
  expiresAt: "2026-07-24T12:00:00.000Z",
  role: "customer_admin",
} as const;

const resendEnv: InvitationDeliveryEnv = {
  SUTRA_INVITATION_FROM: "Sutra Access <access@sutracmdb.com>",
  SUTRA_INVITATION_EMAIL_PROVIDER: "resend",
  SUTRA_INVITATION_EMAIL_API_URL: "https://api.resend.com/emails",
  SUTRA_INVITATION_EMAIL_API_KEY: "test-api-key-not-a-real-secret",
  SUTRA_PUBLIC_ORIGIN: "https://www.sutracmdb.com",
};

describe("invitation email delivery", () => {
  it("does not claim delivery or call fetch when email is not configured", async () => {
    let calls = 0;
    const result = await deliverInvitationEmail(input, {}, async () => {
      calls += 1;
      return new Response(null, { status: 202 });
    });
    assert.equal(calls, 0);
    assert.deepEqual(result, {
      status: "failed",
      transport: "none",
      provider: "none",
      errorCode: "EMAIL_NOT_CONFIGURED",
      httpStatus: null,
    });
  });

  it("builds a Resend request and reports provider acceptance, not inbox delivery", async () => {
    let captured: RequestInit | undefined;
    const result = await deliverInvitationEmail(input, resendEnv, async (url, init) => {
      assert.equal(url.toString(), "https://api.resend.com/emails");
      captured = init;
      return new Response("{\"id\":\"provider-message\"}", { status: 202 });
    });
    assert.equal(result.status, "accepted");
    assert.equal(result.provider, "resend");
    assert.equal(result.httpStatus, 202);
    assert.equal(captured?.redirect, "manual");
    assert.equal((captured?.headers as Record<string, string>).authorization, "Bearer test-api-key-not-a-real-secret");
    const body = JSON.parse(String(captured?.body));
    assert.deepEqual(body.to, ["client@example.com"]);
    assert.match(body.text, /secret-token-value/u);
    assert.doesNotMatch(JSON.stringify(result), /secret-token-value|test-api-key/u);
  });

  it("classifies provider rejection without retaining the provider body", async () => {
    const result = await deliverInvitationEmail(input, resendEnv, async () =>
      new Response("API key abc-secret-value rejected", { status: 401 }));
    assert.deepEqual(result, {
      status: "failed",
      transport: "email-api",
      provider: "resend",
      errorCode: "PROVIDER_AUTHENTICATION_FAILED",
      httpStatus: 401,
    });
    assert.doesNotMatch(JSON.stringify(result), /abc-secret-value/u);
  });

  it("marks a network exception unknown because provider acceptance is ambiguous", async () => {
    const result = await deliverInvitationEmail(input, resendEnv, async () => {
      throw new Error("socket closed after write");
    });
    assert.deepEqual(result, {
      status: "unknown",
      transport: "email-api",
      provider: "resend",
      errorCode: "PROVIDER_RESULT_UNKNOWN",
      httpStatus: null,
    });
  });

  it("blocks metadata/private email endpoints before egress", async () => {
    let called = false;
    const result = await deliverInvitationEmail(input, {
      ...resendEnv,
      SUTRA_INVITATION_EMAIL_API_URL: "https://169.254.169.254/latest/meta-data/",
    }, async () => {
      called = true;
      return new Response(null, { status: 202 });
    });
    assert.equal(called, false);
    assert.equal(result.status, "failed");
    assert.equal(result.errorCode, "EMAIL_CONFIGURATION_INVALID");
  });

  it("uses the SendGrid payload shape and refuses an HTTP activation URL", () => {
    const request = buildInvitationProviderRequest(input, {
      ...resendEnv,
      SUTRA_INVITATION_EMAIL_PROVIDER: "sendgrid",
      SUTRA_INVITATION_EMAIL_API_URL: "https://api.sendgrid.com/v3/mail/send",
    });
    assert.ok(request);
    assert.equal(request.provider, "sendgrid");
    assert.deepEqual((request.body as { personalizations: unknown }).personalizations, [
      { to: [{ email: "client@example.com" }] },
    ]);
    assert.equal(buildInvitationProviderRequest({ ...input, activationUrl: "http://localhost:3000/accept-invite" }, resendEnv), null);
    assert.equal(buildInvitationProviderRequest({
      ...input,
      activationUrl: "https://attacker.example/accept-invite?token=secret-token-value",
    }, resendEnv), null);
  });

  it("delivers invitations through the regional Zoho Mail API", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await deliverInvitationEmail(input, {
      SUTRA_PUBLIC_ORIGIN: "https://www.sutracmdb.com",
      SUTRA_INVITATION_FROM: "Sutra Support <support@sutracmdb.com>",
      SUTRA_INVITATION_EMAIL_PROVIDER: "zoho",
      SUTRA_ZOHO_DATACENTER: "in",
      SUTRA_ZOHO_MAIL_ACCOUNT_ID: "60080685470",
      SUTRA_ZOHO_CLIENT_ID: "1000.SUTRA_TEST_CLIENT",
      SUTRA_ZOHO_CLIENT_SECRET: "test-client-secret-not-real",
      SUTRA_ZOHO_REFRESH_TOKEN: `1000.${"r".repeat(48)}`,
    }, async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return calls.length === 1
        ? Response.json({ access_token: `1000.${"a".repeat(48)}` })
        : Response.json({ status: { code: 200 } });
    });
    assert.deepEqual(result, {
      status: "accepted",
      transport: "email-api",
      provider: "zoho",
      errorCode: null,
      httpStatus: 200,
    });
    const body = JSON.parse(String(calls[1]?.init.body));
    assert.equal(body.fromAddress, "support@sutracmdb.com");
    assert.equal(body.toAddress, input.recipient);
    assert.match(body.content, /secret-token-value/u);
  });
});
