import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildFinopsAwsPolicyArtifacts,
  FinopsAwsPolicyArtifactError,
  serializeFinopsAwsPolicyArtifact,
  serializeFinopsIamPolicyDocument,
  verifyFinopsAwsPolicyArtifacts,
  type BuildFinopsAwsPolicyArtifactsInput,
  type FinopsAwsPolicyArtifact,
  type FinopsAwsPolicyArtifactSet,
} from "../lib/finops-aws-policy-artifact.ts";
import {
  assertFinopsCollectorReadOnly,
  buildFinopsPermissionPlan,
  type FinopsActionApproval,
} from "../lib/finops-aws-permissions.ts";
import { FINOPS_CAPABILITY_DEFINITIONS } from "../lib/finops-source-health.ts";

const NOW = "2026-07-31T12:00:00.000Z";
const ACTION_APPROVALS: readonly FinopsActionApproval[] = [
  {
    capability: "manage_aws_budgets",
    approvedBy: "owner@sutracmdb.com",
    approvedAtIso: "2026-07-31T11:00:00.000Z",
    expiresAtIso: "2026-08-01T11:00:00.000Z",
    changeTicket: "FINOPS-101",
  },
  {
    capability: "acknowledge_cost_anomaly",
    approvedBy: "owner@sutracmdb.com",
    approvedAtIso: "2026-07-31T11:00:00.000Z",
    expiresAtIso: "2026-08-01T11:00:00.000Z",
    changeTicket: "FINOPS-102",
  },
  {
    capability: "update_cost_optimization_preferences",
    approvedBy: "owner@sutracmdb.com",
    approvedAtIso: "2026-07-31T11:00:00.000Z",
    expiresAtIso: "2026-08-01T11:00:00.000Z",
    changeTicket: "FINOPS-103",
  },
];

const PERMISSION_INPUT = {
  partition: "aws" as const,
  accountId: "123456789012",
  region: "ap-south-1",
  exportBucketName: "sutra-finops-customer-123456789012",
  exportKeyPrefix: "sutra/data-exports/",
  amazonConnectInstanceArns: [
    "arn:aws:connect:ap-south-1:123456789012:instance/11111111-2222-3333-4444-555555555555",
  ],
  awsConfigAggregatorArn:
    "arn:aws:config:ap-south-1:123456789012:config-aggregator/sutra-org-aggregator",
  authorizedDataExportArns: [
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:export/sutra-carbon",
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:export/sutra-cora",
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:export/sutra-cur2",
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:export/sutra-focus12",
  ],
  authorizedDataExportTableArns: [
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:table/CARBON_EMISSIONS",
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:table/COST_OPTIMIZATION_RECOMMENDATIONS",
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:table/CUR2_0",
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:table/FOCUS_1_2_AWS",
  ],
  enabledCapabilityIds: FINOPS_CAPABILITY_DEFINITIONS.map((definition) => definition.id),
  includeProvisioner: true,
  actionApprovals: ACTION_APPROVALS,
  nowIso: NOW,
};

const BINDING = {
  tenantId: "tenant-sutra-001",
  customerId: "customer-acme-001",
  connectionId: "connection-aws-001",
  accountId: PERMISSION_INPUT.accountId,
  partition: PERMISSION_INPUT.partition,
  region: PERMISSION_INPUT.region,
};

function artifactInput(): BuildFinopsAwsPolicyArtifactsInput {
  return {
    plan: buildFinopsPermissionPlan(PERMISSION_INPUT),
    binding: BINDING,
    versions: {
      collector: "collector-2026.07.31.1",
      provisioner: "provisioner-2026.07.31.3",
      action: "action-2026.07.31.8",
    },
    actionApprovals: ACTION_APPROVALS,
    nowIso: NOW,
  };
}

function replaceCollector(
  artifacts: FinopsAwsPolicyArtifactSet,
  collector: FinopsAwsPolicyArtifact,
): FinopsAwsPolicyArtifactSet {
  return { ...artifacts, collector };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof FinopsAwsPolicyArtifactError ? error.code : undefined;
}

