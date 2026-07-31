import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const template = readFileSync(
  new URL("../infrastructure/production-network.yaml", import.meta.url),
  "utf8",
);
const deploymentGuide = readFileSync(
  new URL("../deploy/production/README.md", import.meta.url),
  "utf8",
);
const workloadTemplate = readFileSync(
  new URL("../infrastructure/production-ha.yaml", import.meta.url),
  "utf8",
);
const releaseWorkflow = readFileSync(
  new URL("../.github/workflows/production-ha-release.yml", import.meta.url),
  "utf8",
);

const CLOUDFLARE_IPV4_2026_07_30 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
].sort();

function between(start, end) {
  const startIndex = template.indexOf(start);
  const endIndex = template.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing ${start}`);
  assert.ok(endIndex > startIndex, `missing ${end} after ${start}`);
  return template.slice(startIndex, endIndex);
}

test("network creates ten explicit two-AZ tiers with no public instance addresses", () => {
  const subnets = between(
    "  PublicSubnetA:",
    "  NatGatewayEipA:",
  );
  assert.match(template, /EnableDnsHostnames:\s+true/u);
  assert.match(template, /EnableDnsSupport:\s+true/u);
  assert.match(
    template,
    /AvailabilityZonesMustDiffer:[\s\S]*?!Not \[!Equals \[!Ref AvailabilityZoneA, !Ref AvailabilityZoneB\]\]/u,
  );
  assert.equal(
    [...template.matchAll(/Type:\s+AWS::EC2::Subnet\s*$/gmu)].length,
    10,
  );
  assert.equal(
    [...template.matchAll(/MapPublicIpOnLaunch:\s+false\s*$/gmu)].length,
    10,
  );
  for (const tier of [
    "public-alb",
    "public-nat-egress",
    "network-firewall",
    "private-app",
    "isolated-database",
  ]) {
    assert.equal(
      [...subnets.matchAll(new RegExp(`Value: ${tier} \\}`, "gu"))].length,
      2,
    );
  }
});

test("each application AZ has a same-AZ firewall and NAT while database subnets remain isolated", () => {
  assert.equal(
    [...template.matchAll(/Type:\s+AWS::EC2::NatGateway\s*$/gmu)].length,
    2,
  );
  assert.match(
    template,
    /FirewallDefaultRouteA:[\s\S]*?NatGatewayId:\s+!Ref NatGatewayA/u,
  );
  assert.match(
    template,
    /FirewallDefaultRouteB:[\s\S]*?NatGatewayId:\s+!Ref NatGatewayB/u,
  );
  assert.doesNotMatch(template, /PrivateAppDefaultRoute[AB]:/u);
  assert.doesNotMatch(template, /PrivateDatabaseDefaultRoute/u);
  const databaseRoutes = between(
    "  PrivateDatabaseRouteTableA:",
    "  ManagedEgressDomainRuleGroup:",
  );
  assert.doesNotMatch(databaseRoutes, /DestinationCidrBlock/u);
  assert.doesNotMatch(databaseRoutes, /NatGatewayId|GatewayId/u);
  assert.match(
    template,
    /NatGatewayA:[\s\S]*?SubnetId:\s+!Ref PublicNatEgressSubnetA/u,
  );
  assert.match(
    template,
    /NatGatewayB:[\s\S]*?SubnetId:\s+!Ref PublicNatEgressSubnetB/u,
  );
});

test("strict-order firewall permits only the gateway and commercial AWS API namespace", () => {
  const firewall = between(
    "  ManagedEgressDomainRuleGroup:",
    "  EndpointSecurityGroup:",
  );
  assert.equal(
    [...firewall.matchAll(/Type:\s+AWS::NetworkFirewall::RuleGroup\s*$/gmu)].length,
    1,
  );
  assert.equal(
    [...firewall.matchAll(/Type:\s+AWS::NetworkFirewall::FirewallPolicy\s*$/gmu)].length,
    1,
  );
  assert.equal(
    [...firewall.matchAll(/Type:\s+AWS::NetworkFirewall::Firewall\s*$/gmu)].length,
    1,
  );
  assert.match(firewall, /GeneratedRulesType:\s+ALLOWLIST/u);
  assert.match(
    firewall,
    /Targets:\s*\n\s+- outbound\.sutracmdb\.com\s*\n\s+- \.amazonaws\.com/u,
  );
  assert.equal(
    [...firewall.matchAll(/outbound\.sutracmdb\.com/gu)].length,
    1,
  );
  assert.equal(
    [...firewall.matchAll(/^\s+- \.amazonaws\.com\s*$/gmu)].length,
    1,
  );
  assert.doesNotMatch(firewall, /- \.outbound\.sutracmdb\.com/u);
  assert.doesNotMatch(firewall, /\.amazonaws\.com\.cn|\.amazonaws-us-gov\.com/u);
  assert.match(firewall, /TargetTypes:\s*\n\s+- TLS_SNI/u);
  assert.doesNotMatch(firewall, /HTTP_HOST/u);
  assert.match(
    firewall,
    /HOME_NET:[\s\S]*?!Ref PrivateAppSubnetCidrA[\s\S]*?!Ref PrivateAppSubnetCidrB/u,
  );
  assert.equal(
    [...firewall.matchAll(/RuleOrder:\s+STRICT_ORDER/gu)].length,
    2,
  );
  assert.match(firewall, /StreamExceptionPolicy:\s+DROP/u);
  assert.match(firewall, /aws:drop_established_app_layer/u);
  assert.match(firewall, /aws:alert_established_app_layer/u);
  assert.equal(
    [...firewall.matchAll(/aws:forward_to_sfe/gu)].length,
    2,
  );
  assert.match(
    template,
    /NetworkFirewallLifecyclePhase:[\s\S]*?rollback-safe-first-create[\s\S]*?protected-after-live-route-validation/u,
  );
  assert.match(
    template,
    /NetworkFirewallProtected:\s+!Equals[\s\S]*?protected-after-live-route-validation/u,
  );
  assert.match(
    firewall,
    /DeleteProtection:\s+!If \[NetworkFirewallProtected, true, false\]/u,
  );
  assert.match(firewall, /FirewallPolicyChangeProtection:\s+true/u);
  assert.match(firewall, /SubnetChangeProtection:\s+true/u);
  assert.equal(
    [...firewall.matchAll(/KeyId:\s+!Ref KmsKeyArn/gu)].length,
    3,
  );
});

test("firewall path preserves AZ symmetry in both directions and direct AWS endpoint routes", () => {
  const firewall = between(
    "  ManagedEgressDomainRuleGroup:",
    "  EndpointSecurityGroup:",
  );
  assert.match(
    firewall,
    /SubnetMappings:[\s\S]*?SubnetId:\s+!Ref FirewallSubnetA[\s\S]*?SubnetId:\s+!Ref FirewallSubnetB/u,
  );
  assert.match(
    firewall,
    /PrivateAppRouteTableA[\s\S]*?"0\.0\.0\.0\/0"[\s\S]*?AvailabilityZoneA/u,
  );
  assert.match(
    firewall,
    /PrivateAppRouteTableB[\s\S]*?"0\.0\.0\.0\/0"[\s\S]*?AvailabilityZoneB/u,
  );
  assert.match(
    firewall,
    /PublicNatEgressRouteTableA[\s\S]*?PrivateAppSubnetCidrA[\s\S]*?AvailabilityZoneA/u,
  );
  assert.match(
    firewall,
    /PublicNatEgressRouteTableB[\s\S]*?PrivateAppSubnetCidrB[\s\S]*?AvailabilityZoneB/u,
  );
  assert.match(firewall, /FirewallStatus"\]\.get\("SyncStates"/u);
  assert.match(firewall, /attachment\.get\("Status"\) == "READY"/u);
  assert.match(firewall, /endpoint_id\.startswith\("vpce-"\)/u);
  assert.doesNotMatch(firewall, /Fn::Select|!Select/u);
  assert.doesNotMatch(
    template,
    /S3GatewayEndpoint:[\s\S]*?RouteTableIds:[^\n]*FirewallRouteTable/u,
  );
  assert.match(
    template,
    /S3GatewayEndpoint:[\s\S]*?RouteTableIds: \[!Ref PrivateAppRouteTableA, !Ref PrivateAppRouteTableB\]/u,
  );
});

test("Network Firewall alert and flow logs are retained, KMS encrypted, and explicit-retention", () => {
  const firewall = between(
    "  ManagedEgressDomainRuleGroup:",
    "  EndpointSecurityGroup:",
  );
  assert.equal(
    [...firewall.matchAll(/DeletionPolicy:\s+Retain/gu)].length,
    3,
  );
  assert.equal(
    [...firewall.matchAll(/UpdateReplacePolicy:\s+Retain/gu)].length,
    3,
  );
  assert.equal(
    [...firewall.matchAll(/RetentionInDays:\s+!Ref FlowLogRetentionDays/gu)].length,
    3,
  );
  assert.match(firewall, /LogType:\s+ALERT/u);
  assert.match(firewall, /LogType:\s+FLOW/u);
  assert.equal(
    [...firewall.matchAll(/LogDestinationType:\s+CloudWatchLogs/gu)].length,
    2,
  );
  assert.match(
    firewall,
    /Action:\s+network-firewall:DescribeFirewall\s*\n\s+Resource:\s+!Ref InspectionFirewall/u,
  );
  assert.match(
    firewall,
    /ec2:CreateRoute[\s\S]*?ec2:DeleteRoute[\s\S]*?ec2:ReplaceRoute/u,
  );
  assert.match(
    firewall,
    /route-table\/\$\{PrivateAppRouteTableA\}/u,
  );
});

test("VPC Flow Logs retain KMS-encrypted ALL-traffic audit records", () => {
  const audit = between(
    "  VpcFlowLogGroup:",
    "  PublicSubnetA:",
  );
  assert.match(
    template,
    /FlowLogRetentionDays:[\s\S]*?Default:\s+90[\s\S]*?AllowedValues:/u,
  );
  assert.match(audit, /Type:\s+AWS::Logs::LogGroup/u);
  assert.equal([...audit.matchAll(/DeletionPolicy:\s+Retain/gu)].length, 1);
  assert.equal([...audit.matchAll(/UpdateReplacePolicy:\s+Retain/gu)].length, 1);
  assert.match(audit, /KmsKeyId:\s+!Ref KmsKeyArn/u);
  assert.match(audit, /RetentionInDays:\s+!Ref FlowLogRetentionDays/u);
  assert.match(audit, /Type:\s+AWS::EC2::FlowLog/u);
  assert.match(audit, /ResourceId:\s+!Ref Vpc/u);
  assert.match(audit, /ResourceType:\s+VPC/u);
  assert.match(audit, /TrafficType:\s+ALL/u);
  assert.match(audit, /MaxAggregationInterval:\s+60/u);
  assert.match(audit, /Service:\s+vpc-flow-logs\.amazonaws\.com/u);
  assert.match(audit, /aws:SourceAccount:\s+!Ref AWS::AccountId/u);
  assert.match(audit, /vpc-flow-log\/\*/u);
  assert.match(audit, /logs:CreateLogStream/u);
  assert.match(audit, /logs:PutLogEvents/u);
  assert.doesNotMatch(audit, /logs:CreateLogGroup/u);
  assert.match(audit, /Resource:\s+!GetAtt VpcFlowLogGroup\.Arn/u);
  assert.match(audit, /Action:\s+logs:DescribeLogGroups\s*\n\s+Resource:\s+"\*"/u);
});

test("private AWS endpoints are multi-AZ and the S3 gateway covers both app route tables", () => {
  for (
    const service of
    ["ecr.api", "ecr.dkr", "logs", "secretsmanager", "sts", "kms", "email", "sqs"]
  ) {
    assert.match(
      template,
      new RegExp(
        `ServiceName: !Sub com\\.amazonaws\\.\\$\\{AWS::Region\\}\\.${service.replace(".", "\\.")}`,
        "u",
      ),
    );
  }
  assert.equal(
    [...template.matchAll(/VpcEndpointType:\s+Interface\s*$/gmu)].length,
    8,
  );
  assert.equal(
    [...template.matchAll(
      /SubnetIds: \[!Ref PrivateAppSubnetA, !Ref PrivateAppSubnetB\]/gu,
    )].length,
    8,
  );
  assert.equal(
    [...template.matchAll(/PrivateDnsEnabled:\s+true\s*$/gmu)].length,
    8,
  );
  assert.match(
    template,
    /S3GatewayEndpoint:[\s\S]*?VpcEndpointType:\s+Gateway[\s\S]*?RouteTableIds: \[!Ref PrivateAppRouteTableA, !Ref PrivateAppRouteTableB\]/u,
  );
  const s3Parameter = between(
    "  S3GatewayPrefixListId:",
    "  KmsKeyArn:",
  );
  assert.match(s3Parameter, /AllowedPattern:\s+'\^pl-/u);
  assert.doesNotMatch(s3Parameter, /Default:/u);
  assert.doesNotMatch(template, /pl-78a54011/u);
});

test("Cloudflare ingress is the exact documented IPv4 snapshot and is not world-open", () => {
  const ingress = between(
    "  CloudflareIngressPrefixList:",
    "  ApprovedHttpsEgressPrefixList:",
  );
  const actual = [...ingress.matchAll(
    /- \{ Cidr: ([0-9./]+), Description: Cloudflare IPv4 snapshot 2026-07-30 \}/gu,
  )].map((match) => match[1]).sort();
  assert.deepEqual(actual, CLOUDFLARE_IPV4_2026_07_30);
  assert.match(template, /Source:\s+https:\/\/www\.cloudflare\.com\/ips-v4/u);
  assert.match(template, /Retrieved:\s+"2026-07-30"/u);
  assert.doesNotMatch(ingress, /0\.0\.0\.0\/0/u);
  assert.match(ingress, /MaxEntries:\s+20/u);
});

test("HTTPS egress is review-bound, capacity-bounded, and rejects an allow-all entry", () => {
  const egressParameters = between(
    "  ApprovedHttpsEgressChangeTicket:",
    "\nRules:",
  );
  const egress = between(
    "  ApprovedHttpsEgressPrefixList:",
    "\nOutputs:",
  );
  const requiredCidrParameter = egressParameters.slice(
    egressParameters.indexOf("  ApprovedHttpsEgressCidr01:"),
    egressParameters.indexOf("  ApprovedHttpsEgressCidr02:"),
  );
  assert.match(egressParameters, /ApprovedHttpsEgressCidr01:[\s\S]*?Type:\s+String/u);
  assert.doesNotMatch(requiredCidrParameter, /Default:/u);
  assert.equal(
    [...egressParameters.matchAll(
      /\/\(\?:\[1-9\]\|\[12\]\[0-9\]\|3\[0-2\]\)\$'/gu,
    )].length,
    18,
  );
  assert.match(egress, /MaxEntries:\s+18/u);
  assert.doesNotMatch(egress, /PrivateAppSubnetCidrA|PrivateAppSubnetCidrB/u);
  assert.equal(
    [...egress.matchAll(/Cidr:\s+!Ref ApprovedHttpsEgressCidr[0-9]{2}/gu)].length,
    18,
  );
  assert.match(egress, /sutra:change-ticket/u);
  assert.doesNotMatch(egress, /Cidr:\s+0\.0\.0\.0\/0/u);
});

test("only broker gets broad L3 HTTPS and routing still forces strict L7 inspection", () => {
  assert.match(
    workloadTemplate,
    /EndpointSecurityGroupId:[\s\S]*?Type:\s+AWS::EC2::SecurityGroup::Id/u,
  );
  assert.match(
    workloadTemplate,
    /S3GatewayPrefixListId:[\s\S]*?AllowedPattern:\s+\^pl-/u,
  );
  assert.equal(
    [...workloadTemplate.matchAll(
      /DestinationSecurityGroupId:\s+!Ref EndpointSecurityGroupId/gu,
    )].length,
    4,
  );
  assert.equal(
    [...workloadTemplate.matchAll(
      /DestinationPrefixListId:\s+!Ref S3GatewayPrefixListId/gu,
    )].length,
    4,
  );
  assert.equal(
    [...workloadTemplate.matchAll(
      /DestinationPrefixListId:\s+!Ref ApprovedHttpsEgressPrefixListId/gu,
    )].length,
    3,
  );
  assert.equal(
    [...workloadTemplate.matchAll(/CidrIp:\s+0\.0\.0\.0\/0/gu)].length,
    1,
  );
  assert.match(
    workloadTemplate,
    /BrokerSecurityGroup:[\s\S]*?SecurityGroupEgress:[\s\S]*?CidrIp:\s+0\.0\.0\.0\/0[\s\S]*?strict L7 Network Firewall for \.amazonaws\.com/u,
  );
  for (const [start, end] of [
    ["  ApplicationSecurityGroup:", "  WorkerSecurityGroup:"],
    ["  WorkerSecurityGroup:", "  BrokerSecurityGroup:"],
    ["  VulnerabilityFeedSecurityGroup:", "  AlbIngressFromApprovedEdge:"],
  ]) {
    const block = workloadTemplate.slice(
      workloadTemplate.indexOf(start),
      workloadTemplate.indexOf(end),
    );
    assert.doesNotMatch(block, /CidrIp:\s+0\.0\.0\.0\/0/u);
  }
  assert.doesNotMatch(template, /PrivateAppDefaultRoute[AB]:/u);
  assert.match(
    template,
    /properties\["PrivateAppRouteTableA"\],[\s\S]*?"0\.0\.0\.0\/0"[\s\S]*?endpoints\[properties\["AvailabilityZoneA"\]\]/u,
  );
  assert.match(
    template,
    /properties\["PrivateAppRouteTableB"\],[\s\S]*?"0\.0\.0\.0\/0"[\s\S]*?endpoints\[properties\["AvailabilityZoneB"\]\]/u,
  );
  assert.doesNotMatch(
    workloadTemplate,
    /DestinationCidrIp:\s+!Ref PrivateAppSubnetCidr[AB]/u,
  );
});

test("outputs map one-for-one to every production-ha network parameter", () => {
  const outputs = template.slice(template.indexOf("\nOutputs:"));
  for (const output of [
    "VpcId",
    "VpcCidr",
    "PublicSubnetIds",
    "PrivateAppSubnetIds",
    "PrivateDatabaseSubnetIds",
    "AlbIngressPrefixListId",
    "ApprovedHttpsEgressPrefixListId",
    "S3GatewayPrefixListId",
    "EndpointSecurityGroupId",
    "KmsKeyArn",
  ]) {
    assert.match(
      outputs,
      new RegExp(`\\n  ${output}:\\n[\\s\\S]*?production-ha\\.yaml ${output}`, "u"),
    );
  }
  assert.match(
    outputs,
    /PublicSubnetIds:[\s\S]*?!Join \[",", \[!Ref PublicSubnetA, !Ref PublicSubnetB\]\]/u,
  );
  assert.match(
    outputs,
    /PrivateAppSubnetIds:[\s\S]*?!Join \[",", \[!Ref PrivateAppSubnetA, !Ref PrivateAppSubnetB\]\]/u,
  );
  assert.match(
    outputs,
    /PrivateDatabaseSubnetIds:[\s\S]*?!Join \[",", \[!Ref PrivateDatabaseSubnetA, !Ref PrivateDatabaseSubnetB\]\]/u,
  );
});

test("operator guide refuses transient DNS pinning and documents atomic list maintenance", () => {
  assert.match(deploymentGuide, /infrastructure\/production-network\.yaml/u);
  assert.match(deploymentGuide, /https:\/\/www\.cloudflare\.com\/ips-v4/u);
  assert.match(deploymentGuide, /pl-78a54011/u);
  assert.match(deploymentGuide, /OwnerId=AWS/u);
  assert.match(deploymentGuide, /PrefixListName=com\.amazonaws\.<region>\.s3/u);
  assert.doesNotMatch(deploymentGuide, /ip-ranges\.amazonaws\.com\/ip-ranges\.json/u);
  assert.match(deploymentGuide, /never[\s\S]{0,80}transient DNS/iu);
  assert.match(deploymentGuide, /CloudFormation change set/iu);
  assert.match(deploymentGuide, /FQDN-only/iu);
  assert.match(deploymentGuide, /fail closed/iu);
  assert.match(deploymentGuide, /VPC Flow Logs/iu);
  assert.match(deploymentGuide, /TrafficType=ALL/u);
  assert.match(deploymentGuide, /KMS\s+key policy/iu);
  assert.match(deploymentGuide, /EndpointIds` in no\s+defined order/iu);
  assert.match(deploymentGuide, /no direct application-to-NAT default/iu);
  assert.match(deploymentGuide, /material recurring cost/iu);
  assert.match(deploymentGuide, /five\s+firewalls per account\/Region/iu);
  assert.match(deploymentGuide, /100 Gbps per firewall AZ/iu);
  assert.match(deploymentGuide, /capacity 100/iu);
  assert.match(
    deploymentGuide,
    /one destination-object\s+change per update/iu,
  );
});

test("protected workflow revalidates the regional S3 list as AWS-managed", () => {
  assert.match(releaseWorkflow, /aws ec2 describe-managed-prefix-lists/u);
  assert.match(releaseWorkflow, /\[\[ "\$\{owner\}" == "AWS" \]\]/u);
  assert.match(
    releaseWorkflow,
    /\[\[ "\$\{name\}" == "com\.amazonaws\.\$\{AWS_REGION\}\.s3" \]\]/u,
  );
  assert.match(releaseWorkflow, /\[\[ "\$\{family\}" == "IPv4" \]\]/u);
  assert.match(releaseWorkflow, /\[\[ "\$\{state\}" == "create-complete" \]\]/u);
});
