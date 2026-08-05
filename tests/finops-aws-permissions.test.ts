import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertFinopsCollectorReadOnly,
  buildFinopsPermissionPlan,
  FinopsPermissionPlanError,
} from "../lib/finops-aws-permissions.ts";
import { AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS } from "../lib/finops-amazon-connect-cost-insight.ts";
import {
  CORA_ENROLLMENT_PROVISIONER_OPERATIONS,
  CORA_EXPORT_PROVISIONER_OPERATIONS,
  CORA_ORGANIZATION_READ_OPERATIONS,
  CORA_PERMANENT_EXPORT_READ_OPERATIONS,
  CORA_PERMANENT_HUB_READ_OPERATIONS,
  CORA_PERMANENT_S3_READ_OPERATIONS,
} from "../lib/finops-cora.ts";
import {
  AWS_CONFIG_AGGREGATOR_READ_OPERATIONS,
  AWS_CONFIG_ORGANIZATION_READ_OPERATIONS,
  AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS,
  AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS,
} from "../lib/finops-aws-config-compliance.ts";
import { MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS } from "../lib/finops-media-services-insights.ts";
import { PRICING_CHANGE_READ_OPERATIONS } from "../lib/finops-pricing-change-analysis.ts";
import { SCAD_ONE_TIME_PROVISIONER_IAM_ACTIONS } from "../lib/finops-scad-allocation.ts";
import { FINOPS_CAPABILITY_DEFINITIONS } from "../lib/finops-source-health.ts";

const BASE = {
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
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:export/sutra-cur2",
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:export/sutra-focus12",
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:export/sutra-carbon",
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:export/sutra-cora",
  ],
  authorizedDataExportTableArns: [
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:table/CUR2_0",
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:table/FOCUS_1_2_AWS",
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:table/CARBON_EMISSIONS",
    "arn:aws:bcm-data-exports:ap-south-1:123456789012:table/COST_OPTIMIZATION_RECOMMENDATIONS",
  ],
  enabledCapabilityIds: FINOPS_CAPABILITY_DEFINITIONS.map((definition) => definition.id),
  includeProvisioner: false,
  nowIso: "2026-07-31T12:00:00.000Z",
};

