import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const template = readFileSync(
  new URL("../infrastructure/production-ha.yaml", import.meta.url),
  "utf8",
);
const workflow = readFileSync(
  new URL("../.github/workflows/production-ha-release.yml", import.meta.url),
  "utf8",
);
const bootstrapWorkflow = readFileSync(
  new URL("../.github/workflows/production-ha-bootstrap.yml", import.meta.url),
  "utf8",
);
const bootstrapScript = readFileSync(
  new URL("../deploy/production/bootstrap-ha.sh", import.meta.url),
  "utf8",
);
const runtimeSecretValidator = readFileSync(
  new URL("../scripts/validate-production-runtime-secret.mjs", import.meta.url),
  "utf8",
);
const appEntrypoint = readFileSync(
  new URL("../deploy/production/entrypoint.sh", import.meta.url),
  "utf8",
);
const workerEntrypoint = readFileSync(
  new URL("../services/notification-worker/production-entrypoint.mjs", import.meta.url),
  "utf8",
);
const productionMigrator = readFileSync(
  new URL("../deploy/production/migrate.mjs", import.meta.url),
  "utf8",
);
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const workerDockerfile = readFileSync(
  new URL("../services/notification-worker/Dockerfile", import.meta.url),
  "utf8",
);
const productionJobRunner = readFileSync(
  new URL("../scripts/production-job-runner.mjs", import.meta.url),
  "utf8",
);
const appTaskDefinition = template.slice(
  template.indexOf("  AppTaskDefinition:"),
  template.indexOf("  MigrationTaskDefinition:"),
);

test("managed production is a separate multi-AZ ECS and RDS topology", () => {
  assert.match(template, /legacy single-node private-beta stack is intentionally separate/u);
  assert.doesNotMatch(template, /Type:\s+AWS::EC2::Instance(?:\s|$)/u);
  assert.match(template, /Type:\s+AWS::ElasticLoadBalancingV2::LoadBalancer/u);
  assert.match(template, /Scheme:\s+internet-facing/u);
  assert.match(template, /Type:\s+AWS::ECS::Service/gu);
  assert.match(template, /ServiceName:\s+sutra-production-app/u);
  assert.match(template, /ServiceName:\s+sutra-production-worker/u);
  assert.match(template, /ServiceName:\s+sutra-production-broker/u);
  assert.match(template, /MinimumTaskCount:[\s\S]*?MinValue:\s+2/u);
  assert.match(template, /MinimumWorkerTaskCount:[\s\S]*?MinValue:\s+2/u);
  assert.match(template, /MinimumBrokerTaskCount:[\s\S]*?MinValue:\s+2/u);
  assert.match(
    template,
    /ReleaseActivation:[\s\S]*?Default:\s+inactive-before-first-migration/u,
  );
  assert.match(
    template,
    /ProductionActivated:\s+!Equals \[!Ref ReleaseActivation, active-after-successful-migration\]/u,
  );
  assert.match(template, /Type:\s+AWS::CloudFormation::WaitConditionHandle/u);
  assert.match(
    template,
    /ActivationVerification:[\s\S]*?Type:\s+AWS::CloudFormation::WaitCondition[\s\S]*?Timeout:\s+"1800"/u,
  );
  assert.equal(
    [...template.matchAll(
      /DesiredCount:\s+!If \[ProductionActivated, !Ref Minimum(?:Worker|Broker)?TaskCount, 0\]/gu,
    )].length,
    3,
  );
  assert.match(template, /AvailabilityZoneRebalancing:\s+ENABLED/gu);
  assert.match(template, /Type:\s+AWS::ApplicationAutoScaling::ScalableTarget/gu);
  assert.match(template, /Type:\s+AWS::RDS::DBInstance/u);
  assert.match(template, /MultiAZ:\s+true/u);
  assert.match(template, /PubliclyAccessible:\s+false/u);
  assert.match(template, /DeletionProtection:\s+true/u);
  assert.match(template, /BackupRetentionPeriod:\s+!Ref DatabaseBackupRetentionDays/u);
  assert.match(template, /PrivateDatabaseSubnetIds/u);
});

