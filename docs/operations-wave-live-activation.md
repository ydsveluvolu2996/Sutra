# Sutra operations-wave live activation

The source, database migrations, and automated tests for permission pack `live-demo-2026-07.2` are complete. The current laptop process intentionally remains on the previously attested permission pack until the following AWS changes are explicitly approved and completed. Restarting first would make new inventory runs partial and would prevent a new complete CMDB snapshot from being promoted.

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

All actions use `Resource: '*'` because these AWS list/describe APIs do not consistently support resource-level authorization. The role still grants no resource mutation, object/database/secret payload read, decryption, credential creation, remediation, security-service enablement, purchase, or commitment action.

The customer role carries an explicit Deny with the exact implemented-action exceptions, so resource policies cannot expand the role session beyond this reviewed pack. The STS session policy also retains an exact Allow list and a compact read-family outer Deny to remain below AWS STS plaintext and packed-policy safety limits.

## Reviewed artifacts

- Permission pack: `live-demo-2026-07.2`
- Template: `public/sutra-customer-role-live-demo.yaml`
- Template SHA-256: `ed73f5738f951782977f31735a79f36148c591b5ab359f6c761369b16276b238`
- Operator policy source: `infrastructure/sutra-operator-permission-set-policy.json`

## Activation sequence

1. Approve the exact ten-action read-only delta above and the publication of the reviewed immutable template object.
2. Update the SutraOperator Identity Center permission set with the checked-in operator policy so it can publish only the exact new template object path.
3. Publish the template and retain its versioned immutable HTTPS URL.
4. Update the existing `sutra-customer-role-738663485493` CloudFormation stack in place, preserving its current trust parameters and External ID. Review the change set; the role must not be replaced.
5. Restart the local live-AWS launcher with the validated `sutra-demo-collector` SSO profile.
6. In Sutra, re-register the unchanged `/sutra/SutraReadOnlyRole` ARN with a fresh MFA code. This repeats the positive identity check, both External-ID negative probes, fetched trust/policy attestation and session-policy proof, then records permission pack `.2`.
7. Run one CMDB sync. It must complete without a permission-denied collector and promote a new immutable snapshot before the expanded services are described as live.
8. Open **Security events**, choose **Collect live events**, and confirm the source coverage, time window, payload hash, normalized management events and any evidence-linked detections.
9. Run Costs, Compliance, Cases and the executive report smoke path. Record unavailable AWS services as unavailable; do not substitute fixtures.

## Honest product boundary

CloudTrail LookupEvents is bounded management-event history supplied by AWS. It is not CloudTrail Lake, data-event collection, VPC Flow Logs, DNS telemetry, long-term log retention, behavioral threat detection, or a replacement for GuardDuty/Security Hub/SIEM products. Sutra stores no raw `CloudTrailEvent` JSON in this feature.
