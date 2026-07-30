import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveZohoMailConfiguration,
  sendZohoMail,
  type ZohoMailEnvironment,
} from "../lib/zoho-mail.ts";

const ENV: ZohoMailEnvironment = {
  SUTRA_ZOHO_DATACENTER: "in",
  SUTRA_ZOHO_MAIL_ACCOUNT_ID: "60080685470",
  SUTRA_ZOHO_CLIENT_ID: "1000.SUTRA_TEST_CLIENT",
  SUTRA_ZOHO_CLIENT_SECRET: "test-client-secret-not-real",
  SUTRA_ZOHO_REFRESH_TOKEN: `1000.${"r".repeat(48)}`,
};

const MESSAGE = {
  fromAddress: "contact@sutracmdb.com",
  toAddress: "prospect@example.com",
  subject: "Sutra contact",
  content: "A test message.",
} as const;

describe("Zoho Mail REST delivery", () => {
  it("pins the India data-center endpoints and keeps credentials out of URLs", () => {
    const configuration = resolveZohoMailConfiguration(ENV);
    assert.ok(configuration);
    assert.equal(configuration.tokenEndpoint, "https://accounts.zoho.in/oauth/v2/token");
    assert.equal(configuration.sendEndpoint, "https://mail.zoho.in/api/accounts/60080685470/messages");
    assert.doesNotMatch(configuration.tokenEndpoint, /SUTRA_TEST|secret|rrrr/u);
    assert.doesNotMatch(configuration.sendEndpoint, /SUTRA_TEST|secret|rrrr/u);
  });

  it("refreshes an access token and sends the provider-correct message shape", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await sendZohoMail(ENV, MESSAGE, async (input, init = {}) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        return Response.json({ access_token: `1000.${"a".repeat(48)}`, expires_in: 3600 });
      }
      return Response.json({ status: { code: 200 } }, { status: 200 });
    });

    assert.deepEqual(result, { status: "accepted", errorCode: null, httpStatus: 200 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.url, "https://accounts.zoho.in/oauth/v2/token");
    assert.equal(calls[0]?.init.redirect, "manual");
    const tokenBody = new URLSearchParams(String(calls[0]?.init.body));
    assert.equal(tokenBody.get("grant_type"), "refresh_token");
    assert.equal(tokenBody.get("client_id"), ENV.SUTRA_ZOHO_CLIENT_ID);
    assert.equal(tokenBody.get("client_secret"), ENV.SUTRA_ZOHO_CLIENT_SECRET);
    assert.equal(tokenBody.get("refresh_token"), ENV.SUTRA_ZOHO_REFRESH_TOKEN);

    assert.equal(calls[1]?.url, "https://mail.zoho.in/api/accounts/60080685470/messages");
    assert.equal(calls[1]?.init.redirect, "manual");
    const headers = calls[1]?.init.headers as Record<string, string>;
    assert.match(headers.authorization, /^Zoho-oauthtoken 1000\./u);
    const body = JSON.parse(String(calls[1]?.init.body));
    assert.deepEqual(body, {
      fromAddress: MESSAGE.fromAddress,
      toAddress: MESSAGE.toAddress,
      subject: MESSAGE.subject,
      content: MESSAGE.content,
      mailFormat: "plaintext",
    });
    assert.doesNotMatch(JSON.stringify(result), /client-secret|1000\.r/u);
  });

  it("fails closed before egress on incomplete configuration or unsafe message headers", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return Response.json({});
    }) as typeof fetch;
    assert.deepEqual(await sendZohoMail({}, MESSAGE, fetcher), {
      status: "failed",
      errorCode: "EMAIL_NOT_CONFIGURED",
      httpStatus: null,
    });
    assert.deepEqual(await sendZohoMail(ENV, { ...MESSAGE, subject: "hello\r\nBcc: attacker@example.com" }, fetcher), {
      status: "failed",
      errorCode: "EMAIL_CONFIGURATION_INVALID",
      httpStatus: null,
    });
    assert.equal(calls, 0);
  });

  it("classifies token rejection without attempting a mail send", async () => {
    let calls = 0;
    const result = await sendZohoMail(ENV, MESSAGE, async () => {
      calls += 1;
      return new Response("denied", { status: 401 });
    });
    assert.deepEqual(result, {
      status: "failed",
      errorCode: "PROVIDER_AUTHENTICATION_FAILED",
      httpStatus: 401,
    });
    assert.equal(calls, 1);
  });
});
