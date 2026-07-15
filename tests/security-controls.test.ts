import assert from "node:assert/strict";
import test from "node:test";

import {
  awsAccounts,
  customers,
  demoFindings,
  demoInventory,
  demoPostureSummary,
  resources,
  securityGroups,
} from "../lib/demo-data.ts";
import {
  evaluateSecurityControls,
  securityControls,
  SECURITY_ENGINE_DISCLAIMER,
} from "../lib/security-controls.ts";
import type { AwsAccount, IamUserResource, SecurityGroup } from "../lib/types.ts";

test("demo inventory is explicitly fictional and tenant references stay isolated", () => {
  assert.equal(customers.length, 4);
  assert.equal(awsAccounts.length, 6);
  assert.equal(resources.length, 20);
  assert.ok(customers.every((customer) => customer.isDemo && customer.name.includes("(Demo)")));
  assert.ok(awsAccounts.every((account) => account.isDemo));

  const customersById = new Map(customers.map((customer) => [customer.id, customer]));
  for (const account of awsAccounts) {
    assert.ok(customersById.get(account.customerId)?.accountIds.includes(account.id));
  }
  for (const resource of resources) {
    const account = awsAccounts.find((candidate) => candidate.id === resource.accountId);
    assert.equal(account?.customerId, resource.customerId);
  }
});

test("demo data exercises every deterministic configuration control", () => {
  const evaluatedControlIds = new Set(demoFindings.map((finding) => finding.controlId));
  assert.equal(securityControls.length, 12);
  assert.equal(demoFindings.length, 22);
  assert.deepEqual(evaluatedControlIds, new Set(securityControls.map((control) => control.id)));
  assert.equal(demoPostureSummary.total, 22);
  assert.equal(demoPostureSummary.affectedAccounts, 5);
});

test("evaluation is deterministic and reports configuration observations only", () => {
  const first = evaluateSecurityControls(demoInventory);
  const second = evaluateSecurityControls(demoInventory);

  assert.deepEqual(first, second);
  assert.ok(first.every((finding) => finding.source === "deterministic-configuration-check"));
  assert.ok(first.every((finding) => finding.capability === "configuration-assessment"));
  assert.match(SECURITY_ENGINE_DISCLAIMER, /do not inspect software packages/i);
  assert.match(SECURITY_ENGINE_DISCLAIMER, /do not.*detect runtime threats/i);
});

test("public HTTPS alone is not mislabeled as open SSH or RDP", () => {
  const httpsOnlyGroup = securityGroups.find((group) => group.id === "secgrp-northstar-web");
  assert.ok(httpsOnlyGroup);

  const findings = evaluateSecurityControls({
    accounts: awsAccounts,
    resources: [],
    securityGroups: [httpsOnlyGroup],
  });
  assert.equal(findings.some((finding) => finding.controlId.includes("open-ssh")), false);
  assert.equal(findings.some((finding) => finding.controlId.includes("open-rdp")), false);
});

test("all-protocol public ingress covers both SSH and RDP ports", () => {
  const baseGroup = securityGroups.find((group) => group.id === "secgrp-northstar-web");
  assert.ok(baseGroup);
  const openAllGroup: SecurityGroup = {
    ...baseGroup,
    id: "secgrp-open-all-test",
    groupId: "sg-open-all-test",
    name: "open-all-test",
    ingress: [
      {
        id: "rule-open-all-test",
        protocol: "-1",
        fromPort: null,
        toPort: null,
        ipv4Ranges: ["0.0.0.0/0"],
        ipv6Ranges: [],
        sourceSecurityGroupIds: [],
        description: "Test fixture",
      },
    ],
  };

  const ids = evaluateSecurityControls({
    accounts: awsAccounts,
    resources: [],
    securityGroups: [openAllGroup],
  }).map((finding) => finding.controlId);
  assert.ok(ids.includes("aws.ec2.security-group.open-ssh"));
  assert.ok(ids.includes("aws.ec2.security-group.open-rdp"));
});

test("unknown account signals do not become failures", () => {
  const baseAccount = awsAccounts[0];
  assert.ok(baseAccount);
  const unknownAccount: AwsAccount = {
    ...baseAccount,
    id: "acct-unknown-signals-test",
    securitySignals: {
      rootMfa: "unknown",
      passwordPolicy: "unknown",
      cloudTrail: { status: "unknown", coveredRegions: [] },
      guardDuty: { status: "unknown", coveredRegions: [] },
      observedAt: baseAccount.lastSyncedAt,
    },
  };

  assert.deepEqual(
    evaluateSecurityControls({ accounts: [unknownAccount], resources: [], securityGroups: [] }),
    [],
  );
});

test("stale key threshold applies only to active keys older than 90 days", () => {
  const baseUser = resources.find(
    (resource): resource is IamUserResource => resource.id === "res-northstar-deploy-user",
  );
  assert.ok(baseUser);

  const boundaryUser: IamUserResource = {
    ...baseUser,
    id: "res-key-boundary-test",
    configuration: {
      ...baseUser.configuration,
      accessKeys: [
        { id: "ACTIVE90", status: "active", ageDays: 90, lastUsedDaysAgo: 1 },
        { id: "INACTIVE200", status: "inactive", ageDays: 200, lastUsedDaysAgo: 100 },
      ],
    },
  };

  const findings = evaluateSecurityControls({
    accounts: awsAccounts,
    resources: [boundaryUser],
    securityGroups: [],
  });
  assert.equal(findings.some((finding) => finding.controlId === "aws.iam.access-key-stale"), false);
});
