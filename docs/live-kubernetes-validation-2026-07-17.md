# Live Kubernetes validation — 2026-07-17

## Scope

Sutra was validated against a temporary, real Amazon EKS cluster in AWS account
`738663485493`, Region `ap-south-1`. The environment existed only for this
test and used one `t3.medium` managed node, public subnets, no NAT gateway, no
load balancer and no SSH access.

This is private-beta product evidence. It is not a claim that Sutra is already
a hosted, independently penetration-tested or SLA-backed production SaaS.

## Trust and permissions

- Customer-role permission pack: `live-demo-2026-07.3`
- Added EKS permissions: `eks:ListClusters` and `eks:DescribeCluster`
- The existing customer role was updated in place.
- The positive AssumeRole check passed.
- AssumeRole with a wrong External ID was denied.
- AssumeRole with no External ID was denied.
- The fetched trust policy, role policy and bounded session policy matched the
  reviewed contract.
- Kubernetes inventory used the checked-in `sutra-readonly` service account.
- `list pods --all-namespaces` returned `yes`.
- `get secrets --all-namespaces` returned `no`.

No AWS access key, Kubernetes token, External ID, MFA secret or Secret payload
is stored in this record.

## Collected evidence

The temporary cluster was named `sutra-validation` and ran Kubernetes 1.35.
Trivy Operator supplied vulnerability, configuration and CycloneDX SBOM
evidence. Sutra's complete scan observed:

- 235 normalized Kubernetes resources
- all 18 Kubernetes API collectors successful
- 73 failed native posture controls
- 385 Trivy findings in the full scanner evidence
- 6 CycloneDX SBOM reports in the full scanner evidence

For the customer demonstration, a bounded artifact focused on the deliberately
insecure test namespace was published:

- 235 resources
- 51 Trivy findings
- 4 critical and 17 high scanner findings
- 1 CycloneDX SBOM
- all 18 collectors successful
- artifact size 593,081 bytes

The promoted evidence was exercised in:

- Kubernetes overview
- Images and supply chain
- Exposure
- RBAC
- Network
- Compliance
- Coverage
- Scan history
- Security
- Executive report

The runtime view correctly reported that runtime protection was not configured.
Sutra did not substitute fixture events or claim Falco, audit-log or admission
coverage.

## Automated verification

`pnpm verify` passed after the implementation changes. It included secret
scanning, application and collector type checks, linting, 39 Kubernetes
contract tests, 95 collector tests, PostgreSQL integration, a production build
and rendered HTML checks.

The scan-import boundary accepts artifacts up to 3 MiB at the API and 2.7 MiB
in the browser, allowing the observed 1.35 MiB full Trivy evidence while
retaining a bounded request limit.

## AWS cleanup

The EKS node group, control plane, CloudFormation stacks, compute and retained
cluster log group were deleted after evidence capture. Cleanup verification is
performed with AWS APIs before this record is committed. A small AWS Budget
remains as a no-charge safety alert and does not provision infrastructure.

## Remaining general-availability gates

- Falco or equivalent runtime-event ingestion and Kubernetes audit-log
  detections
- Admission assessment/enforcement and deployment health workflows
- Scheduled scanning, drift, exceptions and automated case routing
- Multi-cluster scale, failure and chaos validation
- Independent penetration testing, hosted production operations and an SLA
