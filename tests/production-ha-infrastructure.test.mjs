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
  assert.match(template, /DestinationPrefixListId:\s+!Ref ApprovedHttpsEgressPrefixListId/gu);
  assert.doesNotMatch(template, /CidrIp:\s+0\.0\.0\.0\/0/u);
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
  assert.match(template, /secretsmanager:GetSecretValue/u);
  assert.match(template, /kms:ViaService/u);
  assert.match(template, /sutra\/app@sha256:\[a-f0-9\]\{64\}/u);
  assert.match(template, /sutra\/notification-worker@sha256:\[a-f0-9\]\{64\}/u);
  assert.match(template, /sutra\/broker@sha256:\[a-f0-9\]\{64\}/u);
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
  assert.doesNotMatch(feedTask, /TaskRoleArn/u, "feed task needs no AWS application privileges");
  assert.match(feedRole, /Resource: !Ref DatabaseRuntimeSecret/u);
  assert.doesNotMatch(feedRole, /ApplicationRuntimeSecretArn/u);
  assert.match(template, /Name: sutra-production-vulnerability-feed/u);
  assert.match(template, /ScheduleExpression: cron\(30 3 \* \* \? \*\)/u);
  assert.match(template, /State: ENABLED/u);
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
  assert.match(template, /logdelivery\.elasticloadbalancing\.amazonaws\.com/u);
  assert.match(template, /Type:\s+AWS::CloudWatch::Alarm/gu);
  assert.match(template, /ContainerInsightsEnabled/u);
  assert.match(template, /KmsKeyId:\s+!Ref KmsKeyArn/u);
});

test("one protected workflow releases app, worker, and broker digests with migration, rollback, and evidence", () => {
  assert.match(workflow, /environment:\s+production-ha-release/u);
  assert.match(workflow, /id-token:\s+write/u);
  assert.match(workflow, /workflow_dispatch/u);
  assert.match(workflow, /changeTicket/u);
  assert.match(workflow, /actions:\s+read/u);
  assert.match(workflow, /CODEQL_ENABLED/u);
  assert.match(workflow, /actions\/workflows\/codeql\.yml\/runs\?head_sha=\$\{GITHUB_SHA\}/u);
  assert.match(workflow, /\.head_sha == \$sha/u);
  assert.match(workflow, /\.conclusion == "success"/u);
  assert.match(workflow, /--provenance=mode=max/gu);
  assert.match(workflow, /--sbom=true/gu);
  assert.match(workflow, /Scan the exact application digest/u);
  assert.match(workflow, /Scan the exact worker digest/u);
  assert.match(workflow, /Scan the exact broker digest/u);
  assert.match(workflow, /BROKER_ECR_REPOSITORY:\s+sutra\/broker/u);
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
  assert.match(workflow, /register_revision \\\s*\n\s+"\$\{previous_app\}"/u);
  assert.match(workflow, /register_revision \\\s*\n\s+"\$\{previous_worker\}"/u);
  assert.match(workflow, /register_revision \\\s*\n\s+"\$\{previous_broker\}"/u);
  assert.match(workflow, /register_revision \\\s*\n\s+"\$\{previous_feed\}"/u);
  assert.match(workflow, /'\["app","background-job-runner"\]'\s+true/u);
  assert.match(workflow, /SUTRA_RELEASE_IMAGE/u);
  assert.match(workflow, /releaseIdentityCount != 1/u);
  assert.match(workflow, /all services were rolled back/u);
  assert.match(workflow, /brokerImage/u);
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

test("release IAM is protected by the exact GitHub environment and exact services", () => {
  assert.match(template, /environment:\$\{GitHubReleaseEnvironment\}/u);
  assert.match(template, /Action:\s+sts:AssumeRoleWithWebIdentity/u);
  assert.match(template, /Resource:\s*\n\s+- !Ref AppService\s*\n\s+- !Ref WorkerService\s*\n\s+- !Ref BrokerService/u);
  assert.match(template, /sutra-production-migration:\*/u);
  assert.match(template, /sutra-production-vulnerability-feed:\*/u);
  assert.match(template, /events:PutTargets/u);
  assert.match(template, /iam:PassedToService:\s+events\.amazonaws\.com/u);
  assert.match(template, /ecr:GetLifecyclePolicy/u);
  assert.match(template, /Sid:\s+TagOnlyProductionTaskRevision/u);
  assert.match(template, /ecs:cluster:\s+!GetAtt Cluster\.Arn/u);
  assert.match(template, /iam:PassedToService:\s+ecs-tasks\.amazonaws\.com/u);
  assert.match(template, /Resource:\s+!Sub "\$\{EvidenceBucket\.Arn\}\/releases\/\*"/u);
});
