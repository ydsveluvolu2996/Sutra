import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deliverScheduledReport,
  type ReportDeliveryEnv,
  type ScheduledReportEnvelope,
} from "../lib/finops-report-delivery.ts";

const ENVELOPE: ScheduledReportEnvelope = {
  schema: "sutra.finops-scheduled-report.v1",
  scheduleName: "weekly-costs",
  connectionId: `conn_${"a".repeat(32)}`,
  period: "2026-07",
  lineCount: 2,
  currencyTotals: [{ currency: "USD", totalMicros: "14000000" }],
  budgetStates: [{ name: "cap", state: "under", spentMicros: "14000000" }],
  anomalyCount: 0,
  generatedAt: new Date(0).toISOString(),
  disclaimer: "test disclaimer",
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

// A fetch that always throws — proving delivery never propagates the failure.
const throwingFetch = (async () => {
  throw new Error("network down");
}) as unknown as typeof fetch;

describe("deliverScheduledReport — webhook", () => {
  it("POSTs the report envelope to the per-schedule HTTPS target and is delivered on 2xx", async () => {
    const { impl, calls } = spyFetch(200);
    const result = await deliverScheduledReport({
      kind: "webhook",
      target: "https://hooks.example.test/finops",
      envelope: ENVELOPE,
      env: {},
      fetchImpl: impl,
    });
    assert.deepEqual(result, { delivered: true, transport: "webhook" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://hooks.example.test/finops");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { report: ENVELOPE });
  });

  it("reports NOT delivered on a non-2xx response, without throwing", async () => {
    const { impl } = spyFetch(500);
    const result = await deliverScheduledReport({
      kind: "webhook", target: "https://hooks.example.test/finops", envelope: ENVELOPE, env: {}, fetchImpl: impl,
    });
    assert.deepEqual(result, { delivered: false, transport: "webhook" });
  });

  it("never throws when the transport itself fails", async () => {
    const result = await deliverScheduledReport({
      kind: "webhook", target: "https://hooks.example.test/finops", envelope: ENVELOPE, env: {}, fetchImpl: throwingFetch,
    });
    assert.deepEqual(result, { delivered: false, transport: "webhook" });
  });

  it("a non-HTTPS target is an honest non-delivery ('none'), never a fabricated send", async () => {
    const { impl, calls } = spyFetch(200);
    const result = await deliverScheduledReport({
      kind: "webhook", target: "http://hooks.example.test/finops", envelope: ENVELOPE, env: {}, fetchImpl: impl,
    });
    assert.deepEqual(result, { delivered: false, transport: "none" });
    assert.equal(calls.length, 0);
  });
});

describe("deliverScheduledReport — email (reuses the contact transactional transport)", () => {
  const env: ReportDeliveryEnv = {
    SUTRA_CONTACT_EMAIL_API_URL: "https://api.resend.com/emails",
    SUTRA_CONTACT_EMAIL_API_KEY: "re_test_key",
    SUTRA_CONTACT_FROM: "Sutra Reports <reports@sutra.dev>",
  };

  it("sends through the configured email API with a Bearer header and Resend body shape", async () => {
    const { impl, calls } = spyFetch(202);
    const result = await deliverScheduledReport({
      kind: "email", target: "ops@example.test", envelope: ENVELOPE, env, fetchImpl: impl,
    });
    assert.deepEqual(result, { delivered: true, transport: "email-api" });
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, "Bearer re_test_key");
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    assert.equal(body.from, "Sutra Reports <reports@sutra.dev>");
    assert.deepEqual(body.to, ["ops@example.test"]);
    assert.match(String(body.subject), /Sutra cost report/u);
  });

  it("is 'none' when no email transport is configured — never a fabricated send", async () => {
    const { impl, calls } = spyFetch(202);
    const result = await deliverScheduledReport({
      kind: "email", target: "ops@example.test", envelope: ENVELOPE, env: {}, fetchImpl: impl,
    });
    assert.deepEqual(result, { delivered: false, transport: "none" });
    assert.equal(calls.length, 0);
  });

  it("rejects an invalid recipient as 'none' rather than attempting a send", async () => {
    const { impl, calls } = spyFetch(202);
    const result = await deliverScheduledReport({
      kind: "email", target: "not-an-email", envelope: ENVELOPE, env, fetchImpl: impl,
    });
    assert.deepEqual(result, { delivered: false, transport: "none" });
    assert.equal(calls.length, 0);
  });

  it("sends scheduled reports through the regional Zoho Mail API", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await deliverScheduledReport({
      kind: "email",
      target: "finance@example.test",
      envelope: ENVELOPE,
      env: {
        SUTRA_CONTACT_PROVIDER: "zoho",
        SUTRA_CONTACT_FROM: "Sutra Reports <billing@sutracmdb.com>",
        SUTRA_ZOHO_DATACENTER: "in",
        SUTRA_ZOHO_MAIL_ACCOUNT_ID: "60080685470",
        SUTRA_ZOHO_CLIENT_ID: "1000.SUTRA_TEST_CLIENT",
        SUTRA_ZOHO_CLIENT_SECRET: "test-client-secret-not-real",
        SUTRA_ZOHO_REFRESH_TOKEN: `1000.${"r".repeat(48)}`,
      },
      fetchImpl: (async (url: string | URL, init: RequestInit = {}) => {
        calls.push({ url: String(url), init });
        return calls.length === 1
          ? Response.json({ access_token: `1000.${"a".repeat(48)}` })
          : Response.json({ status: { code: 200 } });
      }) as typeof fetch,
    });
    assert.deepEqual(result, { delivered: true, transport: "email-api" });
    const body = JSON.parse(String(calls[1]?.init.body));
    assert.equal(body.fromAddress, "billing@sutracmdb.com");
    assert.equal(body.toAddress, "finance@example.test");
    assert.match(body.subject, /Sutra cost report/u);
  });
});
