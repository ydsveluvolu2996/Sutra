import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSesFeedbackEvent,
  SesFeedbackValidationError,
} from "../lib/ses-feedback.ts";
import {
  AwsSqsSesFeedbackQueue,
} from "../services/notification-worker/runtime-adapters.ts";
import {
  processOneSesFeedback,
  type SesFeedbackQueue,
} from "../services/notification-worker/ses-feedback.ts";
import {
  processOneSecurityNotification,
} from "../services/notification-worker/worker.ts";
import {
  buildSecurityNotificationPayloads,
  normalizeSecurityNotificationEvent,
} from "../lib/security-notifications.ts";

const deliveryId = `notify_${"a".repeat(48)}`;
const eventId = "8f16a5a2-1f7c-4ee5-a7bd-9b9fd8f46388";
const occurredAt = "2026-07-30T12:00:00.000Z";

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: "0",
    id: eventId,
    "detail-type": "Email Delivery",
    source: "aws.ses",
    account: "123456789012",
    time: occurredAt,
    region: "ap-south-1",
    resources: [],
    detail: {
      eventType: "Delivery",
      mail: {
        messageId: "provider-message-1",
        tags: {
          "ses:configuration-set": ["sutra-production-security-notifications"],
          sutra_delivery_id: [deliveryId],
        },
      },
    },
    ...overrides,
  });
}

const validation = {
  expectedRegion: "ap-south-1",
  expectedAccountId: "123456789012",
  expectedConfigurationSetName: "sutra-production-security-notifications",
  now: Date.parse("2026-07-30T12:01:00.000Z"),
} as const;

test("validates and normalizes tenant-opaque SES EventBridge feedback", async () => {
  const parsed = await parseSesFeedbackEvent({
    body: envelope(),
    ...validation,
  });
  assert.equal(parsed.eventId, eventId);
  assert.equal(parsed.deliveryId, deliveryId);
  assert.equal(parsed.providerMessageId, "provider-message-1");
  assert.equal(parsed.eventType, "delivery");
  assert.equal(parsed.occurredAt, Date.parse(occurredAt));
  assert.match(parsed.payloadSha256, /^[a-f0-9]{64}$/u);
  assert.equal("orgId" in parsed, false);
  assert.equal("customerId" in parsed, false);
});

test("rejects cross-account, cross-region, wrong-set, future, and malformed feedback", async () => {
  const cases = [
    envelope({ account: "999999999999" }),
    envelope({ region: "us-east-1" }),
    envelope({
      detail: {
        eventType: "Delivery",
        mail: {
          messageId: "provider-message-1",
          tags: {
            "ses:configuration-set": ["other-set"],
            sutra_delivery_id: [deliveryId],
          },
        },
      },
    }),
    envelope({ time: "2026-07-31T12:00:00.000Z" }),
    "{not-json",
  ];
  for (const body of cases) {
    await assert.rejects(
      parseSesFeedbackEvent({ body, ...validation }),
      SesFeedbackValidationError,
    );
  }
});

test("deletes feedback only after durable applied or duplicate reconciliation", async () => {
  for (const [reconciled, expected] of [
    ["applied", "ses_feedback_applied"],
    ["duplicate", "ses_feedback_duplicate"],
  ] as const) {
    const deleted: string[] = [];
    const queue: SesFeedbackQueue = {
      async receive() {
        return { body: envelope(), receiptHandle: "receipt-1" };
      },
      async delete(receiptHandle) {
        deleted.push(receiptHandle);
      },
    };
    const result = await processOneSesFeedback({
      queue,
      repository: { async reconcileSesFeedback() { return reconciled; } },
      ...validation,
      now: () => validation.now,
    });
    assert.equal(result, expected);
    assert.deepEqual(deleted, ["receipt-1"]);
  }
});