test("managed production fails closed around ingress, health, secrets, and immutable images", () => {
  assert.match(template, /SourcePrefixListId:\s+!Ref AlbIngressPrefixListId/u);
  assert.match(
    template,
    /NetworkFirewallArn:[\s\S]*?firewall\/sutra-production-egress-inspection/u,
  );
  assert.match(
    template,
    /Action: network-firewall:DescribeFirewall\s*\n\s+Resource: !Ref NetworkFirewallArn/u,
  );
  assert.equal(
    [...template.matchAll(
      /DestinationPrefixListId:\s+!Ref ApprovedHttpsEgressPrefixListId/gu,
    )].length,
    3,
  );
  assert.equal(
    [...template.matchAll(
      /DestinationSecurityGroupId:\s+!Ref EndpointSecurityGroupId/gu,
    )].length,
    4,
  );
  assert.equal(
    [...template.matchAll(
      /DestinationPrefixListId:\s+!Ref S3GatewayPrefixListId/gu,
    )].length,
    4,
  );
  assert.equal(
    [...template.matchAll(/CidrIp:\s+0\.0\.0\.0\/0/gu)].length,
    1,
  );
  const brokerSecurityGroup = template.slice(
    template.indexOf("  BrokerSecurityGroup:"),
    template.indexOf("  VulnerabilityFeedSecurityGroup:"),
  );
  assert.match(
    brokerSecurityGroup,
    /IpProtocol:\s+tcp[\s\S]*?FromPort:\s+443[\s\S]*?ToPort:\s+443[\s\S]*?CidrIp:\s+0\.0\.0\.0\/0/u,
  );
  assert.match(
    brokerSecurityGroup,
    /strict L7 Network Firewall for \.amazonaws\.com/u,
  );
  for (const [start, end] of [
    ["  ApplicationSecurityGroup:", "  WorkerSecurityGroup:"],
    ["  WorkerSecurityGroup:", "  BrokerSecurityGroup:"],
    ["  VulnerabilityFeedSecurityGroup:", "  AlbIngressFromApprovedEdge:"],
  ]) {
    const securityGroup = template.slice(
      template.indexOf(start),
      template.indexOf(end),
    );
    assert.doesNotMatch(securityGroup, /CidrIp:\s+0\.0\.0\.0\/0/u);
  }
  assert.doesNotMatch(template, /SUTRA_NOTIFICATION_SECRET_PREFIX/u);
  assert.match(template, /SUTRA_NOTIFICATION_CONFIG_PREFIX/u);
  const ingressResources = [...template.matchAll(
    /\n  [A-Za-z0-9]+:\n    Type: AWS::EC2::SecurityGroupIngress\n([\s\S]*?)(?=\n  [A-Za-z0-9]+:\n    Type:|\nOutputs:)/gu,
  )].map((match) => match[0]);
  assert.ok(ingressResources.length >= 3);
  for (const ingress of ingressResources) assert.doesNotMatch(ingress, /CidrIp:\s+0\.0\.0\.0\/0/u);
  assert.match(template, /HealthCheckPath:\s+\/api\/healthz/u);
  assert.match(template, /ReadonlyRootFilesystem:\s+true/gu);
  assert.match(template, /AssignPublicIp:\s+DISABLED/gu);
  assert.match(template, /ApplicationRuntimeSecretArn/u);
  assert.match(
    template,
    /ApplicationRuntimeSecretVersionId:[\s\S]*?AllowedPattern: \^\[A-Za-z0-9-\]\{32,64\}\$/u,
  );
  const runtimeSecretReferences = [
    ...template.matchAll(
      /ApplicationRuntimeSecretArn\}:[A-Z0-9_]+::\$\{ApplicationRuntimeSecretVersionId\}/gu,
    ),
  ];
  assert.ok(runtimeSecretReferences.length > 0);
  assert.doesNotMatch(
    template,
    /ApplicationRuntimeSecretArn\}:[A-Z0-9_]+::"/u,
  );
  assert.match(template, /secretsmanager:GetSecretValue/u);
  assert.match(template, /kms:ViaService/u);
  assert.match(template, /sutra\/app@sha256:\[a-f0-9\]\{64\}/u);
  assert.match(template, /sutra\/notification-worker@sha256:\[a-f0-9\]\{64\}/u);
  assert.match(template, /sutra\/broker@sha256:\[a-f0-9\]\{64\}/u);
  assert.match(template, /sutra\/agentless-scanner@sha256:\[a-f0-9\]\{64\}/u);
  assert.match(template, /Scheme:\s+internal/u);
  assert.match(template, /HealthCheckPath:\s+\/readyz/u);
  assert.match(template, /SUTRA_BROKER_AUTH_MODE, Value: asymmetric/u);
  assert.match(template, /SUTRA_APP_PUBLIC_KEYS/u);
  assert.match(template, /SUTRA_BROKER_RESPONSE_PRIVATE_KEY/u);
  assert.doesNotMatch(template, /Name: SUTRA_BROKER_PUBLIC_KEYS/u);
  assert.doesNotMatch(appEntrypoint, /^SUTRA_BROKER_PUBLIC_KEYS$/mu);
  assert.equal(
    [...template.matchAll(/idle_timeout\.timeout_seconds, Value: "360"/gu)].length,
    2,
  );
  assert.doesNotMatch(template, /Image:\s+[^\n]+:(?:latest|main|production)(?:\s|$)/u);
  assert.match(appEntrypoint, /sslmode/u);
  assert.match(appEntrypoint, /SUTRA_HOSTED_SELF_SERVE_SIGNUP=false/u);
  assert.match(appEntrypoint, /SUTRA_WEB_HOST=0\.0\.0\.0/u);
  assert.match(appEntrypoint, /SUTRA_CONTACT_PROVIDER=zoho/u);
  assert.match(appEntrypoint, /SUTRA_INVITATION_EMAIL_PROVIDER=zoho/u);
  assert.match(appEntrypoint, /SUTRA_ZOHO_REFRESH_TOKEN/u);
  assert.doesNotMatch(appEntrypoint, /resend/iu);
  assert.match(appEntrypoint, /SUTRA_NOTIFICATION_WORKER_CONFIGURED=true/u);
  assert.match(appTaskDefinition, /Name: background-job-runner/u);
  assert.match(appTaskDefinition, /EntryPoint: \[node, \/app\/scripts\/production-job-runner\.mjs\]/u);
  assert.match(appTaskDefinition, /ContainerName: app, Condition: HEALTHY/u);
  assert.match(appTaskDefinition, /SUTRA_JOB_RUNNER_TOKEN/u);
  assert.match(appTaskDefinition, /Name: SUTRA_JOB_RUNNER_SELF_TICK, Value: "false"/u);
  assert.match(template, /DenyPublicInternalApiRule:[\s\S]*?Values: \["\/api\/internal\/\*"\][\s\S]*?StatusCode: "404"/u);
  assert.match(productionJobRunner, /postInternalJobRun/u);
  assert.match(productionJobRunner, /port: 3000/u);
  assert.match(productionJobRunner, /timeoutMs: 20 \* 60_000/u);
  assert.doesNotMatch(productionJobRunner, /https?:\/\/(?:www\.)?sutracmdb/u);
  assert.match(appEntrypoint, /SUTRA_JOB_RUNNER_SELF_TICK=false/u);
  assert.doesNotMatch(appTaskDefinition, /Name: SUTRA_AGENTLESS_/u);
  assert.doesNotMatch(appEntrypoint, /^SUTRA_AGENTLESS_/mu);
  assert.match(appEntrypoint, /SUTRA_IDENTITY_MODE" in/u);
  assert.match(appEntrypoint, /oidc\)/u);
  assert.match(appEntrypoint, /federated\)/u);
  assert.match(appEntrypoint, /\[ "\$SUTRA_IDENTITY_MODE" = "federated" \]/u);
  assert.match(template, /IdentityMode:[\s\S]*?AllowedValues: \[oidc, federated\]/u);
  assert.match(template, /HostedRuntimeArchitectureApproval:[\s\S]*?approved-after-stateless-hosted-broker-cutover/u);
  assert.match(template, /FederatedIdentityEnabled: !Equals \[!Ref IdentityMode, federated\]/u);
  assert.match(template, /Name: SUTRA_OIDC_PROVIDERS/u);
  assert.match(template, /Name: SUTRA_SAML_PROVIDERS/u);
  assert.match(template, /Name: SUTRA_SAML_TRANSACTION_KEY/u);
  assert.match(workerEntrypoint, /searchParams\.set\("sslmode", "require"\)/u);
  assert.match(dockerfile, /deploy\/production/u);
  assert.match(workerDockerfile, /production-entrypoint\.mjs/u);
});

