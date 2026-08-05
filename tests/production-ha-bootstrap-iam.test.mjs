import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const template = readFileSync(
  new URL("../infrastructure/production-ha-bootstrap-iam.yaml", import.meta.url),
  "utf8",
);
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const productionTemplate = readFileSync(
  new URL("../infrastructure/production-ha.yaml", import.meta.url),
  "utf8",
);
const validator = readFileSync(
  new URL("../deploy/production/validate-ha.sh", import.meta.url),
  "utf8",
);

test("bootstrap prerequisite remains inline-deployable and owns a hardened template staging bucket", () => {
  assert.ok(
    Buffer.byteLength(template, "utf8") <= 51_200,
    "the prerequisite template itself must remain below CloudFormation's TemplateBody limit",
  );
  assert.match(
    template,
    /BucketName: !Sub sutra-production-ha-bootstrap-templates-\$\{ExpectedAccountId\}-\$\{AWS::Region\}/u,
  );
  assert.match(
    template,
    /BootstrapTemplateBucket:\s+Type: AWS::S3::Bucket\s+DeletionPolicy: Retain\s+UpdateReplacePolicy: Retain/u,
  );
  assert.match(template, /VersioningConfiguration: \{ Status: Enabled \}/u);
  for (const control of [
    "BlockPublicAcls: true",
    "BlockPublicPolicy: true",
    "IgnorePublicAcls: true",
    "RestrictPublicBuckets: true",
  ]) {
    assert.match(template, new RegExp(control, "u"));
  }
  assert.match(template, /SSEAlgorithm: aws:kms/u);
});

test("bootstrap trust is exact-account, exact-repository, and environment-only", () => {
  assert.match(template, /AllowedValues: \["738663485493"\]/u);
  assert.match(template, /AllowedValues: \[ydsveluvolu2996\/Sutra\]/u);
  assert.match(template, /AllowedValues: \[sutra-production-ha\]/u);
  assert.match(
    template,
    /NetworkFirewallArn:[\s\S]*firewall\/sutra-production-egress-inspection/u,
  );
  assert.match(template, /token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com/u);
  assert.match(
    template,
    /repo:\$\{GitHubRepository\}:environment:production-ha-bootstrap/u,
  );
  assert.match(
    template,
    /repo:\$\{GitHubRepository\}:environment:production-ha-activation/u,
  );
  assert.doesNotMatch(template, /repo:\$\{GitHubRepository\}:(?:ref|pull_request)/u);
});

test("GitHub role passes only the exact CFN role and deterministic migration execution role", () => {
  const githubRole = template.match(
    /  GitHubBootstrapRole:[\s\S]*?(?=\nOutputs:)/u,
  )?.[0];
  assert.ok(githubRole, "GitHub bootstrap role must remain present");
  assert.equal(githubRole.match(/Action: iam:PassRole/gu)?.length, 2);
  assert.doesNotMatch(
    githubRole,
    /iam::\$\{ExpectedAccountId\}:role\/\$\{ProductionStackName\}-\*/u,
  );
  assert.match(template, /Action: iam:PassRole\s+Resource: !GetAtt CloudFormationExecutionRole\.Arn/u);
  assert.match(template, /iam:PassedToService: cloudformation\.amazonaws\.com/u);
  assert.match(
    template,
    /Resource: !Sub arn:\$\{AWS::Partition\}:iam::\$\{ExpectedAccountId\}:role\/sutra-production-ha-migration-execution/u,
  );
  assert.match(template, /iam:PassedToService: ecs-tasks\.amazonaws\.com/u);
  assert.match(
    productionTemplate,
    /MigrationExecutionRole:[\s\S]*?RoleName: sutra-production-ha-migration-execution[\s\S]*?MigrationTaskDefinition:/u,
  );
  const migrationTask = productionTemplate.match(
    /  MigrationTaskDefinition:[\s\S]*?(?=\n  WorkerTaskDefinition:)/u,
  )?.[0];
  assert.ok(migrationTask, "migration task definition must remain present");
  assert.doesNotMatch(migrationTask, /TaskRoleArn:/u);
  assert.match(
    template,
    /stack\/\$\{ProductionStackName\}\/\*/u,
  );
  assert.match(template, /changeSet\/sutra-bootstrap-\*\/\*/u);
  assert.match(template, /cloudformation:UpdateTerminationProtection/u);
});

