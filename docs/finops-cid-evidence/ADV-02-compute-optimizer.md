# ADV-02 — Compute Optimizer Dashboard evidence record

Reviewed: 2026-08-01

Status: `PARTIAL_PIPELINE` (native export-history vertical implemented locally;
production provider activation not claimed)

Official guidance: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/compute-optimizer-dashboard.html>

Pinned repository: `aws-solutions-library-samples/cloud-intelligence-dashboards-framework`
at commit `f9e36d88c47709f10e8fa784ad11d5cc0e728021`.

## Immutable official source audit

| Artifact | Pinned path | SHA-256 |
|---|---|---|
| Dashboard/resource manifest | `cid/builtin/core/data/resources.yaml` | `41ad438cea2a297f62976689e77eee8fda371913a6af53c946fb615bdccb5b71` |
| QuickSight SPICE dataset | `cid/builtin/core/data/datasets/co/dataset.json` | `310718392f10de059efc3255f30b257aabdeebd7f0eba7d2debad0db09097176` |
| All-options union view | `cid/builtin/core/data/queries/co/all_options.sql` | `6ce1408e8c71291e34c2face7feac9a1e5c0f142ab5651868d8d93ac6188f0d2` |
| COD changelog | `changes/CHANGELOG-cod.md` | `29e5e8e000fa0bb23a5ab0d0840d93313b959c9c9978adcf0b61bc59aa3b1332` |
| Official documentation preview | `co_demo.png` | `a85d169cdc252408b29c40125513b90e735cbf564a4d4b22db1602a4d9261eae` |

The pinned manifest declares template ID `compute_optimizer`, dashboard ID
`compute-optimizer-dashboard`, and current changelog version `v5.0.0`.

### Definition availability boundary

`NOT_PUBLICLY_COMMITTED`: unlike CUDOS, CID, and KPI, the pinned public
repository does not contain the Compute Optimizer QuickSight template
definition. It references the template by ID. Therefore exact dashboard-wide
sheet, visual, filter-control, and parameter-control counts are **unavailable**.
They are null in the immutable code definition and are not inferred from the
preview image. The public demo endpoint also returned HTTP 403 during this
audit, and Chrome was not connected to Codex.

## Publicly provable module, visual, and control inventory

The pinned `all_options.sql` union proves nine published module families:

1. EC2 instance
2. Auto Scaling group
3. EBS volume
4. Lambda function
5. RDS instance
6. RDS storage
7. ECS service
8. License
9. Idle resource

The pinned official preview visibly documents 14 visual purposes: Total
instances; Findings; Findings by Date; Findings by Business Unit; Operational
Risk Finding Count; Maximum Potential Savings EC2; Potential Savings by Date;
Potential Savings by Business Unit; Operational Risks by Business Unit; Select
Instance; Current versus Recommended Option Projection; Recommended Instance
Family Changes; Potential Savings Histogram; and Potential Savings by Instance.

The published dataset proves fields supporting Account, Region, Service,
Module, Finding, Business Unit, Primary Tag, Secondary Tag, and resource search
controls. This inventory does not claim those are the only QuickSight controls.

## Native Sutra coverage

| Official lens | Sutra implementation | Evidence boundary |
|---|---|---|
| Organization/all-Region right-sizing | Server-pinned organization export materialization contract with account, Region, resource, utilization, ownership, tag, and search controls | Live object binding remains gated; discovery and direct Get APIs never substitute for history |
| Nine published modules | Module coverage cards disclose observed versus absent accepted export rows; the engine also models newer provider resource types | Only resource types present in completed exports appear |
| Findings | Over/under/idle/optimized/other distribution plus original provider finding and reason codes | No Sutra heuristic is represented as AWS evidence |
| Savings | Rank-one AWS estimated savings by currency, resource type, date, account, team, and business unit | Currencies are never merged; missing provider estimates remain unavailable |
| Operational risk | Provider performance-risk summary and distribution, current versus recommended risk in the detail table | Sutra does not invent risk severity |
| Right-sizing | Current configuration, rank-one target, migration effort, savings, risk, and resource lineage | Missing rank-one options remain explicit |
| Progress over time | Immutable accepted export generations grouped by provider observation date | Completed hash-addressed S3 exports only |
| Ownership/eligibility | Primary/secondary owner, team, business unit, eligibility tag key/value | Requires explicit materialized export tag evidence |
| Lineage | Export job, object SHA-256, metadata SHA-256, row count, materialization hash, accepted generation | Discovery readiness is not a dashboard data source |
| Official inventory | Pinned version/modules/preview visuals and non-public definition disclosure rendered natively | No invented sheet or control totals |
| Export parser | Bounded fatal UTF-8 and AWS CSVW metadata/CSV parser with exact hashes, header/order/required/null validation, RFC4180 quoting, and exact integer/decimal lexemes | Returns a parsed intermediate only; it cannot create an accepted recommendation snapshot |