test("application task manages only tagged ITSM credentials in its production namespace", () => {
  assert.match(template, /ManageOnlyTenantScopedItsmCredentials/u);
  assert.match(template, /sutra\/production\/itsm\/\*/u);
  assert.match(template, /secretsmanager:CreateSecret/u);
  assert.match(template, /secretsmanager:GetSecretValue/u);
  assert.doesNotMatch(template, /secretsmanager:PutSecretValue/u);
  assert.match(template, /secretsmanager:DeleteSecret/u);
  assert.match(template, /secretsmanager:DescribeSecret/u);
  assert.match(template, /aws:RequestTag\/sutra:purpose: itsm-hmac/u);
  assert.match(template, /secretsmanager:ResourceTag\/sutra:purpose: itsm-hmac/u);
  assert.match(template, /SUTRA_ITSM_SECRET_BACKEND/u);
  assert.match(template, /SUTRA_ITSM_SECRET_KMS_KEY_ARN/u);
  assert.doesNotMatch(template, /Action: secretsmanager:\*/u);
  assert.match(productionMigrator, /SET shared_secret = '', enabled = 0/u);
  assert.match(productionMigrator, /secret_storage = 'local'/u);
  assert.match(productionMigrator, /source_kind = 'simulated_fixture'/u);
  assert.match(productionMigrator, /Production migration refused/u);
});