test("bootstrap data-plane access is limited to four repos, runtime preflight, migration, and evidence", () => {
  for (const repository of [
    "sutra/app",
    "sutra/notification-worker",
    "sutra/broker",
    "sutra/agentless-scanner",
  ]) {
    assert.match(template, new RegExp(repository.replace("/", "\\/"), "u"));
  }
  assert.match(template, /secretsmanager:GetSecretValue/u);
  assert.match(template, /task-definition\/sutra-production-migration:\*/u);
  assert.match(template, /rule\/sutra-production-vulnerability-feed/u);
  assert.match(
    template,
    /Action: network-firewall:DescribeFirewall\s+Resource: !Ref NetworkFirewallArn/u,
  );
  assert.doesNotMatch(template, /Action: network-firewall:(?!DescribeFirewall)/u);
  assert.match(template, /evidencebucket-\*\/releases\/\*/u);
  assert.match(template, /kms:ViaService: !Sub s3\.\$\{AWS::Region\}\.amazonaws\.com/u);
});

test("CloudFormation may create and manage only the tagged taxonomy signing key shape", () => {
  const create = template.match(
    /- Sid: CreateOnlyTaggedTaxonomySigningKey[\s\S]*?(?=\n          - Sid:)/u,
  )?.[0];
  const manage = template.match(
    /- Sid: ManageOnlyTaggedTaxonomySigningKey[\s\S]*?(?=\n          - Sid:)/u,
  )?.[0];
  assert.ok(create);
  assert.ok(manage);
  assert.match(create, /Action: kms:CreateKey/u);
  assert.match(create, /Resource: "\*"/u);
  assert.match(create, /kms:KeySpec: RSA_3072/u);
  assert.match(create, /kms:KeyUsage: SIGN_VERIFY/u);
  assert.match(create, /aws:RequestTag\/sutra:component: trusted-advisor-taxonomy-signing/u);
  assert.match(create, /aws:RequestTag\/sutra:environment: production/u);
  assert.match(manage, /arn:\$\{AWS::Partition\}:kms:\$\{AWS::Region\}:\$\{ExpectedAccountId\}:key\/\*/u);
  for (const action of [
    "kms:DescribeKey",
    "kms:GetKeyPolicy",
    "kms:PutKeyPolicy",
    "kms:ListResourceTags",
    "kms:TagResource",
    "kms:UntagResource",
  ]) assert.match(manage, new RegExp(action, "u"));
  assert.match(manage, /aws:ResourceTag\/sutra:component: trusted-advisor-taxonomy-signing/u);
  assert.match(manage, /aws:ResourceTag\/sutra:environment: production/u);
  assert.doesNotMatch(`${create}\n${manage}`, /kms:(?:Sign|Verify|GetPublicKey|Decrypt|ScheduleKeyDeletion)/u);
});