test("leaves invalid and unmatched messages for encrypted queue redrive", async () => {
  for (const [body, reconciled, expected] of [
    ["{invalid", "applied", "ses_feedback_invalid"],
    [envelope(), "unmatched", "ses_feedback_unmatched"],
  ] as const) {
    let deletes = 0;
    let reconciliations = 0;
    const result = await processOneSesFeedback({
      queue: {
        async receive() { return { body, receiptHandle: "receipt-2" }; },
        async delete() { deletes += 1; },
      },
      repository: {
        async reconcileSesFeedback() {
          reconciliations += 1;
          return reconciled;
        },
      },
      ...validation,
      now: () => validation.now,
    });
    assert.equal(result, expected);
    assert.equal(deletes, 0);
    assert.equal(reconciliations, body === "{invalid" ? 0 : 1);
  }
});

test("SQS feedback receive uses bounded ten-second long polling and aborts on shutdown", async () => {
  const externalAbort = new AbortController();
  let waitTimeSeconds: number | undefined;
  const client = {
    async send(
      command: unknown,
      options: { abortSignal?: AbortSignal } = {},
    ): Promise<never> {
      const commandInput = (command as {
        input?: { WaitTimeSeconds?: number };
      }).input;
      assert.ok(commandInput !== undefined);
      waitTimeSeconds = commandInput.WaitTimeSeconds;
      return new Promise((_resolve, reject) => {
        options.abortSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
        queueMicrotask(() => externalAbort.abort());
      });
    },
    destroy() {},
  };
  const queue = new AwsSqsSesFeedbackQueue({
    queueUrl:
      "https://sqs.ap-south-1.amazonaws.com/123456789012/sutra-production-ses-feedback",
    client,
  });
  assert.equal(await queue.receive(externalAbort.signal), null);
  assert.equal(waitTimeSeconds, 10);
  queue.destroy();
});

test("SES API acceptance remains provider_accepted until feedback reconciliation", async () => {
  const event = normalizeSecurityNotificationEvent({
    eventId: deliveryId,
    orgId: "org_sutra",
    customerId: "cust_customer",
    clusterId: "cluster_customer",
    severity: "critical",
    title: "Runtime threat detected",
    summary: "A privileged shell was detected.",
    occurredAt,
    findingCount: 1,
    reportUrl: "https://app.sutracmdb.com/security/runtime/example",
    evidenceSha256: "b".repeat(64),
  }, "https://app.sutracmdb.com");
  const payloads = await buildSecurityNotificationPayloads({
    event,
    emailRecipients: ["security@example.com"],
  });
  const finishes: unknown[][] = [];
  const result = await processOneSecurityNotification({
    repository: {
      async claim() {
        return {
          id: `njob_${"c".repeat(32)}`,
          orgId: event.orgId,
          customerId: event.customerId,
          leaseToken: `nlease_${"d".repeat(32)}`,
          destination: {
            id: `ndest_${"e".repeat(32)}`,
            orgId: event.orgId,
            customerId: event.customerId,
            channel: "email" as const,
            displayName: "Security email",
            enabled: true,
            configuration: {
              channel: "email" as const,
              recipients: ["security@example.com"],
              fromAddress: "alerts@sutracmdb.com",
              sesRegion: "ap-south-1",
            },
            deliveryReadiness: "configured" as const,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          },
          event,
          payloads,
          attemptCount: 1,
        };
      },
      async finish(...args) {
        finishes.push(args);
      },
    },
    delivery: {
      secrets: { async resolveWebhook() { return null; } },
      dns: { async resolve() { return []; } },
      http: { async post() { throw new Error("unused"); } },
      ses: {
        async post() {
          return { status: 200, headers: {}, bodyBytes: new Uint8Array() };
        },
      },
    },
  });
  assert.equal(result, "provider_accepted");
  assert.equal(finishes.length, 1);
  assert.deepEqual(finishes[0]?.slice(2), [
    "provider_accepted",
    null,
    null,
    deliveryId,
  ]);
});