test("EPSS bulk refresh is a strict private daily task on the released app digest", () => {
  const feedTask = template.slice(
    template.indexOf("  VulnerabilityFeedTaskDefinition:"),
    template.indexOf("  MigrationTaskDefinition:"),
  );
  const feedRole = template.slice(
    template.indexOf("  VulnerabilityFeedExecutionRole:"),
    template.indexOf("  MigrationExecutionRole:"),
  );
  assert.match(feedTask, /Family: sutra-production-vulnerability-feed/u);
  assert.match(feedTask, /Image: !Ref SutraAppImage/u);
  assert.match(feedTask, /Name: SUTRA_VULN_FEED_STRICT, Value: "true"/u);
  assert.match(feedTask, /\/usr\/bin\/timeout/u);
  assert.match(feedTask, /1800s/u);
  assert.match(feedTask, /ReadonlyRootFilesystem: true/u);
  assert.match(feedTask, /SUTRA_DB_APP_PASSWORD/u);
  for (const key of [
    "SUTRA_MANAGED_OUTBOUND_URL",
    "SUTRA_MANAGED_OUTBOUND_KEY_ID",
    "SUTRA_MANAGED_OUTBOUND_PRIVATE_KEY",
  ]) {
    assert.match(feedTask, new RegExp(`Name: ${key}`, "u"));
  }
  assert.doesNotMatch(feedTask, /TaskRoleArn/u, "feed task needs no AWS application privileges");
  assert.match(feedRole, /- !Ref DatabaseRuntimeSecret/u);
  assert.match(feedRole, /- !Ref ApplicationRuntimeSecretArn/u);
  assert.match(template, /Name: sutra-production-vulnerability-feed/u);
  assert.match(template, /ScheduleExpression: cron\(30 3 \* \* \? \*\)/u);
  assert.match(template, /State: !If \[ProductionActivated, ENABLED, DISABLED\]/u);
  assert.match(template, /AssignPublicIp: DISABLED/u);
  assert.match(template, /SecurityGroups: \[!Ref VulnerabilityFeedSecurityGroup\]/u);
  assert.match(template, /sutra-production-vulnerability-feed:\*/u);
  assert.match(template, /VulnerabilityFeedTaskDefinitionArn/u);
  assert.match(template, /VulnerabilityFeedScheduleRuleName/u);
});

test("backup, evidence, edge protection, and observability are explicit", () => {
  assert.match(template, /Type:\s+AWS::Backup::BackupVault/u);
  assert.match(template, /EnableContinuousBackup:\s+true/u);
  assert.match(template, /LockConfiguration:\s+!If/u);
  assert.match(template, /BackupVaultLockEnabled/u);
  assert.match(template, /Type:\s+AWS::S3::Bucket/u);
  assert.match(template, /DeletionPolicy:\s+Retain/gu);
  assert.match(template, /SSEAlgorithm:\s+aws:kms/u);
  assert.match(template, /VersioningConfiguration:\s+\{ Status: Enabled \}/u);
  assert.match(template, /Type:\s+AWS::WAFv2::WebACL/u);
  assert.match(template, /AWSManagedRulesCommonRuleSet/u);
  assert.match(template, /PerIpRateLimit/u);
  assert.match(template, /AggregateKeyType:\s+FORWARDED_IP/u);
  assert.match(template, /HeaderName:\s+!Ref WafClientIpHeader/u);
  assert.match(template, /Type:\s+AWS::WAFv2::LoggingConfiguration/u);
  assert.match(template, /access_logs\.s3\.enabled/u);
  assert.match(
    template,
    /^(?:[\s\S]*logdelivery\.elasticloadbalancing\.amazonaws\.com[\s\S]*)$/u,
  );
  assert.match(template, /Type:\s+AWS::CloudWatch::Alarm/gu);
  assert.match(template, /ContainerInsightsEnabled/u);
  assert.match(template, /KmsKeyId:\s+!Ref KmsKeyArn/u);
});

