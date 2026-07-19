import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureEventChangeHints, type CapturedManagementEvent } from "../lib/cmdb-event-capture.ts";

const SNAPSHOT_AT = 1_000_000;

const RESOURCES = [
  { resourceKey: "aws.ec2.instance/i-1", nativeId: "i-1", arn: "arn:aws:ec2:us-east-1:1:instance/i-1" },
  { resourceKey: "aws.s3.bucket/exports", nativeId: "exports", arn: "arn:aws:s3:::exports" },
];

function event(overrides: Partial<CapturedManagementEvent>): CapturedManagementEvent {
  return {
    eventName: "ModifyInstanceAttribute",
    eventSource: "ec2.amazonaws.com",
    eventTimeMs: SNAPSHOT_AT + 60_000,
    readOnly: false,
    errorCode: null,
    resources: [{ type: "AWS::EC2::Instance", name: "i-1" }],
    ...overrides,
  };
}

describe("captureEventChangeHints", () => {
  it("maps mutating post-snapshot events to snapshot resources by native id or arn", () => {
    const result = captureEventChangeHints({
      snapshotCollectedAtMs: SNAPSHOT_AT,
      snapshotResources: RESOURCES,
      events: [
        event({}),
        event({ eventName: "PutBucketPolicy", eventSource: "s3.amazonaws.com", resources: [{ type: "AWS::S3::Bucket", name: "arn:aws:s3:::exports" }], eventTimeMs: SNAPSHOT_AT + 120_000 }),
      ],
    });
    assert.deepEqual(result.hints.map((hint) => hint.resourceKey), ["aws.s3.bucket/exports", "aws.ec2.instance/i-1"]);
    assert.equal(result.hints[0].basis, "event-observed");
    assert.equal(result.excludedCount, 0);
  });

  it("excludes read-only, failed, and pre-snapshot events; counts unknown mutability honestly", () => {
    const result = captureEventChangeHints({
      snapshotCollectedAtMs: SNAPSHOT_AT,
      snapshotResources: RESOURCES,
      events: [
        event({ readOnly: true }),
        event({ errorCode: "AccessDenied" }),
        event({ eventTimeMs: SNAPSHOT_AT - 1 }),
        event({ readOnly: null }),
      ],
    });
    assert.equal(result.hints.length, 0);
    assert.equal(result.excludedCount, 3);
    assert.equal(result.unassessedCount, 1);
    assert.equal(result.evaluatedCount, 4);
  });

  it("routes unknown resource names to possibleNew and nameless events to unmapped — never guesses", () => {
    const result = captureEventChangeHints({
      snapshotCollectedAtMs: SNAPSHOT_AT,
      snapshotResources: RESOURCES,
      events: [
        event({ eventName: "RunInstances", resources: [{ type: "AWS::EC2::Instance", name: "i-brand-new" }] }),
        event({ eventName: "CreateTags", resources: [] }),
        event({ eventName: "CreateTags", resources: [] }),
      ],
    });
    assert.equal(result.hints.length, 0);
    assert.deepEqual(result.possibleNew.map((hint) => hint.resourceName), ["i-brand-new"]);
    assert.deepEqual(result.unmapped, [{ eventName: "CreateTags", eventSource: "ec2.amazonaws.com", count: 2 }]);
    assert.match(result.disclaimer, /not from collection/);
  });

  it("dedupes repeated hints for the same resource, event and time", () => {
    const duplicate = event({});
    const result = captureEventChangeHints({
      snapshotCollectedAtMs: SNAPSHOT_AT,
      snapshotResources: RESOURCES,
      events: [duplicate, duplicate],
    });
    assert.equal(result.hints.length, 1);
    assert.equal(result.evaluatedCount, 2);
  });
});
