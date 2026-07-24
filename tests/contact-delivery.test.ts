import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_CONTACT_FROM,
  buildProviderRequest,
  deliverContactSubmission,
  detectEmailProvider,
  resolveContactFrom,
  type ContactDeliveryEnv,
  type ContactDeliveryPayload,
} from "../lib/contact-delivery.ts";

const RECIPIENT = "team@sutra.example";
const PAYLOAD: ContactDeliveryPayload = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  company: "Analytical Engines",
  message: "We run 3 AWS accounts and an EKS cluster.",
  sourceIp: "203.0.113.7",
  submittedAt: new Date(0).toISOString(),
};

// A fetch spy that records the single call and returns a chosen status.
function spyFetch(status = 202) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("", { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("buildProviderRequest — Resend", () => {
  const env: ContactDeliveryEnv = {
    SUTRA_CONTACT_EMAIL_API_URL: "https://api.resend.com/emails",
    SUTRA_CONTACT_EMAIL_API_KEY: "re_test_key",
    SUTRA_CONTACT_FROM: "Sutra Leads <leads@sutra.dev>",
  };

  it("targets the configured URL with a Bearer header", () => {
    const req = buildProviderRequest(env, RECIPIENT, PAYLOAD);
    assert.ok(req);
    assert.equal(req.url, "https://api.resend.com/emails");
    assert.equal(req.transport, "email-api");
    assert.equal(req.headers.authorization, "Bearer re_test_key");
  });

  it("builds the Resend body: from, to[], reply_to, subject, text", () => {
    const req = buildProviderRequest(env, RECIPIENT, PAYLOAD);
    const body = req!.body as Record<string, unknown>;
    assert.equal(body.from, "Sutra Leads <leads@sutra.dev>");
    assert.deepEqual(body.to, [RECIPIENT]);
    assert.equal(body.reply_to, "ada@example.com");
    assert.equal(body.subject, "New Sutra contact — Ada Lovelace (Analytical Engines)");
    assert.match(String(body.text), /Name: Ada Lovelace/u);
    assert.match(String(body.text), /Email: ada@example\.com/u);
    assert.match(String(body.text), /Source IP: 203\.0\.113\.7/u);
  });

  it("detects Resend from the URL host without an explicit provider", () => {
    assert.equal(detectEmailProvider(env, "https://api.resend.com/emails"), "resend");
  });

  it("honors an explicit SUTRA_CONTACT_PROVIDER override", () => {
    const overridden: ContactDeliveryEnv = {
      ...env,
      SUTRA_CONTACT_EMAIL_API_URL: "https://mail.internal.example/send",
      SUTRA_CONTACT_PROVIDER: "resend",
    };
    const body = buildProviderRequest(overridden, RECIPIENT, PAYLOAD)!.body as Record<string, unknown>;
    assert.deepEqual(body.to, [RECIPIENT]);
    assert.equal(body.from, "Sutra Leads <leads@sutra.dev>");
  });
});

describe("buildProviderRequest — SendGrid", () => {
  const env: ContactDeliveryEnv = {
    SUTRA_CONTACT_EMAIL_API_URL: "https://api.sendgrid.com/v3/mail/send",
    SUTRA_CONTACT_EMAIL_API_KEY: "SG.test_key",
    SUTRA_CONTACT_FROM: "Sutra Leads <leads@sutra.dev>",
  };

  it("builds personalizations / from / reply_to / content shape", () => {
    const req = buildProviderRequest(env, RECIPIENT, PAYLOAD);
    assert.ok(req);
    assert.equal(req.headers.authorization, "Bearer SG.test_key");
    const body = req.body as Record<string, unknown>;
    assert.deepEqual(body.personalizations, [{ to: [{ email: RECIPIENT }] }]);
    // from must be the parsed bare address, not the display form.
    assert.deepEqual(body.from, { email: "leads@sutra.dev" });
    assert.deepEqual(body.reply_to, { email: "ada@example.com" });
    assert.equal(body.subject, "New Sutra contact — Ada Lovelace (Analytical Engines)");
    assert.deepEqual(body.content, [
      { type: "text/plain", value: (req.body as { content: { value: string }[] }).content[0].value },
    ]);
    assert.match((body.content as { value: string }[])[0].value, /Message:/u);
  });
});

describe("buildProviderRequest — webhook + generic + none", () => {
  it("webhook passthrough posts the { recipient, submission } envelope unchanged with no auth", () => {
    const req = buildProviderRequest({ SUTRA_CONTACT_WEBHOOK_URL: "https://hook.example/contact" }, RECIPIENT, PAYLOAD);
    assert.ok(req);
    assert.equal(req.transport, "webhook");
    assert.deepEqual(req.headers, {});
    assert.deepEqual(req.body, { recipient: RECIPIENT, submission: PAYLOAD });
  });

  it("webhook wins even when an email API is also configured", () => {
    const req = buildProviderRequest(
      {
        SUTRA_CONTACT_WEBHOOK_URL: "https://hook.example/contact",
        SUTRA_CONTACT_EMAIL_API_URL: "https://api.resend.com/emails",
        SUTRA_CONTACT_EMAIL_API_KEY: "re_key",
      },
      RECIPIENT,
      PAYLOAD,
    );
    assert.equal(req!.transport, "webhook");
  });

  it("an unrecognized email host falls back to the generic envelope with Bearer auth", () => {
    const req = buildProviderRequest(
      { SUTRA_CONTACT_EMAIL_API_URL: "https://mail.internal.example/send", SUTRA_CONTACT_EMAIL_API_KEY: "k" },
      RECIPIENT,
      PAYLOAD,
    );
    assert.ok(req);
    assert.equal(req.transport, "email-api");
    assert.equal(req.headers.authorization, "Bearer k");
    assert.deepEqual(req.body, { recipient: RECIPIENT, submission: PAYLOAD });
  });

  it("returns null when nothing is configured, a non-https webhook, or a key-less email API", () => {
    assert.equal(buildProviderRequest({}, RECIPIENT, PAYLOAD), null);
    assert.equal(buildProviderRequest({ SUTRA_CONTACT_WEBHOOK_URL: "http://hook.example/x" }, RECIPIENT, PAYLOAD), null);
    assert.equal(
      buildProviderRequest({ SUTRA_CONTACT_EMAIL_API_URL: "https://api.resend.com/emails" }, RECIPIENT, PAYLOAD),
      null,
    );
  });

  it("rejects SSRF-shaped webhook and email endpoints before any egress", () => {
    const blocked = [
      "https://127.0.0.1/contact",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.1/contact",
      "https://[::1]/contact",
      "https://metadata.google.internal/contact",
      "https://user:password@hook.example/contact",
    ];
    for (const endpoint of blocked) {
      assert.equal(
        buildProviderRequest({ SUTRA_CONTACT_WEBHOOK_URL: endpoint }, RECIPIENT, PAYLOAD),
        null,
        `expected webhook endpoint to be blocked: ${endpoint}`,
      );
      assert.equal(
        buildProviderRequest({
          SUTRA_CONTACT_EMAIL_API_URL: endpoint,
          SUTRA_CONTACT_EMAIL_API_KEY: "secret",
        }, RECIPIENT, PAYLOAD),
        null,
        `expected email endpoint to be blocked: ${endpoint}`,
      );
    }
  });
});

describe("resolveContactFrom", () => {
  it("defaults when unset and parses display/bare forms", () => {
    assert.deepEqual(resolveContactFrom({}), { display: DEFAULT_CONTACT_FROM, email: "onboarding@resend.dev" });
    assert.deepEqual(resolveContactFrom({ SUTRA_CONTACT_FROM: "leads@sutra.dev" }), {
      display: "leads@sutra.dev",
      email: "leads@sutra.dev",
    });
  });

  it("falls back to default when the sender has no valid email", () => {
    assert.deepEqual(resolveContactFrom({ SUTRA_CONTACT_FROM: "not-an-email" }), {
      display: DEFAULT_CONTACT_FROM,
      email: "onboarding@resend.dev",
    });
  });
});

describe("header safety — CRLF and oversized inputs", () => {
  const env: ContactDeliveryEnv = {
    SUTRA_CONTACT_EMAIL_API_URL: "https://api.resend.com/emails",
    SUTRA_CONTACT_EMAIL_API_KEY: "re_key",
  };

  it("strips CR/LF injected via name/company from the subject header", () => {
    const evil: ContactDeliveryPayload = {
      ...PAYLOAD,
      name: "Ada\r\nBcc: victim@evil.example",
      company: "ACME\nX-Injected: 1",
    };
    const subject = (buildProviderRequest(env, RECIPIENT, evil)!.body as { subject: string }).subject;
    assert.doesNotMatch(subject, /[\r\n]/u);
  });

  it("caps an oversized name so the subject stays bounded", () => {
    const huge: ContactDeliveryPayload = { ...PAYLOAD, name: "x".repeat(500) };
    const subject = (buildProviderRequest(env, RECIPIENT, huge)!.body as { subject: string }).subject;
    assert.ok(subject.length <= 200, `subject length ${subject.length} should be <= 200`);
  });

  it("drops a CR/LF-bearing SUTRA_CONTACT_FROM to the safe default", () => {
    const from = resolveContactFrom({ SUTRA_CONTACT_FROM: "Evil <e@x.dev>\r\nBcc: v@x" });
    assert.equal(from.display, DEFAULT_CONTACT_FROM);
  });
});

describe("deliverContactSubmission — honest, never-throwing", () => {
  it("no transport => delivered:false, transport:none (no fetch)", async () => {
    const result = await deliverContactSubmission(RECIPIENT, PAYLOAD, {});
    assert.deepEqual(result, { delivered: false, transport: "none" });
  });

  it("2xx from a provider => delivered:true and posts JSON with the auth header", async () => {
    const { impl, calls } = spyFetch(202);
    const env: ContactDeliveryEnv = {
      SUTRA_CONTACT_EMAIL_API_URL: "https://api.resend.com/emails",
      SUTRA_CONTACT_EMAIL_API_KEY: "re_key",
    };
    const result = await deliverContactSubmission(RECIPIENT, PAYLOAD, env, impl);
    assert.deepEqual(result, { delivered: true, transport: "email-api" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer re_key");
    assert.match(headers["content-type"], /application\/json/u);
    assert.equal(calls[0].init.redirect, "error");
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    const sent = JSON.parse(String(calls[0].init.body));
    assert.deepEqual(sent.to, [RECIPIENT]);
  });

  it("non-2xx => delivered:false but keeps the transport", async () => {
    const { impl } = spyFetch(500);
    const result = await deliverContactSubmission(
      RECIPIENT,
      PAYLOAD,
      { SUTRA_CONTACT_WEBHOOK_URL: "https://hook.example/contact" },
      impl,
    );
    assert.deepEqual(result, { delivered: false, transport: "webhook" });
  });

  it("a fetch that throws never propagates — delivered:false", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await deliverContactSubmission(
      RECIPIENT,
      PAYLOAD,
      { SUTRA_CONTACT_WEBHOOK_URL: "https://hook.example/contact" },
      throwing,
    );
    assert.deepEqual(result, { delivered: false, transport: "webhook" });
  });
});