test("one protected workflow releases all four digests with migration, rollback, and evidence", () => {
  assert.match(workflow, /environment:\s+production-ha-release/u);
  assert.match(workflow, /id-token:\s+write/u);
  assert.match(workflow, /workflow_dispatch/u);
  assert.match(workflow, /changeTicket/u);
  assert.match(workflow, /actions:\s+read/u);
  assert.match(workflow, /CODEQL_ENABLED/u);
  assert.match(workflow, /aws ec2 describe-managed-prefix-lists/u);
  assert.match(workflow, /\[\[ "\$\{owner\}" == "AWS" \]\]/u);
  assert.match(workflow, /com\.amazonaws\.\$\{AWS_REGION\}\.s3/u);
  assert.match(workflow, /aws network-firewall describe-firewall/u);
  assert.match(workflow, /\.Firewall\.DeleteProtection == true/u);
  assert.match(workflow, /\.Firewall\.FirewallPolicyChangeProtection == true/u);
  assert.match(workflow, /\.Firewall\.SubnetChangeProtection == true/u);
  assert.match(
    workflow,
    /output ReleaseActivation\)" == "active-after-successful-migration"/u,
  );
  assert.match(workflow, /actions\/workflows\/codeql\.yml\/runs\?head_sha=\$\{GITHUB_SHA\}/u);
  assert.match(workflow, /\.head_sha == \$sha/u);
  assert.match(workflow, /\.conclusion == "success"/u);
  assert.match(workflow, /--provenance=mode=max/gu);
  assert.match(workflow, /--sbom=true/gu);
  assert.match(workflow, /Scan the exact application digest/u);
  assert.match(workflow, /Scan the exact worker digest/u);
  assert.match(workflow, /Scan the exact broker digest/u);
  assert.match(workflow, /Scan the exact scanner digest including unfixed findings/u);
  assert.match(
    workflow,
    /image-ref: \$\{\{ steps\.scanner\.outputs\.ref \}\}[\s\S]*?trivyignores: \/dev\/null[\s\S]*?ignore-unfixed: false/u,
  );
  assert.match(workflow, /BROKER_ECR_REPOSITORY:\s+sutra\/broker/u);
  assert.match(workflow, /SCANNER_ECR_REPOSITORY:\s+sutra\/agentless-scanner/u);
  assert.equal(
    [...workflow.matchAll(/docker buildx build/gu)].length,
    4,
    "app, worker, broker, and scanner must each be built exactly once",
  );
  assert.match(workflow, /Promote only the scanned manifests/u);
  const promote = workflow.indexOf("Promote only the scanned manifests");
  const migrate = workflow.indexOf("migration_task=");
  const update = workflow.indexOf("aws ecs update-service");
  const verify = workflow.indexOf("x-sutra-release-image:");
  const evidence = workflow.indexOf("aws s3api put-object");
  const rollback = workflow.indexOf('if [[ "${deployed}" != "true" ]]');
  assert.ok(
    promote > 0 && promote < migrate && migrate < update &&
      update < verify && verify < evidence && evidence < rollback,
  );
  assert.match(workflow, /previous_app/u);
  assert.match(workflow, /previous_worker/u);
  assert.match(workflow, /previous_broker/u);
  assert.match(workflow, /previous_scanner/u);
  assert.match(workflow, /register_revision \\\s*\n\s+"\$\{previous_app\}"/u);
  assert.match(workflow, /register_revision \\\s*\n\s+"\$\{previous_worker\}"/u);
  assert.match(workflow, /register_revision \\\s*\n\s+"\$\{previous_broker\}"/u);
  assert.match(workflow, /register_revision \\\s*\n\s+"\$\{previous_feed\}"/u);
  assert.match(workflow, /'\["app","background-job-runner"\]'\s+true/u);
  assert.match(workflow, /SUTRA_RELEASE_IMAGE/u);
  assert.match(workflow, /releaseIdentityCount != 1/u);
  assert.match(workflow, /SUTRA_AGENTLESS_SCANNER_IMAGE/u);
  assert.match(workflow, /scannerIdentityCount != 1/u);
  assert.match(
    workflow,
    /--arg runtimeSecretVersion "\$\{runtime_secret_version_id\}"/u,
  );
  assert.match(
    workflow,
    /sub\(\s*"::\[A-Za-z0-9-\]\*\$";\s*"::" \+ \$runtimeSecretVersion\s*\)/u,
  );
  assert.match(workflow, /expectsRuntimeSecret/u);
  assert.match(
    workflow,
    /select\(\(\.name \| startswith\("SUTRA_DB_"\)\) \| not\)/u,
  );
  assert.match(workflow, /unpinned application runtime secret/u);
  assert.equal(
    [...workflow.matchAll(
      /assert_task_runtime_secret_version "\$\{new_(?:app|worker|broker|feed)\}"/gu,
    )].length,
    4,
  );
  assert.match(workflow, /prior scanner digest were restored/u);
  assert.match(workflow, /restored_broker/u);
  assert.match(workflow, /brokerImage/u);
  assert.match(workflow, /scannerImage/u);
  assert.match(workflow, /previousScannerImage/u);
  assert.match(workflow, /brokerTask/u);
  assert.match(workflow, /feedTask/u);
  assert.match(workflow, /events put-targets/u);
  assert.match(workflow, /previous-feed-target\.json/u);
  assert.match(workflow, /rollback-feed-targets\.json/u);
  assert.match(workflow, /server-side-encryption aws:kms/u);
  assert.match(workflow, /--checksum-algorithm SHA256/u);
  assert.match(workflow, /\.ChecksumSHA256/u);
  assert.match(
    workflow,
    /if \[\[ "\$\{deployment_verified\}" == "true" \]\] && write_release_evidence; then/u,
  );
  assert.match(workflow, /> release-evidence\.json \|\| return 1/u);
  assert.doesNotMatch(workflow, /access-key-id|secret-access-key/iu);
});