describe("enterprise FinOps AWS permission model", () => {
  it("maps all 27 dashboards while keeping the collector explicit and read-only", () => {
    const plan = buildFinopsPermissionPlan(BASE);
    assert.equal(plan.enabledCapabilityIds.length, 27);
    assert.equal(plan.provisioner, null);
    assert.equal(plan.action, null);
    assert.ok(plan.requiredSourceIds.length >= 20);
    assert.doesNotThrow(() => assertFinopsCollectorReadOnly(plan.collector.statements));
    const actions = plan.collector.statements.flatMap((statement) => statement.actions);
    assert.ok(actions.includes("s3:GetObject"));
    assert.ok(actions.includes("bcm-data-exports:GetExecution"));
    assert.ok(actions.includes("organizations:ListAccounts"));
    assert.ok(actions.includes("aws-portal:ViewBilling"));
    assert.ok(actions.includes("trustedadvisor:ListOrganizationRecommendations"));
    assert.ok(actions.includes("trustedadvisor:GetOrganizationRecommendation"));
    assert.ok(actions.includes("compute-optimizer:GetEC2InstanceRecommendations"));
    assert.ok(actions.includes("compute-optimizer:GetIdleRecommendations"));
    assert.ok(actions.includes("autoscaling:DescribeAutoScalingGroups"));
    assert.ok(actions.includes("cost-optimization-hub:GetPreferences"));
    assert.ok(actions.includes("cost-optimization-hub:ListEnrollmentStatuses"));
    assert.ok(!actions.includes("cost-optimization-hub:GetRecommendation"));
    assert.ok(!actions.includes("cost-optimization-hub:ListRecommendations"));
    assert.ok(actions.includes("health:DescribeHealthServiceStatusForOrganization"));
    assert.ok(actions.includes("eks:DescribeClusterVersions"));
    assert.ok(actions.includes("es:DescribeDomain"));
    assert.ok(actions.includes("rds:DescribeDBMajorEngineVersions"));
    assert.ok(!actions.includes("opensearch:DescribeDomain"));
    assert.ok(actions.includes("budgets:DescribeBudgetActionsForBudget"));
    assert.ok(actions.includes("budgets:ListTagsForResource"));
    assert.ok(actions.includes("billing:GetBillingViewData"));
    assert.ok(actions.includes("aws-marketplace:GetAgreementEntitlements"));
    assert.ok(actions.includes("aws-marketplace:ListAgreementCharges"));
    assert.ok(actions.includes("aws-marketplace:GetProduct"));
    assert.ok(actions.includes("license-manager:GetServiceSettings"));
    assert.ok(actions.includes("license-manager:ListReceivedGrantsForOrganization"));
    assert.ok(actions.includes("license-manager:ListReceivedLicensesForOrganization"));
    assert.ok(!actions.includes("aws-marketplace:GetEntitlements"));
    assert.ok(!actions.includes("aws-marketplace:ListAgreementInvoiceLineItems"));
    assert.ok(!actions.includes("license-manager:GetLicense"));
    assert.ok(actions.includes("workspaces:DescribeWorkspaceBundles"));
    assert.ok(actions.includes("appstream:ListAssociatedFleets"));
    assert.ok(!actions.includes("cloudwatch:GetMetricStatistics"));
    const mediaActions = actions
      .filter((action) => /^(?:mediaconnect|mediaconvert|medialive|mediapackage|mediapackagev2|mediatailor):/u.test(action))
      .sort((left, right) => left.localeCompare(right));
    const expectedMediaActions = Object.values(MEDIA_SERVICES_INSIGHTS_READ_OPERATIONS)
      .flat()
      .sort((left, right) => left.localeCompare(right));
    assert.equal(mediaActions.length, 46);
    assert.deepEqual(mediaActions, expectedMediaActions);
    assert.ok(actions.includes("support:DescribeCases"));
    assert.ok(actions.includes("support:DescribeCommunications"));
    assert.ok(!actions.includes("support:DescribeServices"));
    assert.ok(!actions.includes("support:DescribeSeverityLevels"));
    const resilienceActions = actions
      .filter((action) => action.startsWith("resiliencehub:"))
      .sort((left, right) => left.localeCompare(right));
    assert.deepEqual(resilienceActions, [
      "resiliencehub:DescribeApp",
      "resiliencehub:DescribeAppAssessment",
      "resiliencehub:DescribeResiliencyPolicy",
      "resiliencehub:ListAlarmRecommendations",
      "resiliencehub:ListAppAssessmentComplianceDrifts",
      "resiliencehub:ListAppAssessmentResourceDrifts",
      "resiliencehub:ListAppAssessments",
      "resiliencehub:ListAppComponentCompliances",
      "resiliencehub:ListAppComponentRecommendations",
      "resiliencehub:ListApps",
      "resiliencehub:ListAppVersionResources",
      "resiliencehub:ListResiliencyPolicies",
      "resiliencehub:ListSopRecommendations",
      "resiliencehub:ListTestRecommendations",
    ]);
    const configActions = actions
      .filter((action) => action.startsWith("config:"))
      .sort((left, right) => left.localeCompare(right));
    const configActionNames: readonly string[] = configActions;
    assert.deepEqual(
      configActions,
      [
        ...AWS_CONFIG_AGGREGATOR_READ_OPERATIONS,
        ...AWS_CONFIG_RULE_LIFECYCLE_READ_OPERATIONS,
        ...AWS_CONFIG_RECORDER_COVERAGE_READ_OPERATIONS,
      ].sort((left, right) => left.localeCompare(right)),
    );
    assert.ok(!configActionNames.includes("config:ListAggregateDiscoveredResources"));
    for (
      const action of AWS_CONFIG_AGGREGATOR_READ_OPERATIONS
        .filter((operation) => operation !== "config:DescribeConfigurationAggregators")
    ) {
      const statement = plan.collector.statements.find((candidate) =>
        candidate.actions.includes(action));
      assert.deepEqual(statement?.resources, [
        "arn:aws:config:ap-south-1:123456789012:config-aggregator/sutra-org-aggregator",
      ]);
    }
    const recorder = plan.collector.statements.find((statement) =>
      statement.actions.includes("config:DescribeConfigurationRecorders"));
    assert.deepEqual(recorder?.resources, [
      "arn:aws:config:ap-south-1:123456789012:configuration-recorder/*/*",
    ]);
    assert.deepEqual(recorder?.actions, [
      "config:DescribeConfigurationRecorders",
      "config:DescribeConfigurationRecorderStatus",
    ]);
    assert.ok(actions.every((action) => !action.includes("*")));
    assert.ok(plan.externalPrerequisites.some((item) => item.includes("Support plan")));
    const budget = plan.collector.statements.find((statement) => statement.actions.includes("budgets:ViewBudget"));
    assert.deepEqual(budget?.resources, ["arn:aws:budgets::123456789012:budget/*"]);
    assert.ok(budget?.actions.includes("budgets:DescribeBudgetActionsForBudget"));
    assert.ok(budget?.actions.includes("budgets:ListTagsForResource"));
    const billingView = plan.collector.statements.find((statement) =>
      statement.actions.includes("billing:GetBillingViewData"));
    assert.deepEqual(billingView?.resources, [
      "arn:aws:billing::123456789012:billingview/*",
    ]);
    const marketplaceProduct = plan.collector.statements.find((statement) =>
      statement.actions.includes("aws-marketplace:GetProduct"));
    assert.deepEqual(marketplaceProduct?.resources, [
      "arn:aws:aws-marketplace:::catalog/AWSMarketplace/product/*",
    ]);
    const logEvents = plan.collector.statements.find((statement) => statement.actions.includes("logs:GetLogEvents"));
    assert.deepEqual(logEvents?.resources, [
      "arn:aws:logs:ap-south-1:123456789012:log-group:/aws/sutra/*:log-stream:*",
    ]);
    const exportRead = plan.collector.statements.find((statement) =>
      statement.actions.includes("bcm-data-exports:GetExport"));
    assert.deepEqual(
      exportRead?.resources,
      [...BASE.authorizedDataExportArns].sort((left, right) =>
        left.localeCompare(right)
      ),
    );
    assert.ok(exportRead?.actions.includes("bcm-data-exports:GetExecution"));
    assert.ok(exportRead?.actions.includes("bcm-data-exports:ListExecutions"));
    for (const action of CORA_PERMANENT_EXPORT_READ_OPERATIONS) {
      assert.ok(exportRead?.actions.includes(action));
    }
    for (const action of CORA_PERMANENT_HUB_READ_OPERATIONS) {
      assert.ok(actions.includes(action));
    }
    for (const action of CORA_ORGANIZATION_READ_OPERATIONS) {
      assert.ok(actions.includes(action));
    }
    for (const action of CORA_PERMANENT_S3_READ_OPERATIONS) {
      assert.ok(actions.includes(action));
    }
    const tableRead = plan.collector.statements.find((statement) =>
      statement.actions.includes("bcm-data-exports:GetTable"));
    assert.deepEqual(
      tableRead?.resources,
      [...BASE.authorizedDataExportTableArns].sort((left, right) =>
        left.localeCompare(right)
      ),
    );
    const global = plan.collector.statements.find((statement) => statement.resources.includes("*"));
    assert.equal(global?.resourceScopeReason, "operation_requires_account_wide_discovery");
    assert.ok(!global?.actions.includes("aws-marketplace:GetProduct"));
    assert.ok(!global?.actions.includes("budgets:ViewBudget"));
    assert.ok(!global?.actions.includes("logs:GetLogEvents"));
    const listBucket = plan.collector.statements.find((statement) => statement.actions.includes("s3:ListBucket"));
    assert.deepEqual(listBucket?.resources, ["arn:aws:s3:::sutra-finops-customer-123456789012"]);
    assert.deepEqual(listBucket?.conditions, {
      StringLike: {
        "s3:prefix": ["sutra/data-exports/", "sutra/data-exports/*"],
      },
    });
    const getObject = plan.collector.statements.find((statement) => statement.actions.includes("s3:GetObject"));
    assert.deepEqual(getObject?.resources, [
      "arn:aws:s3:::sutra-finops-customer-123456789012/sutra/data-exports/*",
    ]);
    const resilienceApp = plan.collector.statements.find((statement) =>
      statement.actions.includes("resiliencehub:ListAppComponentRecommendations"));
    assert.deepEqual(resilienceApp?.resources, [
      "arn:aws:resiliencehub:ap-south-1:123456789012:app/*",
    ]);
    assert.equal(resilienceApp?.actions.length, 10);
    const resiliencePolicy = plan.collector.statements.find((statement) =>
      statement.actions.includes("resiliencehub:DescribeResiliencyPolicy"));
    assert.deepEqual(resiliencePolicy?.resources, [
      "arn:aws:resiliencehub:ap-south-1:123456789012:resiliency-policy/*",
    ]);
    assert.ok(global?.actions.includes("resiliencehub:ListApps"));
    assert.ok(global?.actions.includes("resiliencehub:ListAppAssessments"));
    assert.ok(global?.actions.includes("resiliencehub:ListResiliencyPolicies"));
    const appstreamSessions = plan.collector.statements.find((statement) =>
      statement.actions.includes("appstream:DescribeSessions"));
    assert.deepEqual(appstreamSessions?.resources, [
      "arn:aws:appstream:ap-south-1:123456789012:fleet/*",
      "arn:aws:appstream:ap-south-1:123456789012:stack/*",
    ]);
    const appstreamAssociations = plan.collector.statements.find((statement) =>
      statement.actions.includes("appstream:ListAssociatedFleets"));
    assert.deepEqual(appstreamAssociations?.resources, [
      "arn:aws:appstream:ap-south-1:123456789012:stack/*",
    ]);
    assert.ok(global?.actions.includes("cloudwatch:GetMetricData"));
    assert.ok(global?.actions.includes("mediaconnect:ListFlows"));
    assert.ok(global?.actions.includes("medialive:ListOfferings"));
    assert.ok(global?.actions.includes("mediapackagev2:ListChannelGroups"));
    assert.ok(global?.actions.includes("mediatailor:ListAlerts"));
    const connectActions = actions
      .filter((action) => action.startsWith("connect:") || action.startsWith("ds:"))
      .sort((left, right) => left.localeCompare(right));
    assert.deepEqual(
      connectActions,
      [...AMAZON_CONNECT_COST_INSIGHT_READ_OPERATIONS]
        .sort((left, right) => left.localeCompare(right)),
    );
    assert.ok(!actions.includes("connect:ListInstances"));
    const connectInstance = plan.collector.statements.find((statement) =>
      statement.actions.includes("connect:DescribeInstance"));
    assert.deepEqual(connectInstance?.resources, [
      "arn:aws:connect:ap-south-1:123456789012:instance/11111111-2222-3333-4444-555555555555",
    ]);
    const connectPhoneNumbers = plan.collector.statements.find((statement) =>
      statement.actions.includes("connect:ListPhoneNumbersV2"));
    assert.deepEqual(connectPhoneNumbers?.resources, [
      "arn:aws:connect:ap-south-1:123456789012:phone-number/*",
    ]);
    assert.ok(global?.actions.includes("ds:DescribeDirectories"));
    const pricingOnlyPlan = buildFinopsPermissionPlan({
      ...BASE,
      enabledCapabilityIds: ["pricing_change"],
    });
    const pricingActions = pricingOnlyPlan.collector.statements
      .flatMap((statement) => statement.actions)
      .filter((action) => action.startsWith("pricing:"))
      .sort((left, right) => left.localeCompare(right));
    const pricingActionNames: readonly string[] = pricingActions;
    assert.deepEqual(
      pricingActions,
      [...PRICING_CHANGE_READ_OPERATIONS]
        .sort((left, right) => left.localeCompare(right)),
    );
    assert.ok(global?.actions.includes("pricing:GetPriceListFileUrl"));
    assert.ok(global?.actions.includes("pricing:ListPriceLists"));
    assert.ok(global?.actions.includes("config:DescribeConfigurationAggregators"));
    assert.ok(global?.actions.includes("config:DescribeConfigRules"));
    assert.ok(global?.actions.includes("config:DescribeConfigRuleEvaluationStatus"));
    for (const action of AWS_CONFIG_ORGANIZATION_READ_OPERATIONS) {
      assert.ok(global?.actions.includes(action));
    }
    assert.ok(!pricingActionNames.includes("pricing:DescribeServices"));
    assert.ok(!pricingActionNames.includes("pricing:GetAttributeValues"));
    assert.ok(!pricingActionNames.includes("pricing:GetProducts"));
    assert.ok(!actions.includes("sustainability:GetCarbonFootprintSummary"));
    const mediaConnectFlow = plan.collector.statements.find((statement) =>
      statement.actions.includes("mediaconnect:DescribeFlow"));
    assert.deepEqual(mediaConnectFlow?.resources, [
      "arn:aws:mediaconnect:ap-south-1:123456789012:flow:*:*",
    ]);
    const mediaPackageV2Harvest = plan.collector.statements.find((statement) =>
      statement.actions.includes("mediapackagev2:GetHarvestJob"));
    assert.deepEqual(mediaPackageV2Harvest?.resources, [
      "arn:aws:mediapackagev2:ap-south-1:123456789012:channelGroup/*/channel/*",
      "arn:aws:mediapackagev2:ap-south-1:123456789012:channelGroup/*",
      "arn:aws:mediapackagev2:ap-south-1:123456789012:channelGroup/*/channel/*/originEndpoint/*/harvestJob/*",
      "arn:aws:mediapackagev2:ap-south-1:123456789012:channelGroup/*/channel/*/originEndpoint/*",
    ].sort((left, right) => left.localeCompare(right)));
    const mediaTailorTags = plan.collector.statements.find((statement) =>
      statement.actions.includes("mediatailor:ListTagsForResource"));
    assert.deepEqual(mediaTailorTags?.resources, [
      "arn:aws:mediatailor:ap-south-1:123456789012:channel/*",
      "arn:aws:mediatailor:ap-south-1:123456789012:liveSource/*/*",
      "arn:aws:mediatailor:ap-south-1:123456789012:playbackConfiguration/*",
      "arn:aws:mediatailor:ap-south-1:123456789012:sourceLocation/*",
      "arn:aws:mediatailor:ap-south-1:123456789012:vodSource/*/*",
    ]);
    assert.equal(
      plan.collector.statements.some((statement) =>
        statement.resources.includes("arn:aws:s3:::sutra-finops-customer-123456789012/*")),
      false,
    );
  });

  it("keeps one-time provisioning out of the always-on collector", () => {
    const plan = buildFinopsPermissionPlan({ ...BASE, includeProvisioner: true });
    const provisionerActions =
      plan.provisioner?.statements.flatMap((statement) => statement.actions) ?? [];
    assert.ok(provisionerActions.includes("bcm-data-exports:CreateExport"));
    assert.ok(provisionerActions.includes("cur:PutReportDefinition"));
    assert.ok(provisionerActions.includes("s3:PutBucketPolicy"));
    assert.ok(provisionerActions.includes(
      "sustainability:GetCarbonFootprintSummary",
    ));
    for (const action of SCAD_ONE_TIME_PROVISIONER_IAM_ACTIONS) {
      assert.ok(provisionerActions.includes(action));
    }
    for (
      const action of [
        ...CORA_ENROLLMENT_PROVISIONER_OPERATIONS,
        ...CORA_EXPORT_PROVISIONER_OPERATIONS,
      ]
    ) {
      assert.ok(provisionerActions.includes(action));
    }
    const bucketPolicy = plan.provisioner?.statements.find((statement) =>
      statement.actions.includes("s3:PutBucketPolicy"));
    assert.deepEqual(bucketPolicy?.resources, [
      "arn:aws:s3:::sutra-finops-customer-123456789012",
    ]);
    assert.ok(!bucketPolicy?.resources.includes("*"));
    const splitCostServiceLinkedRole = plan.provisioner?.statements.find(
      (statement) =>
        statement.conditions?.StringEquals?.["iam:AWSServiceName"]
        === "split-cost-allocation-data.bcm.amazonaws.com",
    );
    assert.deepEqual(splitCostServiceLinkedRole?.resources, [
      "arn:aws:iam::123456789012:role/aws-service-role/"
      + "split-cost-allocation-data.bcm.amazonaws.com/"
      + "AWSServiceRoleForSplitCostAllocationData",
    ]);
    assert.deepEqual(splitCostServiceLinkedRole?.conditions, {
      StringEquals: {
        "iam:AWSServiceName": "split-cost-allocation-data.bcm.amazonaws.com",
      },
    });
    const costHubServiceLinkedRole = plan.provisioner?.statements.find(
      (statement) =>
        statement.conditions?.StringEquals?.["iam:AWSServiceName"]
        === "cost-optimization-hub.bcm.amazonaws.com",
    );
    assert.deepEqual(costHubServiceLinkedRole?.resources, [
      "arn:aws:iam::123456789012:role/aws-service-role/"
      + "cost-optimization-hub.bcm.amazonaws.com/"
      + "AWSServiceRoleForCostOptimizationHub",
    ]);
    const dataExportsServiceLinkedRole = plan.provisioner?.statements.find(
      (statement) =>
        statement.conditions?.StringEquals?.["iam:AWSServiceName"]
        === "bcm-data-exports.amazonaws.com",
    );
    assert.deepEqual(dataExportsServiceLinkedRole?.resources, [
      "arn:aws:iam::123456789012:role/aws-service-role/"
      + "bcm-data-exports.amazonaws.com/"
      + "AWSServiceRoleForBCMDataExports",
    ]);
    const organizationEnrollment = plan.provisioner?.statements.find(
      (statement) =>
        statement.actions.includes("organizations:EnableAWSServiceAccess"),
    );
    assert.deepEqual(organizationEnrollment?.conditions, {
      StringEquals: {
        "organizations:ServicePrincipal":
          "cost-optimization-hub.bcm.amazonaws.com",
      },
    });
    const costHubInlineRole = plan.provisioner?.statements.find((statement) =>
      statement.actions.includes("iam:PutRolePolicy"));
    assert.deepEqual(costHubInlineRole?.resources, [
      "arn:aws:iam::123456789012:role/aws-service-role/"
      + "cost-optimization-hub.bcm.amazonaws.com/"
      + "AWSServiceRoleForCostOptimizationHub",
    ]);
    assert.ok(!plan.collector.statements.some((statement) => statement.actions.some((action) =>
      action === "bcm-data-exports:CreateExport"
      || action === "bcm-data-exports:DeleteExport"
      || action === "bcm-data-exports:UpdateExport"
      || action.startsWith("s3:Put")
      || action === "cur:PutReportDefinition"
      || action === "ce:UpdatePreferences"
      || action === "ce:UpdateCostAllocationTagsStatus"
      || action === "iam:CreateServiceLinkedRole"
      || action === "iam:PutRolePolicy"
      || action === "organizations:EnableAWSServiceAccess"
    )));
    assert.equal(plan.collector.boundary, "collector");
    assert.equal(plan.provisioner?.boundary, "provisioner");

    const pricingOnly = buildFinopsPermissionPlan({
      ...BASE,
      enabledCapabilityIds: ["pricing_change"],
      includeProvisioner: true,
    });
    const pricingProvisionerActions =
      pricingOnly.provisioner?.statements.flatMap((statement) => statement.actions)
      ?? [];
    assert.ok(!pricingProvisionerActions.includes(
      "sustainability:GetCarbonFootprintSummary",
    ));
    assert.ok(!pricingProvisionerActions.includes("ce:UpdatePreferences"));
    assert.ok(!pricingProvisionerActions.includes("iam:CreateServiceLinkedRole"));
  });

  it("creates a separate action role only for attributable, unexpired approvals", () => {
    const plan = buildFinopsPermissionPlan({
      ...BASE,
      actionApprovals: [{
        capability: "manage_aws_budgets",
        approvedBy: "user_finops_owner",
        approvedAtIso: "2026-07-31T11:00:00.000Z",
        expiresAtIso: "2026-08-07T11:00:00.000Z",
        changeTicket: "CHG-2026-1042",
      }],
    });
    assert.deepEqual(plan.action?.statements[0]?.actions, ["aws-portal:ModifyBilling", "budgets:ModifyBudget"]);
    assert.ok(!plan.collector.statements.some((statement) => statement.actions.includes("budgets:ModifyBudget")));
    assert.equal(plan.action?.boundary, "action");
  });

  it("rejects wildcard or mutation authority in a collector policy", () => {
    assert.throws(
      () => assertFinopsCollectorReadOnly([{ sid: "bad", effect: "Allow", actions: ["s3:*"], resources: ["arn:aws:s3:::bucket"] }]),
      (error) => error instanceof FinopsPermissionPlanError && error.code === "COLLECTOR_NOT_READ_ONLY",
    );
    assert.throws(
      () => assertFinopsCollectorReadOnly([{ sid: "bad", effect: "Allow", actions: ["s3:PutObject"], resources: ["arn:aws:s3:::bucket/object"] }]),
      (error) => error instanceof FinopsPermissionPlanError && error.code === "COLLECTOR_NOT_READ_ONLY",
    );
    assert.throws(
      () => assertFinopsCollectorReadOnly([{ sid: "bad", effect: "Allow", actions: ["ce:GetAnomalies"], resources: ["*"] }]),
      (error) => error instanceof FinopsPermissionPlanError && error.code === "COLLECTOR_NOT_READ_ONLY",
    );
    assert.doesNotThrow(
      () => assertFinopsCollectorReadOnly([{
        sid: "global-read",
        effect: "Allow",
        actions: ["ce:GetAnomalies"],
        resources: ["*"],
        resourceScopeReason: "service_does_not_support_resource_level_permissions",
      }]),
    );
  });

  it("rejects expired, future, duplicate, or long-lived write approvals", () => {
    const approvals = [
      {
        capability: "manage_aws_budgets" as const,
        approvedBy: "owner",
        approvedAtIso: "2026-07-01T00:00:00.000Z",
        expiresAtIso: "2026-07-30T00:00:00.000Z",
        changeTicket: "CHG-1",
      },
      {
        capability: "manage_aws_budgets" as const,
        approvedBy: "owner",
        approvedAtIso: "2026-08-01T00:00:00.000Z",
        expiresAtIso: "2026-08-02T00:00:00.000Z",
        changeTicket: "CHG-2",
      },
    ];
    for (const approval of approvals) {
      assert.throws(
        () => buildFinopsPermissionPlan({ ...BASE, actionApprovals: [approval] }),
        (error) => error instanceof FinopsPermissionPlanError && error.code === "INVALID_APPROVAL",
      );
    }
  });

  it("rejects unsafe, bucket-wide, or traversal-prone export prefixes", () => {
    for (const exportKeyPrefix of ["", "/", "../exports/", "exports//cur/", "exports"]) {
      assert.throws(
        () => buildFinopsPermissionPlan({ ...BASE, exportKeyPrefix }),
        (error) => error instanceof FinopsPermissionPlanError && error.code === "INVALID_INPUT",
      );
    }
  });

  it("requires exact tenant-authorized Amazon Connect instance ARNs", () => {
    assert.throws(
      () => buildFinopsPermissionPlan({
        ...BASE,
        amazonConnectInstanceArns: [],
      }),
      (error) =>
        error instanceof FinopsPermissionPlanError
        && error.code === "INVALID_INPUT",
    );
    assert.throws(
      () => buildFinopsPermissionPlan({
        ...BASE,
        amazonConnectInstanceArns: [
          "arn:aws:connect:us-east-1:999999999999:instance/11111111-2222-3333-4444-555555555555",
        ],
      }),
      (error) =>
        error instanceof FinopsPermissionPlanError
        && error.code === "INVALID_INPUT",
    );
  });

  it("requires an exact tenant-registered AWS Config aggregator ARN", () => {
    assert.throws(
      () => buildFinopsPermissionPlan({
        ...BASE,
        awsConfigAggregatorArn: undefined,
      }),
      (error) =>
        error instanceof FinopsPermissionPlanError
        && error.code === "INVALID_INPUT",
    );
    assert.throws(
      () => buildFinopsPermissionPlan({
        ...BASE,
        awsConfigAggregatorArn:
          "arn:aws:config:us-east-1:999999999999:config-aggregator/substituted",
      }),
      (error) =>
        error instanceof FinopsPermissionPlanError
        && error.code === "INVALID_INPUT",
    );
  });

  it("requires exact post-provisioning Data Export and table ARNs", () => {
    assert.throws(
      () => buildFinopsPermissionPlan({
        ...BASE,
        authorizedDataExportArns: [],
      }),
      (error) =>
        error instanceof FinopsPermissionPlanError
        && error.code === "INVALID_INPUT",
    );
    assert.throws(
      () => buildFinopsPermissionPlan({
        ...BASE,
        authorizedDataExportTableArns: [
          "arn:aws:bcm-data-exports:us-east-1:999999999999:table/CUR2_0",
        ],
      }),
      (error) =>
        error instanceof FinopsPermissionPlanError
        && error.code === "INVALID_INPUT",
    );
  });
});
