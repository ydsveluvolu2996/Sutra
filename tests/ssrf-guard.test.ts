import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertSafeOutboundUrl, isSafeOutboundUrl, SsrfBlockedError } from "../lib/ssrf-guard.ts";
import { deliverItsmTicket, type ItsmDeliveryConnector } from "../lib/itsm-delivery.ts";
import type { ItsmCaseLike } from "../lib/itsm-sync.ts";

describe("assertSafeOutboundUrl", () => {
  it("allows a public HTTPS endpoint and returns the parsed URL", () => {
    const url = assertSafeOutboundUrl("https://hooks.example.com/webhook");
    assert.equal(url.hostname, "hooks.example.com");
    assert.equal(isSafeOutboundUrl("https://hooks.example.com/webhook"), true);
  });

  it("rejects the cloud metadata address, loopback, private, and link-local IP literals", () => {
    const blocked = [
      "https://169.254.169.254/latest/meta-data/",       // AWS/GCP metadata
      "https://169.254.170.2/v2/credentials",             // link-local
      "https://127.0.0.1/",                               // loopback
      "https://127.53.1.9/",                              // 127/8 loopback
      "https://10.0.0.5/",                                // 10/8 private
      "https://172.16.9.9/",                              // 172.16/12 private
      "https://172.31.255.1/",                            // 172.16/12 upper edge
      "https://192.168.1.1/",                             // 192.168/16 private
      "https://0.0.0.0/",                                 // unspecified
      "https://[::1]/",                                   // IPv6 loopback
      "https://[fe80::1]/",                               // IPv6 link-local
      "https://[fc00::1]/",                               // IPv6 unique-local
      "https://[::ffff:169.254.169.254]/",                // IPv4-mapped metadata
    ];
    for (const raw of blocked) {
      assert.throws(() => assertSafeOutboundUrl(raw), SsrfBlockedError, `expected block: ${raw}`);
      assert.equal(isSafeOutboundUrl(raw), false, `expected block: ${raw}`);
    }
  });

  it("rejects internal hostnames, non-https schemes, credentials, and CR/LF", () => {
    const blocked = [
      "https://localhost/",
      "https://api.localhost/",
      "https://db.local/",
      "https://foo.internal/",
      "https://metadata.google.internal/computeMetadata/v1/",
      "http://hooks.example.com/webhook",                 // not https
      "https://user:pass@hooks.example.com/",             // embedded credentials
      "https://hooks.example.com/\r\nHost: evil",         // CR/LF injection
      "ftp://hooks.example.com/",                          // wrong scheme
      "not a url",
    ];
    for (const raw of blocked) {
      assert.throws(() => assertSafeOutboundUrl(raw), SsrfBlockedError, `expected block: ${raw}`);
    }
  });

  it("172.15/172.32 (outside 172.16/12) and other public ranges are allowed", () => {
    assert.equal(isSafeOutboundUrl("https://172.15.0.1/"), true);
    assert.equal(isSafeOutboundUrl("https://172.32.0.1/"), true);
    assert.equal(isSafeOutboundUrl("https://8.8.8.8/"), true);
  });
});

describe("itsm delivery refuses an SSRF target before egress", () => {
  const CASE: ItsmCaseLike = {
    caseId: "case-1", title: "t", summary: "s", severity: "high", priority: "p2", status: "investigating",
  };

  it("blocks the metadata endpoint without ever calling fetch", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const connector: ItsmDeliveryConnector = {
      baseUrl: "https://169.254.169.254/latest/meta-data/",
      sharedSecret: "shared-secret-value-1234567890",
      connectorType: "jira",
      projectKey: null,
    };
    const result = await deliverItsmTicket({ connector, itsmCase: CASE, fetchImpl });
    assert.equal(called, false);
    assert.equal(result.delivered, false);
    assert.equal(result.error, "SsrfBlockedError");
  });
});
