import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const template = readFileSync(
  new URL("../infrastructure/agentless-scan-account.yaml", import.meta.url),
  "utf8",
);
const runtime = readFileSync(
  new URL("../services/agentless-scanner/src/scan-entrypoint.ts", import.meta.url),
  "utf8",
);
const userData = readFileSync(
  new URL("../services/aws-collector/src/scan-instance-operations.ts", import.meta.url),
  "utf8",
);

test("agentless scan subnets have no public Internet path or broad egress", () => {
  assert.doesNotMatch(template, /AWS::EC2::InternetGateway/u);
  assert.doesNotMatch(template, /AWS::EC2::NatGateway/u);
  assert.doesNotMatch(template, /AWS::EC2::VPCGatewayAttachment/u);
  assert.doesNotMatch(template, /DestinationCidrBlock:\s*['"]?0\.0\.0\.0\/0/u);
  assert.doesNotMatch(template, /CidrIp:\s*['"]?0\.0\.0\.0\/0/u);
  assert.doesNotMatch(template, /MapPublicIpOnLaunch:\s*true/u);
  assert.match(template, /ScannerSecurityGroup:[\s\S]*SecurityGroupEgress:\s*\[\]/u);
  assert.match(template, /DestinationPrefixListId:\s*\n\s+Ref: S3GatewayPrefixListId/u);
  assert.match(template, /DestinationSecurityGroupId:\s*\n\s+Ref: ScanEndpointSecurityGroup/u);
});

test("the private endpoint set exactly covers the scanner runtime AWS calls", () => {
  assert.match(template, /com\.amazonaws\.\$\{AWS::Region\}\.ecr\.api/u);
  assert.match(template, /com\.amazonaws\.\$\{AWS::Region\}\.ecr\.dkr/u);
  assert.match(template, /com\.amazonaws\.\$\{AWS::Region\}\.s3/u);
  assert.match(template, /VpcEndpointType:\s*Gateway[\s\S]*RouteTableIds:/u);
  assert.match(template, /prod-\$\{AWS::Region\}-starport-layer-bucket\/\*/u);
  assert.match(template, /Fn::Sub: '\$\{FindingsBucket\.Arn\}\/scans\/\*'/u);
  assert.match(template, /Fn::GetAtt: \[ScannerEcrRepository, Arn\]/u);
  assert.doesNotMatch(template, /com\.amazonaws\.\$\{AWS::Region\}\.(?:logs|sts|kms|ec2)/u);
});

test("runtime cannot install packages or fetch public Trivy databases", () => {
  assert.doesNotMatch(userData, /\b(?:dnf|yum|apt-get)\s+install\b/u);
  assert.match(userData, /HOST_PREREQUISITES_MISSING/u);
  assert.doesNotMatch(runtime, /--download-(?:java-)?db-only/u);
  assert.match(runtime, /"--skip-db-update"/u);
  assert.match(runtime, /"--skip-java-db-update"/u);
  assert.match(runtime, /\/var\/cache\/trivy\/db\/metadata\.json/u);
  assert.match(runtime, /\/var\/cache\/trivy\/java-db\/metadata\.json/u);
});