The client validates the frozen commit, version, template and public artifact
hashes before accepting either a configuration or report response. The same
official inventory is rendered during loading, connection/configuration,
failure and report states; without a report, module cards say report evidence
is unavailable instead of claiming that accepted rows are absent.

## Implementation files

- Trust boundary: `lib/finops-compute-optimizer-organization.ts`
- Export projection: `lib/finops-compute-optimizer-export-history.ts`
- S3 materializer contract: `lib/finops-compute-optimizer-export-job.ts`
- AWS CSVW parser: `lib/finops-compute-optimizer-export-parser.ts`
- Official audit: `lib/finops-compute-optimizer-official-definition.ts`
- Repository: `db/finops-compute-optimizer-export-repository.ts`
- API/UI: `app/api/v1/finops/compute-optimizer/route.ts`,
  `app/costs/finops-compute-optimizer-dashboard.tsx`

## Remaining provider/live gates

1. Publish and activate the immutable `standard-2026-08.3` role candidate,
   which adds only the three Compute Optimizer enrollment/export-discovery
   reads. It deliberately grants no `Export*` operation and no S3 object read.
2. Persist the original organization export request/plan and exact
   resource-type × Region targets. AWS requires separate files per resource
   type and Region and separate S3 buckets for multiple Regions; a single
   bucket/prefix cannot certify organization coverage.
3. Register the production export-object S3 adapter and durable scheduled
   handler; the API currently reports
   `COMPUTE_OPTIMIZER_EXPORT_OBJECT_MATERIALIZER_NOT_REGISTERED`.
4. Bind the existing discovery repository to completed-job target selection
   without treating discovery as recommendation evidence.
5. Add resource-specific row mappers that consume the exact CSVW parser
   intermediate, beginning with EC2 and failing closed for unsupported export
   resource types. Replace floating-point evidence fields with exact decimal or
   integer units before live acceptance.
6. Validate real organization exports across every configured Region and all
   provider resource types, including multipart objects, corrected exports,
   pagination, throttling, and partial S3 failures.
7. Validate exact exported primary/secondary tag columns and the local
   ownership mapping policy.
8. Obtain an authorized QuickSight template definition/export if exact current
   sheet/visual/control counts are required; the public git source cannot prove
   them.
9. Apply both database migrations through release and complete signed-in
   visuals, cross-tenant negative tests, provider acceptance, stale-export
   behavior, rollback, and live smoke evidence.

Until these gates pass, maturity remains `PARTIAL_PIPELINE` and production
activation stays false.

## Focused verification

`tests/finops-report-independent-official-ui.test.mjs` adds a server-rendered
null/configuration contract for this report-independent audit surface.

```sh
node --experimental-strip-types --test \
  tests/finops-compute-optimizer-organization.test.ts \
  tests/finops-compute-optimizer-export-vertical.test.mjs \
  tests/finops-compute-optimizer-official-definition.test.mjs
```

Result: **21 passed, 0 failed, 0 skipped**.

The bounded parser and immutable permission-pack delta add these focused gates:

```sh
pnpm exec tsx --test tests/finops-compute-optimizer-export-parser.test.ts
node --test tests/customer-onboarding-role-standard-2026-08.3.test.mjs \
  tests/collector-permission-coverage.test.mjs
pnpm --dir services/aws-collector exec tsx --test \
  test/finops-role-broker.test.ts
```

Result: **33 passed, 0 failed, 0 skipped**. Root and collector TypeScript
checks pass. The pinned CloudFormation linter passes the `.8.3` template with
the repository's documented Bedrock action-spec false-positive suppression.