describe("enterprise FinOps AWS policy artifacts", () => {
  it("emits three separately versioned, tenant-bound canonical IAM artifacts", () => {
    const input = artifactInput();
    const artifacts = buildFinopsAwsPolicyArtifacts(input);

    assert.equal(artifacts.collector.artifactVersion, input.versions.collector);
    assert.equal(artifacts.provisioner?.artifactVersion, input.versions.provisioner);
    assert.equal(artifacts.action?.artifactVersion, input.versions.action);
    assert.equal(artifacts.collector.boundary, "collector");
    assert.equal(artifacts.provisioner?.boundary, "provisioner");
    assert.equal(artifacts.action?.boundary, "action");
    assert.notEqual(artifacts.collector.canonicalSha256, artifacts.provisioner?.canonicalSha256);
    assert.notEqual(artifacts.collector.canonicalSha256, artifacts.action?.canonicalSha256);
    assert.match(artifacts.collector.canonicalSha256, /^[a-f0-9]{64}$/u);
    assert.equal(artifacts.collector.binding.capabilityIds.length, 27);
    assert.deepEqual(
      artifacts.collector.binding.sourceIds,
      input.plan.requiredSourceIds,
    );
    assert.equal(
      artifacts.collector.binding.exactResourceReferences.length,
      artifacts.collector.policyDocument.Statement.length,
    );
    assert.deepEqual(
      artifacts.collector.binding.exactResourceReferences.map((reference) => reference.resources),
      artifacts.collector.policyDocument.Statement.map((statement) => statement.Resource),
    );
    assert.deepEqual(artifacts.collector.binding.approvedActions, []);
    assert.deepEqual(artifacts.provisioner?.binding.approvedActions, []);
    assert.equal(artifacts.action?.binding.approvedActions.length, 3);
    assert.doesNotThrow(() => verifyFinopsAwsPolicyArtifacts({
      ...input,
      artifacts,
    }));

    const envelopeJson = serializeFinopsAwsPolicyArtifact(artifacts.collector);
    const policyJson = serializeFinopsIamPolicyDocument(artifacts.collector);
    assert.equal(envelopeJson, JSON.stringify(artifacts.collector));
    assert.equal(policyJson, JSON.stringify(artifacts.collector.policyDocument));
    assert.doesNotMatch(envelopeJson, /\$\{|\{\{|AWS::|!Ref|!Sub/u);
  });

  it("keeps all 27 capabilities read-only and all provisioning/action mutations outside the collector", () => {
    const input = artifactInput();
    const artifacts = buildFinopsAwsPolicyArtifacts(input);
    const collectorActions = artifacts.collector.policyDocument.Statement
      .flatMap((statement) => statement.Action);
    const provisionerActions = artifacts.provisioner?.policyDocument.Statement
      .flatMap((statement) => statement.Action) ?? [];
    const actionActions = artifacts.action?.policyDocument.Statement
      .flatMap((statement) => statement.Action) ?? [];

    assert.equal(artifacts.collector.binding.capabilityIds.length, 27);
    assert.doesNotThrow(() => assertFinopsCollectorReadOnly(
      artifacts.collector.policyDocument.Statement.map((statement) => ({
        sid: statement.Sid,
        effect: statement.Effect,
        actions: statement.Action,
        resources: statement.Resource,
        ...(statement.Resource.includes("*")
          ? { resourceScopeReason: "operation_requires_account_wide_discovery" as const }
          : {}),
      })),
    ));
    assert.ok(provisionerActions.includes("bcm-data-exports:CreateExport"));
    assert.ok(provisionerActions.includes("iam:CreateServiceLinkedRole"));
    assert.ok(actionActions.includes("budgets:ModifyBudget"));
    assert.ok(actionActions.includes("cost-optimization-hub:UpdatePreferences"));
    for (const mutation of [...provisionerActions, ...actionActions].filter((action) =>
      /:(?:Create|Delete|Enable|Modify|Put|Remove|Tag|Update)/u.test(action)
    )) {
      assert.ok(!collectorActions.includes(mutation), mutation);
    }
    for (const artifact of [artifacts.collector, artifacts.provisioner, artifacts.action]) {
      assert.ok(artifact !== null);
      assert.ok(artifact.policyDocument.Statement.every((statement) =>
        statement.Action.every((action) => !action.includes("*"))
      ));
    }
  });

  it("preserves statement, Action, Resource, and Condition ordering exactly", () => {
    const input = artifactInput();
    const artifacts = buildFinopsAwsPolicyArtifacts(input);
    const listBucketPlanStatement = input.plan.collector.statements.find((statement) =>
      statement.actions.includes("s3:ListBucket")
    );
    const listBucketArtifactStatement = artifacts.collector.policyDocument.Statement.find((statement) =>
      statement.Action.includes("s3:ListBucket")
    );

    assert.ok(listBucketPlanStatement !== undefined);
    assert.ok(listBucketArtifactStatement !== undefined);
    assert.deepEqual(listBucketArtifactStatement.Action, listBucketPlanStatement.actions);
    assert.deepEqual(listBucketArtifactStatement.Resource, listBucketPlanStatement.resources);
    assert.deepEqual(listBucketArtifactStatement.Condition, listBucketPlanStatement.conditions);
    assert.deepEqual(
      artifacts.collector.policyDocument.Statement.map((statement) => statement.Sid),
      input.plan.collector.statements.map((statement) => statement.sid),
    );
  });

  it("rejects missing, extra, reordered, and widened statements", () => {
    const input = artifactInput();
    const artifacts = buildFinopsAwsPolicyArtifacts(input);
    const originalStatements = artifacts.collector.policyDocument.Statement;
    const mutations: readonly (readonly [string, FinopsAwsPolicyArtifact])[] = [
      [
        "missing",
        {
          ...artifacts.collector,
          policyDocument: {
            ...artifacts.collector.policyDocument,
            Statement: originalStatements.slice(1),
          },
        },
      ],
      [
        "extra",
        {
          ...artifacts.collector,
          policyDocument: {
            ...artifacts.collector.policyDocument,
            Statement: [...originalStatements, originalStatements[0]],
          },
        },
      ],
      [
        "reordered",
        {
          ...artifacts.collector,
          policyDocument: {
            ...artifacts.collector.policyDocument,
            Statement: [...originalStatements].reverse(),
          },
        },
      ],
      [
        "widened",
        {
          ...artifacts.collector,
          policyDocument: {
            ...artifacts.collector.policyDocument,
            Statement: originalStatements.map((statement, index) => index === 0
              ? { ...statement, Action: [...statement.Action, "s3:*"] }
              : statement),
          },
        },
      ],
    ];

    for (const [label, collector] of mutations) {
      assert.throws(
        () => verifyFinopsAwsPolicyArtifacts({
          ...input,
          artifacts: replaceCollector(artifacts, collector),
        }),
        (error) => errorCode(error) === "ATTESTATION_MISMATCH",
        label,
      );
    }
  });

  it("rejects a valid artifact set copied across tenants", () => {
    const input = artifactInput();
    const otherTenantInput = {
      ...input,
      binding: {
        ...input.binding,
        tenantId: "tenant-competitor-002",
        customerId: "customer-competitor-002",
        connectionId: "connection-aws-002",
      },
    };
    const otherTenantArtifacts = buildFinopsAwsPolicyArtifacts(otherTenantInput);

    assert.throws(
      () => verifyFinopsAwsPolicyArtifacts({
        ...input,
        artifacts: otherTenantArtifacts,
      }),
      (error) => errorCode(error) === "CROSS_TENANT_BINDING",
    );
  });

  it("rejects wildcard actions and boundary mergers before artifact creation", () => {
    const input = artifactInput();
    const firstCollectorStatement = input.plan.collector.statements[0];
    assert.ok(firstCollectorStatement !== undefined);
    const wildcardPlan = {
      ...input.plan,
      collector: {
        ...input.plan.collector,
        statements: [
          {
            ...firstCollectorStatement,
            actions: [...firstCollectorStatement.actions, "s3:*"],
          },
          ...input.plan.collector.statements.slice(1),
        ],
      },
    };
    assert.throws(
      () => buildFinopsAwsPolicyArtifacts({ ...input, plan: wildcardPlan }),
      (error) => errorCode(error) === "WILDCARD_ACTION",
    );

    assert.ok(input.plan.provisioner !== null);
    const mergedPlan = {
      ...input.plan,
      collector: {
        ...input.plan.collector,
        statements: [
          ...input.plan.collector.statements,
          input.plan.provisioner.statements[0],
        ],
      },
    };
    assert.throws(
      () => buildFinopsAwsPolicyArtifacts({ ...input, plan: mergedPlan }),
      (error) => errorCode(error) === "BOUNDARY_VIOLATION",
    );
  });

  it("does not emit optional boundaries unless the validated plan requests them", () => {
    const permissionPlan = buildFinopsPermissionPlan({
      ...PERMISSION_INPUT,
      includeProvisioner: false,
      actionApprovals: [],
    });
    const artifacts = buildFinopsAwsPolicyArtifacts({
      plan: permissionPlan,
      binding: BINDING,
      versions: { collector: "collector-2026.07.31.2" },
      nowIso: NOW,
    });
    assert.equal(artifacts.provisioner, null);
    assert.equal(artifacts.action, null);
    assert.doesNotThrow(() => verifyFinopsAwsPolicyArtifacts({
      plan: permissionPlan,
      binding: BINDING,
      versions: { collector: "collector-2026.07.31.2" },
      nowIso: NOW,
      artifacts,
    }));
  });
});