test("first deployment builds once and remains dormant until migration and separate activation approval", () => {
  assert.match(bootstrapWorkflow, /environment:\s+production-ha-bootstrap/u);
  assert.match(bootstrapWorkflow, /environment:\s+production-ha-activation/u);
  assert.match(bootstrapWorkflow, /id-token:\s+write/gu);
  assert.ok(bootstrapWorkflow.includes('GITHUB_REF}" == "refs/heads/main"'));
  assert.match(
    bootstrapWorkflow,
    /actions\/workflows\/codeql\.yml\/runs\?head_sha=\$\{GITHUB_SHA\}/u,
  );
  assert.equal(
    [...bootstrapWorkflow.matchAll(/docker buildx build/gu)].length,
    4,
    "app, worker, broker, and scanner must each be built exactly once",
  );
  assert.equal(
    [...bootstrapWorkflow.matchAll(/uses:\s+aquasecurity\/trivy-action@/gu)].length,
    4,
  );
  assert.match(bootstrapWorkflow, /pnpm build:agentless-scanner/u);
  assert.match(
    bootstrapWorkflow,
    /Scan the exact scanner digest including unfixed findings[\s\S]*?trivyignores: \/dev\/null[\s\S]*?ignore-unfixed: false/u,
  );
  assert.doesNotMatch(bootstrapWorkflow, /bootstrap-candidate-/u);
  assert.match(bootstrapWorkflow, /Promote only the scanned manifests/u);
  assert.match(bootstrapWorkflow, /bootstrap-ha\.sh prepare/u);
  assert.match(bootstrapWorkflow, /bootstrap-ha\.sh activate/u);
  assert.match(
    bootstrapWorkflow,
    /CFN_TEMPLATE_BUCKET[\s\S]*?sutra-production-ha-bootstrap-templates-\$\{AWS_ACCOUNT_ID\}-\$\{AWS_REGION\}/u,
  );
  assert.equal(
    (
      bootstrapWorkflow.match(
        /\[\[ "\$\{PUBLIC_ORIGIN\}" == "https:\/\/www\.sutracmdb\.com" \]\]/gu,
      ) ?? []
    ).length,
    2,
  );
  assert.match(
    bootstrapScript,
    /\[\[ "\$\{PUBLIC_ORIGIN\}" == "https:\/\/www\.sutracmdb\.com" \]\]/u,
  );
  assert.doesNotMatch(bootstrapWorkflow, /access-key-id|secret-access-key/iu);

  assert.match(
    bootstrapScript,
    /prepare\(\) \{[\s\S]*?assert_inactive[\s\S]*?run_migration[\s\S]*?assert_inactive[\s\S]*?\n\}/u,
  );
  assert.match(
    bootstrapScript,
    /activate\(\) \{[\s\S]*?verify_migration_result[\s\S]*?begin_activation[\s\S]*?verify_active_services[\s\S]*?signal_activation SUCCESS[\s\S]*?write_activation_evidence[\s\S]*?\n\}/u,
  );
  assert.match(bootstrapScript, /ReleaseActivation/u);
  assert.match(bootstrapScript, /desiredCount == 0/u);
  assert.match(bootstrapScript, /State --output text\)" == "DISABLED"/u);
  assert.match(bootstrapScript, /\.desiredCount >= 2/u);
  assert.match(bootstrapScript, /x-sutra-release-image:/u);
  assert.match(bootstrapScript, /SUTRA_AGENTLESS_SCANNER_IMAGE/u);
  assert.match(bootstrapScript, /aws network-firewall describe-firewall/u);
  assert.match(bootstrapScript, /\.Firewall\.DeleteProtection == true/u);
  assert.match(
    bootstrapScript,
    /all\(\.FirewallStatus\.SyncStates\[\]; \.Attachment\.Status == "READY"\)/u,
  );
  assert.match(bootstrapScript, /--arg scannerImage "\$\{SCANNER_IMAGE\}"/u);
  assert.match(
    bootstrapScript,
    /and \(has\("AgentlessScannerImage"\) \| not\)/u,
  );
  assert.match(bootstrapScript, /AgentlessScannerImage:env\.SCANNER_IMAGE/u);
  assert.match(bootstrapScript, /aws secretsmanager get-secret-value/u);
  assert.match(
    bootstrapScript,
    /--version-id "\$\{version_id\}"[\s\S]*--version-stage AWSCURRENT/u,
  );
  assert.match(bootstrapScript, /RUNTIME_SECRET_VERSION_ID="\$\{version_id\}"/u);
  assert.match(bootstrapWorkflow, /runtime_secret_version_id/u);
  assert.match(
    bootstrapScript,
    /and \(has\("ApplicationRuntimeSecretVersionId"\) \| not\)/u,
  );
  assert.match(
    bootstrapScript,
    /--arg runtimeSecretVersion "\$\{RUNTIME_SECRET_VERSION_ID\}"/u,
  );
  assert.match(
    bootstrapScript,
    /ApplicationRuntimeSecretVersionId:\$runtimeSecretVersion/u,
  );
  assert.match(
    bootstrapScript,
    /stack_parameter ApplicationRuntimeSecretVersionId\)" == "\$\{RUNTIME_SECRET_VERSION_ID\}"/u,
  );
  assert.match(bootstrapScript, /assert_task_runtime_secret_version/u);
  assert.match(
    bootstrapScript,
    /select\(\(\.name \| startswith\("SUTRA_DB_"\)\) \| not\)/u,
  );
  const prepareFunction = bootstrapScript.slice(
    bootstrapScript.indexOf("prepare() {"),
    bootstrapScript.indexOf("rollback_activation()"),
  );
  assert.ok(
    prepareFunction.indexOf("validate_runtime_secret") <
      prepareFunction.indexOf("prepare_stack_parameters"),
    "semantic validation must produce the pinned version before parameter creation",
  );
  assert.match(
    bootstrapScript,
    /validate_runtime_secret "\$\{RUNTIME_SECRET_VERSION_ID\}"[\s\S]*run_migration/u,
  );
  assert.match(
    bootstrapScript,
    /activate\(\)[\s\S]*validate_runtime_secret "\$\{RUNTIME_SECRET_VERSION_ID\}"[\s\S]*verify_migration_result/u,
  );
  assert.match(bootstrapScript, /aws s3api put-object/u);
  assert.match(bootstrapScript, /--checksum-algorithm SHA256/u);
  assert.match(bootstrapScript, /\.ChecksumSHA256/u);
  assert.match(bootstrapScript, /--template-url "\$\{TEMPLATE_URL\}"/u);
  assert.doesNotMatch(bootstrapScript, /--template-body/u);
  assert.match(bootstrapScript, /node scripts\/validate-production-runtime-secret\.mjs/u);
  assert.match(runtimeSecretValidator, /SUTRA_MANAGED_OUTBOUND_URL/u);
  assert.match(runtimeSecretValidator, /SUTRA_MANAGED_OUTBOUND_APP_KEY_ID/u);
  assert.match(runtimeSecretValidator, /SUTRA_MANAGED_OUTBOUND_WORKER_KEY_ID/u);
  assert.match(runtimeSecretValidator, /SUTRA_MANAGED_OUTBOUND_FEED_KEY_ID/u);
  assert.match(runtimeSecretValidator, /SUTRA_MANAGED_OUTBOUND_APP_PRIVATE_KEY/u);
  assert.match(runtimeSecretValidator, /SUTRA_MANAGED_OUTBOUND_WORKER_PRIVATE_KEY/u);
  assert.match(runtimeSecretValidator, /SUTRA_MANAGED_OUTBOUND_FEED_PRIVATE_KEY/u);
  assert.match(
    runtimeSecretValidator,
    /SUTRA_MANAGED_OUTBOUND_URL !== "https:\/\/outbound\.sutracmdb\.com"/u,
  );
  assert.match(runtimeSecretValidator, /createPrivateKey/u);
  assert.match(runtimeSecretValidator, /createPublicKey/u);
  assert.match(runtimeSecretValidator, /new Set\(allKeyIds\)\.size/u);
  assert.match(runtimeSecretValidator, /new Set\(allPrivateSources\)\.size/u);
  assert.match(
    bootstrapScript,
    /--query SecretString\s+\\\n\s+--output text \|\s*\n\s+SUTRA_EXPECTED_IDENTITY_MODE=/u,
  );
  assert.doesNotMatch(
    bootstrapScript,
    /--arg(?:json)?\s+(?:url|keyId|privateKey)\s+"\$\{SUTRA_MANAGED_OUTBOUND_/u,
  );
  assert.match(
    bootstrapScript,
    /Activation failed; returning[\s\S]*update_phase "\$\{INACTIVE\}"[\s\S]*assert_exact_images[\s\S]*assert_inactive/u,
  );
  assert.match(bootstrapScript, /signal_activation FAILURE/u);
  assert.match(bootstrapScript, /trap 'exit 130' INT/u);
  assert.doesNotMatch(
    bootstrapScript,
    /--argjson\s+supplied\s+"\$\{PRODUCTION_HA_PARAMETERS_JSON\}"/u,
  );
  assert.match(bootstrapScript, /--enable-termination-protection/u);
  assert.match(bootstrapScript, /--server-side-encryption aws:kms/u);
  assert.match(bootstrapScript, /"CustomerRoleTemplateUrl"/u);
  assert.match(bootstrapScript, /standard-2026-07\.4/u);
  assert.match(bootstrapScript, /versionId=/u);
  assert.match(bootstrapScript, /endswith\("\?versionId=null"\)/u);
  assert.match(template, /CustomerRoleTemplateUrl:/u);
  assert.match(template, /versionId=\(\?!null\$\)/u);
  assert.match(appTaskDefinition, /Name: SUTRA_CUSTOMER_ROLE_TEMPLATE_URL/u);
  assert.match(appEntrypoint, /^SUTRA_CUSTOMER_ROLE_TEMPLATE_URL$/mu);
  assert.match(workflow, /!= \*"\?versionId=null"/u);
});

