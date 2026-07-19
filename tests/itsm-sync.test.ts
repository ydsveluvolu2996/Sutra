import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildOutboundTicket,
  decideInboundTransition,
  mapInboundStatus,
  signOutboundBody,
  verifyInboundSignature,
  type ItsmCaseLike,
} from "../lib/itsm-sync.ts";

const CASE: ItsmCaseLike = {
  caseId: "case-42",
  title: "Internet-reachable workload with critical CVE",
  summary: "api-gateway is reachable and runs CVE-2024-3094.",
  severity: "critical",
  priority: "p1",
  status: "investigating",
};

describe("buildOutboundTicket", () => {
  it("shapes Jira and ServiceNow payloads with explicit status and correlation identity", () => {
    const jira = buildOutboundTicket(CASE, "jira", "SEC");
    assert.equal(jira.externalStatus, "In Progress");
    const fields = jira.payload.fields as { project: { key: string }; summary: string; labels: string[] };
    assert.equal(fields.project.key, "SEC");
    assert.match(fields.summary, /\[Sutra case-42\]/);
    assert.equal(fields.labels.includes("sutra-case-case-42"), true);

    const snow = buildOutboundTicket({ ...CASE, status: "resolved" }, "servicenow", null);
    assert.equal(snow.externalStatus, "Resolved");
    assert.equal((snow.payload as { correlation_id: string }).correlation_id, "sutra-case-case-42");
  });
});

describe("mapInboundStatus", () => {
  it("maps known statuses case-insensitively and refuses to guess unknown ones", () => {
    assert.deepEqual(mapInboundStatus("jira", "Done"), { kind: "mapped", status: "resolved" });
    assert.deepEqual(mapInboundStatus("servicenow", "  NEW "), { kind: "mapped", status: "open" });
    assert.deepEqual(mapInboundStatus("jira", "Blocked-Upstream"), { kind: "unmapped", remoteStatus: "Blocked-Upstream" });
  });
});

describe("decideInboundTransition", () => {
  const base = {
    connectorType: "jira" as const,
    connectorName: "acme-jira",
    currentStatus: "open" as const,
    remoteUpdatedAtMs: 2_000,
    lastLocalChangeMs: 1_000,
  };

  it("applies a newer mapped remote change with a provenance note", () => {
    const decision = decideInboundTransition({ ...base, remoteStatus: "In Progress" });
    assert.equal(decision.kind, "apply");
    if (decision.kind !== "apply") return;
    assert.equal(decision.status, "investigating");
    assert.match(decision.provenanceNote, /acme-jira/);
    assert.match(decision.provenanceNote, /In Progress/);
  });

  it("skips stale remote changes (remote-newer-wins) and no-op changes", () => {
    const stale = decideInboundTransition({ ...base, remoteStatus: "In Progress", remoteUpdatedAtMs: 500 });
    assert.equal(stale.kind, "skip-stale");
    const noChange = decideInboundTransition({ ...base, remoteStatus: "Open" });
    assert.equal(noChange.kind, "skip-no-change");
  });

  it("never applies an unmapped remote status", () => {
    const decision = decideInboundTransition({ ...base, remoteStatus: "Weird-State" });
    assert.deepEqual(decision, { kind: "skip-unmapped", remoteStatus: "Weird-State" });
  });
});

describe("HMAC signatures", () => {
  it("round-trips a signature and rejects tampering, wrong secrets and malformed headers", async () => {
    const body = '{"issue":{"key":"SEC-1"},"status":"Done"}';
    const signature = await signOutboundBody("shared-secret", body);
    assert.equal(await verifyInboundSignature("shared-secret", body, signature), true);
    assert.equal(await verifyInboundSignature("shared-secret", body + " ", signature), false);
    assert.equal(await verifyInboundSignature("other-secret", body, signature), false);
    assert.equal(await verifyInboundSignature("shared-secret", body, null), false);
    assert.equal(await verifyInboundSignature("shared-secret", body, "zz".repeat(32)), false);
    assert.equal(await verifyInboundSignature("shared-secret", body, signature.toUpperCase()), true);
  });
});
