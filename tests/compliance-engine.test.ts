import assert from "node:assert/strict";
import test from "node:test";

import { ALL_ENABLED_AWS_REGIONS } from "../lib/aws-region-selection.ts";
import {
  COMPLIANCE_FRAMEWORKS,
  SUTRA_AWS_BASELINE,
} from "../lib/compliance-catalog.ts";
import {
  assessCompliance,
  COMPLIANCE_ASSESSMENT_DISCLAIMER,
} from "../lib/compliance-engine.ts";
import type {
  PilotConnection,
  PilotCoverageEntry,
  PilotFinding,
  PilotResource,
  PilotState,
} from "../lib/pilot-types.ts";

const COLLECTED_AT = "2026-07-16T10:00:00.000Z";
const REGIONS = ["us-east-1", "us-west-2"] as const;

const connection: PilotConnection = {
  id: "conn-compliance-test",
  customerId: "customer-compliance-test",
  customerName: "Compliance Test Customer",
  sourceKind: "aws_trust_role",
  fixtureId: null,
  fixtureVersion: null,
  partition: "aws",
  awsAccountId: "123456789012",
  roleArn: "arn:aws:iam::123456789012:role/SutraReadOnly",
  status: "active",
  enabledRegions: REGIONS,
  permissionPackVersion: "1.0.0",
  lastValidatedAt: COLLECTED_AT,
  lastSuccessfulSyncAt: COLLECTED_AT,
  createdAt: COLLECTED_AT,
  updatedAt: COLLECTED_AT,
};

function resource(
  resourceKey: string,
  resourceType: string,
  region = "us-east-1",
): PilotResource {
  return {
    resourceKey,
    service: resourceType.split(".")[1] ?? "aws",
    resourceType,
    nativeId: resourceKey,
    arn: null,
    name: resourceKey,
    region,
    state: "available",
    tags: {},
    configuration: {},
    source: {
      api: "unit-test",
      accountId: connection.awsAccountId,
      collectedAt: COLLECTED_AT,
    },
    contentSha256: `sha256-${resourceKey}`,
  };
}

const resources: readonly PilotResource[] = [
  resource("sg-1", "aws.ec2.security-group"),
  resource("i-1", "aws.ec2.instance"),
  resource("subnet-1", "aws.ec2.subnet"),
  resource("db-1", "aws.rds.db-instance"),
  resource("bucket-1", "aws.s3.bucket"),
];