test("release IAM is protected by the exact GitHub environment and exact services", () => {
  assert.match(template, /environment:\$\{GitHubReleaseEnvironment\}/u);
  assert.match(template, /Action:\s+sts:AssumeRoleWithWebIdentity/u);
  assert.match(template, /Action:\s+ec2:DescribeManagedPrefixLists/u);
  assert.match(template, /Resource:\s*\n\s+- !Ref AppService\s*\n\s+- !Ref WorkerService\s*\n\s+- !Ref BrokerService/u);
  assert.match(template, /sutra-production-migration:\*/u);
  assert.match(template, /sutra-production-vulnerability-feed:\*/u);
  assert.match(template, /events:PutTargets/u);
  assert.match(template, /iam:PassedToService:\s+events\.amazonaws\.com/u);
  assert.match(template, /ecr:GetLifecyclePolicy/u);
  assert.match(template, /repository\/\$\{ScannerRepositoryName\}/u);
  assert.match(template, /Sid:\s+TagOnlyProductionTaskRevision/u);
  assert.match(template, /ecs:cluster:\s+!GetAtt Cluster\.Arn/u);
  assert.match(template, /iam:PassedToService:\s+ecs-tasks\.amazonaws\.com/u);
  assert.match(template, /Resource:\s+!Sub "\$\{EvidenceBucket\.Arn\}\/releases\/\*"/u);
  assert.match(template, /ReadExactRuntimeSecretForReleasePreflight/u);
  assert.match(workflow, /validate-production-runtime-secret\.mjs/u);
});

