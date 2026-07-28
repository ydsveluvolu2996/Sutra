# Sutra operations-wave live activation record

Permission pack `standard-2026-07` was activated and attested on
2026-07-17. The existing customer role was updated in place, its External ID
trust boundary was re-proven with positive and negative probes, and a complete
AWS CMDB snapshot containing the temporary EKS cluster was promoted.

## Exact customer-role read delta

The reviewed template adds only these metadata/history actions to the existing read-only customer role:

- `ec2:DescribeVolumes`
- `ec2:DescribeNetworkInterfaces`
- `elasticloadbalancing:DescribeLoadBalancers`
- `kms:ListKeys`
- `kms:ListAliases`
- `kms:DescribeKey`
- `dynamodb:ListTables`
- `dynamodb:DescribeTable`
- `ecr:DescribeRepositories`
- `cloudtrail:LookupEvents`
- `eks:ListClusters`
- `eks:DescribeCluster`

All actions use `Resource: '*'` because these AWS list/describe APIs do not consistently support resource-level authorization. The role still grants no resource mutation, object/database/secret payload read, decryption, credential creation, remediation, security-service enablement, purchase, or commitment action.

The customer role carries an explicit Deny with the exact implemented-action exceptions, so resource policies cannot expand the role session beyond this reviewed pack. The STS session policy adds a compact read-family Allow intersection while the attested role policy remains the explicit-deny ceiling; the compact form stays below AWS STS plaintext and packed-policy safety limits.

## Reviewed artifacts

- Historical permission pack activated on 2026-07-17: `standard-2026-07`
- Historical template SHA-256 attested for that activation:
  `3121960e5786beede40cca12eea8a34e3e3a047e1856501d3122561fc11a904f`
- Historical artifact note: that digest identifies the superseded activation
  artifact. It must not be compared with the mutable working-tree path below.
- Current successor permission pack: `standard-2026-07.3`
- Current canonical template: `public/sutra-customer-onboarding-role.yaml`
- Current canonical template SHA-256:
  `8257b9e9ba516795a3a75ca86ddca13199223f0b38fbd577797ffdd8d14eba98`
- Current operator policy source:
  `infrastructure/sutra-operator-permission-set-policy.json`

## Completed activation sequence

1. The exact read-only delta and reviewed template were approved.
2. The operator permission set was updated with the checked-in policy.
3. The customer-role stack was updated in place without replacing the role.
4. The unchanged role ARN was re-registered using fresh MFA.
5. The positive trust probe, wrong-External-ID probe, missing-External-ID
   probe, fetched trust/policy attestation and session-policy proof passed.
6. A complete CMDB snapshot was promoted with EKS discovery enabled.
7. A live EKS cluster was registered and its Kubernetes evidence was published.
8. The Kubernetes customer portal, specialist views and executive report were
   exercised against real collected evidence.

The full Kubernetes evidence and cleanup record is in
`docs/live-kubernetes-validation-2026-07-17.md`.

## Honest product boundary

CloudTrail LookupEvents is bounded management-event history supplied by AWS. It is not CloudTrail Lake, data-event collection, VPC Flow Logs, DNS telemetry, long-term log retention, behavioral threat detection, or a replacement for GuardDuty/Security Hub/SIEM products. Sutra stores no raw `CloudTrailEvent` JSON in this feature.