test("execution role is CloudFormation-only and enumerates the production template services", () => {
  const executionRole = template.match(
    /  CloudFormationExecutionRole:[\s\S]*?(?=\n  GitHubBootstrapRole:)/u,
  )?.[0];
  assert.ok(executionRole, "CloudFormation execution role must remain present");
  assert.match(executionRole, /Service: cloudformation\.amazonaws\.com/u);
  assert.doesNotMatch(
    executionRole,
    /aws:Source(?:Arn|Account)/u,
    "ordinary CloudFormation stack service-role assumptions do not publish the registry SourceArn context",
  );
  assert.match(template, /cloudformation:RoleArn: !GetAtt CloudFormationExecutionRole\.Arn/u);
  for (const namespace of [
    "ec2:",
    "elasticloadbalancing:",
    "wafv2:",
    "rds:",
    "secretsmanager:",
    "kms:",
    "s3:",
    "ecs:",
    "events:",
    "application-autoscaling:",
    "iam:",
    "logs:",
    "cloudwatch:",
    "backup:",
    "ses:",
    "sqs:",
  ]) {
    assert.match(template, new RegExp(namespace, "u"));
  }
  assert.doesNotMatch(template, /Action:\s+["']?\*["']?/u);
  assert.doesNotMatch(template, /AdministratorAccess/u);
  assert.doesNotMatch(template, /iam:\*/u);
});

test("first-deploy execution includes required unscoped reads and encrypted resource dependencies", () => {
  for (const action of [
    "elasticloadbalancing:DescribeLoadBalancers",
    "rds:DescribeDBEngineVersions",
    "logs:DescribeLogGroups",
    "ecs:ListTaskDefinitions",
    "backup:ListBackupPlans",
    "secretsmanager:GetRandomPassword",
    "s3:ListAllMyBuckets",
    "ecs:DescribeTaskDefinition",
    "ecs:ListTasks",
  ]) {
    const escaped = action.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    assert.match(
      template,
      new RegExp(`${escaped}[\\s\\S]*?Resource: "\\*"`, "u"),
      `${action} must use Resource * because AWS does not support a resource ARN for that provider call`,
    );
  }
  assert.match(template, /Sid: ResolveGeneratedSecretsAndBackupEncryption[\s\S]*kms:Decrypt/u);
  assert.match(template, /kms:ViaService:[\s\S]*backup\.\$\{AWS::Region\}\.amazonaws\.com/u);
  assert.match(template, /kms:ViaService:[\s\S]*secretsmanager\.\$\{AWS::Region\}\.amazonaws\.com/u);
  assert.match(template, /logs:CreateLogDelivery/u);
  assert.match(template, /elasticloadbalancing:CreateWebACLAssociation/u);
  assert.match(template, /iam:AWSServiceName:[\s\S]*wafv2\.amazonaws\.com/u);
  assert.match(
    template,
    /Sid: ExactFeedbackQueues[\s\S]*sutra-production-ses-feedback[\s\S]*sutra-production-ses-feedback-dlq/u,
  );
  assert.match(
    template,
    /Sid: ExactFeedbackRule[\s\S]*rule\/sutra-production-ses-feedback/u,
  );
  assert.match(
    template,
    /Sid: DefaultBusRead[\s\S]*Action: events:DescribeEventBus[\s\S]*event-bus\/default/u,
  );
  assert.match(
    template,
    /Sid: SesConfiguration[\s\S]*ses:CreateConfigurationSet[\s\S]*ses:CreateConfigurationSetEventDestination/u,
  );
});

test("bucket creation is name-bounded without a new-resource account condition", () => {
  const createBucket = template.match(
    /- Sid: CreateOnlyNamedWorkloadStackBuckets[\s\S]*?(?=\n          - Sid:)/u,
  )?.[0];
  assert.ok(createBucket, "dedicated bucket creation statement must remain present");
  assert.match(createBucket, /Action: s3:CreateBucket/u);
  assert.match(createBucket, /\$\{ProductionStackName\}-accesslogbucket-\*/u);
  assert.match(createBucket, /\$\{ProductionStackName\}-evidencebucket-\*/u);
  assert.doesNotMatch(createBucket, /aws:ResourceAccount/u);
});

test("bucket stabilization reads match the exact declared retained-bucket properties", () => {
  const workloadBuckets = template.match(
    /- Sid: WorkloadBuckets[\s\S]*?(?=\n          - Sid:)/u,
  )?.[0];
  assert.ok(workloadBuckets, "exact workload-bucket statement must remain present");
  for (const action of [
    "s3:GetBucketAcl",
    "s3:GetBucketOwnershipControls",
    "s3:GetBucketTagging",
    "s3:GetBucketVersioning",
    "s3:GetEncryptionConfiguration",
    "s3:GetLifecycleConfiguration",
    "s3:GetBucketPublicAccessBlock",
    "s3:ListBucket",
    "s3:ListTagsForResource",
  ]) {
    assert.match(workloadBuckets, new RegExp(action, "u"), `${action} must remain allowed`);
  }
  assert.match(workloadBuckets, /\$\{ProductionStackName\}-accesslogbucket-\*/u);
  assert.match(workloadBuckets, /\$\{ProductionStackName\}-evidencebucket-\*/u);
  assert.match(workloadBuckets, /aws:ResourceAccount: !Ref ExpectedAccountId/u);
  assert.match(workloadBuckets, /aws:RequestedRegion: !Ref AWS::Region/u);
  assert.doesNotMatch(workloadBuckets, /\/\*/u, "bucket getters must not receive object scope");
});

test("template staging grants write to GitHub and read to CloudFormation only on templates prefix", () => {
  assert.match(
    template,
    /PolicyName: StageAndReadOnlyEncryptedWorkloadTemplate[\s\S]*Action: s3:PutObject[\s\S]*BootstrapTemplateBucket\.Arn\}\/templates\/\*/u,
  );
  assert.match(
    template,
    /Sid: ReadOnlyVersionedBootstrapTemplates[\s\S]*s3:GetObject[\s\S]*s3:GetObjectVersion/u,
  );
  assert.match(
    template,
    /CloudFormationTemplateReadPolicy:[\s\S]*s3:GetObject[\s\S]*s3:GetObjectVersion[\s\S]*BootstrapTemplateBucket\.Arn\}\/templates\/\*/u,
  );
  assert.match(
    template,
    /Sid: DecryptOnlyTemplatesReadThroughS3[\s\S]*kms:ViaService: !Sub s3\.\$\{AWS::Region\}\.amazonaws\.com/u,
  );
  assert.match(
    template,
    /BootstrapTemplateBucketName:[\s\S]*Value: !Ref BootstrapTemplateBucket/u,
  );
  assert.match(
    template,
    /cloudformation:TemplateUrl: !Sub https:\/\/\$\{BootstrapTemplateBucket\}\.s3\.\$\{AWS::Region\}\.amazonaws\.com\/templates\/\*/u,
  );
});

test("bootstrap IAM template is part of local and package CloudFormation validation", () => {
  assert.match(packageJson, /infrastructure\/production-ha-bootstrap-iam\.yaml/u);
  assert.match(validator, /infrastructure\/production-ha-bootstrap-iam\.yaml/u);
});