test("SES feedback is encrypted, observable, least-privilege, and fail-closed", () => {
  assert.match(
    template,
    /NotificationSesActivation:[\s\S]*Default:\s+disabled-ses-production-access-denied/u,
  );
  assert.match(
    template,
    /SesNotificationsActivated:\s+!Equals \[!Ref NotificationSesActivation, active-after-production-access-and-feedback-validation\]/u,
  );
  assert.match(template, /Type:\s+AWS::SES::ConfigurationSet/u);
  assert.match(template, /SendingEnabled:\s+!If \[SesNotificationsActivated, true, false\]/u);
  assert.match(template, /Type:\s+AWS::SES::ConfigurationSetEventDestination/u);
  assert.match(
    template,
    /EventBusArn:\s+!Sub arn:\$\{AWS::Partition\}:events:\$\{AWS::Region\}:\$\{AWS::AccountId\}:event-bus\/default/u,
  );
  assert.doesNotMatch(template, /Type:\s+AWS::Events::EventBus\s/u);
  assert.match(
    template,
    /"ses:configuration-set":\s+\[!Ref SesNotificationConfigurationSet\]/u,
  );
  assert.match(template, /QueueName:\s+sutra-production-ses-feedback/u);
  assert.match(template, /KmsMasterKeyId:\s+!Ref KmsKeyArn/u);
  assert.match(template, /maxReceiveCount:\s+5/u);
  assert.match(template, /ReceiveMessageWaitTimeSeconds:\s+10/u);
  assert.match(
    template,
    /Action:\s*\n\s+- sqs:ReceiveMessage\s*\n\s+- sqs:DeleteMessage[\s\S]*Resource:\s+!GetAtt SesFeedbackQueue\.Arn/u,
  );
  assert.doesNotMatch(template, /sqs:DeleteMessage[\s\S]{0,120}SesFeedbackDeadLetterQueue/u);
  assert.match(template, /MetricName:\s+ApproximateAgeOfOldestMessage/u);
  assert.match(template, /MetricName:\s+ApproximateNumberOfMessagesVisible/u);
  assert.match(template, /MetricName:\s+Reputation\.BounceRate/u);
  assert.match(template, /MetricName:\s+Reputation\.ComplaintRate/u);
  assert.match(bootstrapScript, /has\("NotificationSesActivation"\) \| not/u);
  assert.match(
    bootstrapScript,
    /NotificationSesActivation:"disabled-ses-production-access-denied"/u,
  );
});
