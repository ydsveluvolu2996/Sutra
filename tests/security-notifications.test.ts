import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSecurityNotificationPayloads,
  normalizeSecurityNotificationEvent,
  SecurityNotificationError,
} from "../lib/security-notifications.ts";

const eventInput = {
  eventId: `notify_${"a".repeat(48)}`,
  orgId: "org_sutra",
  customerId: "cust_customer",
  clusterId: "738663485493:ap-south-1:customer-cluster",
  severity: "critical",
  title: "Internet-exposed privileged workload",
  summary: "A privileged workload is reachable through a public service and uses an over-privileged identity.",
  occurredAt: "2026-07-17T08:30:00.000Z",
  findingCount: 4,
  reportUrl: "https://app.sutracmdb.com/kubernetes/attack-paths?finding=example",
  evidenceSha256: "b".repeat(64),
} as const;

test("builds deterministic email, Slack, and Teams payloads without provider secrets", async () => {
  const event = normalizeSecurityNotificationEvent(eventInput, "https://app.sutracmdb.com");
  const first = await buildSecurityNotificationPayloads({
    event,
    emailRecipients: ["yds.veluvolu@gmail.com"],
  });
  const second = await buildSecurityNotificationPayloads({
    event,
    emailRecipients: ["yds.veluvolu@gmail.com"],
  });

  assert.equal(first.email.subject, "[Sutra CRITICAL] Internet-exposed privileged workload");
  assert.equal(first.slack.blocks.length, 4);
  assert.equal(first.microsoftTeams.attachments[0].content.type, "AdaptiveCard");
  assert.equal(first.payloadSha256, second.payloadSha256);
  assert.match(first.payloadSha256, /^[a-f0-9]{64}$/u);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes("hooks.slack.com"), false);
  assert.equal(serialized.includes("logic.azure.com"), false);
  assert.equal(serialized.includes("secret"), false);
});

test("normalizes and de-duplicates email recipients", async () => {
  const event = normalizeSecurityNotificationEvent(eventInput, "https://app.sutracmdb.com");
  const payload = await buildSecurityNotificationPayloads({
    event,
    emailRecipients: ["YDS.VELUVOLU@GMAIL.COM", "yds.veluvolu@gmail.com"],
  });
  assert.deepEqual(payload.email.to, ["yds.veluvolu@gmail.com"]);
});

test("rejects cross-origin links, fragments, malformed evidence, and invalid recipients", async () => {
  assert.throws(
    () => normalizeSecurityNotificationEvent(
      { ...eventInput, reportUrl: "https://attacker.example/steal" },
      "https://app.sutracmdb.com",
    ),
    SecurityNotificationError,
  );
  assert.throws(
    () => normalizeSecurityNotificationEvent(
      { ...eventInput, reportUrl: `${eventInput.reportUrl}#secret` },
      "https://app.sutracmdb.com",
    ),
    SecurityNotificationError,
  );
  assert.throws(
    () => normalizeSecurityNotificationEvent(
      { ...eventInput, evidenceSha256: "not-a-hash" },
      "https://app.sutracmdb.com",
    ),
    SecurityNotificationError,
  );
  const event = normalizeSecurityNotificationEvent(eventInput, "https://app.sutracmdb.com");
  await assert.rejects(
    buildSecurityNotificationPayloads({ event, emailRecipients: ["invalid"] }),
    SecurityNotificationError,
  );
});
