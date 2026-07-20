import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deliverItsmTicket, type ItsmDeliveryConnector } from "../lib/itsm-delivery.ts";
import type { ItsmCaseLike } from "../lib/itsm-sync.ts";

const CONNECTOR: ItsmDeliveryConnector = {
  baseUrl: "https://itsm.example.com/api/tickets",
  sharedSecret: "shared-secret-value-1234567890",
  connectorType: "jira",
  projectKey: "SEC",
};

const CASE: ItsmCaseLike = {
  caseId: "case-42",
  title: "Internet-reachable workload with critical CVE",
  summary: "api-gateway is reachable and runs CVE-2024-3094.",
  severity: "critical",
  priority: "p1",
  status: "investigating",
};

describe("deliverItsmTicket", () => {
  it("delivers on an ok response and signs the outbound body", async () => {
    let capturedInit: RequestInit | undefined;
    let capturedUrl: string | undefined;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response("{}", { status: 201 });
    }) as unknown as typeof fetch;

    const result = await deliverItsmTicket({ connector: CONNECTOR, itsmCase: CASE, fetchImpl });

    assert.equal(result.delivered, true);
    assert.equal(result.statusCode, 201);
    assert.equal(capturedUrl, CONNECTOR.baseUrl);
    const headers = new Headers(capturedInit?.headers);
    assert.match(headers.get("x-sutra-signature") ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(headers.get("content-type"), "application/json");
  });

  it("reports delivered:false with the statusCode on a non-ok response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const result = await deliverItsmTicket({ connector: CONNECTOR, itsmCase: CASE, fetchImpl });
    assert.equal(result.delivered, false);
    assert.equal(result.statusCode, 500);
    assert.equal(result.error, undefined);
  });

  it("reports delivered:false with the error name when fetch throws", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    const result = await deliverItsmTicket({ connector: CONNECTOR, itsmCase: CASE, fetchImpl });
    assert.equal(result.delivered, false);
    assert.equal(result.error, "TimeoutError");
    assert.equal(result.statusCode, undefined);
  });

  it("caps payloadPreview at 500 characters", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const longCase: ItsmCaseLike = { ...CASE, summary: "x".repeat(5_000) };
    const result = await deliverItsmTicket({ connector: CONNECTOR, itsmCase: longCase, fetchImpl });
    assert.equal(result.delivered, true);
    assert.equal(result.payloadPreview.length, 500);
  });
});