function completeCoverage(): PilotCoverageEntry[] {
  const seen = new Set<string>();
  const result: PilotCoverageEntry[] = [];
  for (const control of SUTRA_AWS_BASELINE.controls) {
    for (const requirement of control.requiredCoverage) {
      const regions = requirement.regionScope === "global" ? ["global"] : REGIONS;
      for (const region of regions) {
        const identity = `${requirement.collectorKey}:${region}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        result.push({
          collectorKey: requirement.collectorKey,
          region,
          status: "succeeded",
          itemsObserved: 1,
          pagesObserved: 1,
        });
      }
    }
  }
  return result;
}

function finding(
  controlKey: string,
  status: PilotFinding["status"],
  fingerprint = `finding-${controlKey}`,
): PilotFinding {
  return {
    fingerprint,
    resourceKey: "i-1",
    controlKey,
    controlVersion: "1.0.0",
    severity: "high",
    status,
    title: "Unit-test finding",
    summary: "Unit-test finding summary",
    remediation: "Unit-test remediation",
    evidence: {},
    evaluatedAt: COLLECTED_AT,
  };
}

function state(overrides: Partial<PilotState> = {}): PilotState {
  return {
    mode: "live",
    connection,
    resources,
    relationships: [],
    findings: [],
    coverage: completeCoverage(),
    latestRunCoverage: null,
    syncRuns: [],
    activeSnapshot: {
      id: "snapshot-compliance-test",
      collectedAt: COLLECTED_AT,
      coverageState: "complete",
      snapshotSha256: "a".repeat(64),
      origin: { kind: "aws_sandbox", fixtureId: null, fixtureVersion: null },
    },
    ...overrides,
  };
}

function resultFor(assessment: ReturnType<typeof assessCompliance>, controlKey: string) {
  const result = assessment.results.find((candidate) => candidate.controlKey === controlKey);
  assert.ok(result, `Missing result for ${controlKey}`);
  return result;
}

test("the versioned baseline contains only the eleven live collector control keys", () => {
  const expected = new Set([
    "SUTRA.AWS.EC2.SSH_PUBLIC",
    "SUTRA.AWS.EC2.PUBLIC_IP",
    "SUTRA.AWS.EC2.IMDSV2_REQUIRED",
    "SUTRA.AWS.EC2.SUBNET_AUTO_PUBLIC_IP",
    "SUTRA.AWS.RDS.STORAGE_ENCRYPTED",
    "SUTRA.AWS.RDS.PUBLIC_ACCESS",
    "SUTRA.AWS.S3.PUBLIC_ACCESS_BLOCK",
    "SUTRA.AWS.CLOUDTRAIL.LOGGING",
    "SUTRA.AWS.GUARDDUTY.ENABLED",
    "SUTRA.AWS.SECURITYHUB.ENABLED",
    "SUTRA.AWS.IAM.PASSWORD_POLICY",
  ]);
  const actual = new Set(SUTRA_AWS_BASELINE.controls.map((control) => control.key));

  assert.equal(SUTRA_AWS_BASELINE.version, "1.0.0");
  assert.equal(SUTRA_AWS_BASELINE.controls.length, expected.size);
  assert.deepEqual(actual, expected);
  assert.ok(SUTRA_AWS_BASELINE.controls.every((control) => control.version === "1.0.0"));
  assert.ok(SUTRA_AWS_BASELINE.controls.every((control) => control.requiredCoverage.length > 0));
  assert.ok(
    SUTRA_AWS_BASELINE.controls.every((control) =>
      control.frameworkMappings.every(
        (mapping) =>
          mapping.frameworkKey === "nist-csf-2.0" && mapping.relationship === "supports",
      ),
    ),
  );
});

test("external framework metadata cannot be mistaken for bundled certification mappings", () => {
  const nist = COMPLIANCE_FRAMEWORKS.find((framework) => framework.key === "nist-csf-2.0");
  const cis = COMPLIANCE_FRAMEWORKS.find(
    (framework) => framework.key === "cis-aws-foundations",
  );
  const iso = COMPLIANCE_FRAMEWORKS.find((framework) => framework.key === "iso-27001");
  const soc2 = COMPLIANCE_FRAMEWORKS.find((framework) => framework.key === "soc-2");

  assert.equal(nist?.mappingMode, "informative-supporting");
  assert.match(nist?.claimBoundary ?? "", /do not establish/i);
  assert.equal(cis?.availability, "licensed-content-required");
  assert.equal(iso?.availability, "licensed-content-required");
  assert.equal(soc2?.availability, "mapping-review-required");
  assert.equal(cis?.version, null);
  assert.equal(iso?.version, null);
  assert.equal(soc2?.version, null);
});

test("complete coverage and applicable resources produce deterministic passes", () => {
  const first = assessCompliance(state());
  const second = assessCompliance(state());

  assert.deepEqual(first, second);
  assert.equal(first.assessmentId, "snapshot-compliance-test:sutra-aws-baseline:1.0.0");
  assert.equal(first.summary.total, 11);
  assert.equal(first.summary.pass, 11);
  assert.equal(first.summary.fail, 0);
  assert.equal(first.summary.scorePercent, 100);
  assert.ok(first.results.every((result) => result.status === "PASS"));
  assert.match(COMPLIANCE_ASSESSMENT_DISCLAIMER, /does not establish certification/i);
});

test("snapshot provenance is explicit and excludes the customer role ARN", () => {
  const assessment = assessCompliance(state());

  assert.deepEqual(assessment.provenance, {
    connectionId: connection.id,
    customerId: connection.customerId,
    awsAccountId: connection.awsAccountId,
    sourceKind: "aws_trust_role",
    snapshotId: "snapshot-compliance-test",
    snapshotSha256: "a".repeat(64),
    snapshotCollectedAt: COLLECTED_AT,
    snapshotCoverageState: "complete",
  });
  assert.equal(JSON.stringify(assessment).includes("SutraReadOnly"), false);
});

test("no active immutable snapshot yields UNKNOWN rather than a false pass", () => {
  const assessment = assessCompliance(
    state({ resources: [], findings: [], coverage: [], activeSnapshot: null }),
  );

  assert.equal(assessment.summary.unknown, 11);
  assert.equal(assessment.summary.scorePercent, null);
  assert.ok(assessment.results.every((result) => result.status === "UNKNOWN"));
  assert.equal(assessment.provenance.snapshotId, null);
});

test("resource controls are NOT_APPLICABLE only after complete collector coverage", () => {
  const assessment = assessCompliance(state({ resources: [] }));

  assert.equal(assessment.summary.notApplicable, 7);
  assert.equal(assessment.summary.pass, 4);
  assert.equal(resultFor(assessment, "SUTRA.AWS.EC2.PUBLIC_IP").status, "NOT_APPLICABLE");
  assert.equal(resultFor(assessment, "SUTRA.AWS.CLOUDTRAIL.LOGGING").status, "PASS");
});

test("missing required regional coverage preserves UNKNOWN with missing-region evidence", () => {
  const coverage = completeCoverage().filter(
    (entry) => !(entry.collectorKey === "ec2.instances" && entry.region === "us-west-2"),
  );
  const assessment = assessCompliance(state({ coverage }));
  const result = resultFor(assessment, "SUTRA.AWS.EC2.PUBLIC_IP");

  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.evidence.coverage[0]?.missingRegions, ["us-west-2"]);
  assert.equal(result.evidence.coverage[0]?.conclusion, "INCOMPLETE");
  assert.equal(resultFor(assessment, "SUTRA.AWS.EC2.IMDSV2_REQUIRED").status, "UNKNOWN");
});

test("all-enabled region selection derives expected regions across the snapshot coverage", () => {
  const coverage = completeCoverage().filter(
    (entry) =>
      !(entry.collectorKey === "ec2.subnets" && entry.region === "us-west-2"),
  );
  const assessment = assessCompliance(
    state({
      connection: { ...connection, enabledRegions: [ALL_ENABLED_AWS_REGIONS] },
      coverage,
    }),
  );
  const result = resultFor(assessment, "SUTRA.AWS.EC2.SUBNET_AUTO_PUBLIC_IP");

  assert.equal(result.status, "UNKNOWN");
  assert.deepEqual(result.evidence.coverage[0]?.expectedRegions, ["us-east-1", "us-west-2"]);
  assert.deepEqual(result.evidence.coverage[0]?.missingRegions, ["us-west-2"]);
});

test("known active failures win over incomplete coverage", () => {
  const assessment = assessCompliance(
    state({
      coverage: [],
      findings: [finding("SUTRA.AWS.EC2.PUBLIC_IP", "acknowledged")],
      activeSnapshot: {
        id: "partial-snapshot",
        collectedAt: COLLECTED_AT,
        coverageState: "partial",
        snapshotSha256: "b".repeat(64),
        origin: { kind: "aws_sandbox", fixtureId: null, fixtureVersion: null },
      },
    }),
  );
  const result = resultFor(assessment, "SUTRA.AWS.EC2.PUBLIC_IP");

  assert.equal(result.status, "FAIL");
  assert.equal(result.evidence.matchingFindings[0]?.status, "acknowledged");
  assert.equal(result.evidence.matchingFindings[0]?.fingerprint, "finding-SUTRA.AWS.EC2.PUBLIC_IP");
});

test("suppressed findings remain UNKNOWN until a governed exception is applied", () => {
  const assessment = assessCompliance(
    state({ findings: [finding("SUTRA.AWS.EC2.PUBLIC_IP", "suppressed")] }),
  );
  const result = resultFor(assessment, "SUTRA.AWS.EC2.PUBLIC_IP");

  assert.equal(result.status, "UNKNOWN");
  assert.match(result.reason, /suppression alone is not a compliance exception/i);
  assert.equal(assessment.summary.excepted, 0);
  assert.equal(assessment.summary.unknown, 1);
  assert.equal(assessment.summary.scoredControls, 10);
  assert.equal(assessment.summary.scorePercent, 100);
});

test("resolved findings do not fail the current complete snapshot", () => {
  const assessment = assessCompliance(
    state({ findings: [finding("SUTRA.AWS.EC2.PUBLIC_IP", "resolved")] }),
  );
  const result = resultFor(assessment, "SUTRA.AWS.EC2.PUBLIC_IP");

  assert.equal(result.status, "PASS");
  assert.equal(result.evidence.matchingFindings[0]?.status, "resolved");
});

test("score excludes UNKNOWN and NOT_APPLICABLE results", () => {
  const coverage = completeCoverage().filter(
    (entry) => entry.collectorKey !== "rds.db-instances",
  );
  const assessment = assessCompliance(
    state({
      coverage,
      findings: [
        finding("SUTRA.AWS.EC2.SSH_PUBLIC", "open"),
        finding("SUTRA.AWS.EC2.PUBLIC_IP", "suppressed"),
      ],
    }),
  );

  assert.equal(assessment.summary.fail, 1);
  assert.equal(assessment.summary.excepted, 0);
  assert.equal(assessment.summary.unknown, 3);
  assert.equal(assessment.summary.pass, 7);
  assert.equal(assessment.summary.scoredControls, 8);
  assert.equal(assessment.summary.scorePercent, 87.5);
});

test("a newer failed run is not mixed into the active snapshot assessment", () => {
  const assessment = assessCompliance(
    state({
      latestRunCoverage: {
        syncRunId: "newer-failed-run",
        entries: [
          {
            collectorKey: "ec2.instances",
            region: "us-east-1",
            status: "failed",
            itemsObserved: 0,
            pagesObserved: 0,
            errorCode: "ACCESS_DENIED",
          },
        ],
      },
    }),
  );

  assert.equal(assessment.summary.pass, 11);
  assert.equal(resultFor(assessment, "SUTRA.AWS.EC2.PUBLIC_IP").status, "PASS");
});
