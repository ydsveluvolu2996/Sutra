# ADV-02 — Compute Optimizer Dashboard evidence record

Reviewed: 2026-08-02

Status: `PARTIAL_PIPELINE` (exact local provider-to-visual vertical implemented;
production scheduling, provider reconciliation, and live acceptance not claimed)

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
| Organization/all-Region right-sizing | Canonical eight-family regional launch projection, exact-ID terminal Describe proof, version-bound S3 reads, all-Region coordinator, and complete-only exact-generation heads | Partial, stale, substituted, expired, or ambiguous work is immutable evidence only and never heads |
| Nine published modules | Eight AWS export APIs map to nine published lenses because RDS instance and storage retain independent typed evidence | Only module families in the accepted all-Region generation appear |
| Findings | Original provider findings/reasons, exact filters, date and selected tag-key groupings | No finding regex is substituted for provider risk evidence |
| Savings | Signed integer micros, scope/currency/discount dimensions, after-discount preference per scope/currency, per-currency EC2 maxima and magnitude histogram | Alternative pre/post-discount channels and different currencies are never added or compared |
| Operational risk | Counts only resources carrying exported current-risk evidence, with exact business-unit tag grouping | Sutra does not infer severity or risk from finding prose |
| Right-sizing | Current configuration, ranked options, true instance-family changes, exact savings and immutable object/job lineage | Same-family resizing is not mislabeled as a family change |
| Progress over time | Full provider timestamp validation and UTC-normalized dates from one accepted exact generation | Malformed timestamps become structured missing evidence |
| Ownership/eligibility | Exact exported tag key/value controls and explicitly selected grouping key | Missing/unselected tag states are structured and cannot collide with provider strings |
| Lineage | Plan-set/generation IDs and hashes, request/job identity, exact object keys/versions and CSV/metadata hashes | Persisted plan/set/envelope binding hashes and AES-GCM context are reverified before API projection |
| Official inventory | Pinned version/modules/preview visuals and non-public definition disclosure rendered natively | No invented sheet or control totals |
| Export parser | Bounded fatal UTF-8 and AWS CSVW metadata/CSV parser with exact hashes, header/order/required/null validation, RFC4180 quoting, and exact integer/decimal lexemes | Returns a parsed intermediate only; it cannot create an accepted recommendation snapshot |

The client validates the frozen definition identity before accepting either a
configuration or report response. The same inventory is rendered during
loading, configuration, key-unavailable, failure and report states. The v2 API
requires an authenticated same-tenant active connection, accepted-head
reference, repository-verified plan-set bindings, authenticated regional plan
envelopes, and a canonically reverified generation before returning evidence.

## Implementation files

- Export projection/launch: `lib/finops-compute-optimizer-export-field-catalog.ts`,
  `lib/finops-compute-optimizer-export-launch.ts`
- Replay-safe collector boundary:
  `services/aws-collector/src/compute-optimizer-export-launch-ledger.ts`,
  `services/aws-collector/src/compute-optimizer-export-launcher.ts`
- Exact Describe/object path:
  `services/aws-collector/src/compute-optimizer-export-exact-describe.ts`,
  `lib/finops-compute-optimizer-export-object-reader.ts`
- AWS CSVW parser: `lib/finops-compute-optimizer-export-parser.ts`
- Exact mapper/coordinator/generation:
  `lib/finops-compute-optimizer-export-mapper.ts`,
  `lib/finops-compute-optimizer-export-coordinator.ts`,
  `lib/finops-compute-optimizer-export-generation.ts`
- Exact persistence: `db/finops-compute-optimizer-exact-generation-repository.ts`
- Persisted plan rehydration:
  `lib/finops-compute-optimizer-export-plan-set-reader.ts`
- Exact API read model: `lib/finops-compute-optimizer-exact-dashboard.ts`
- Official audit: `lib/finops-compute-optimizer-official-definition.ts`
- API/UI: `app/api/v1/finops/compute-optimizer/route.ts`,
  `app/costs/finops-compute-optimizer-dashboard.tsx`

## Remaining provider/live gates

1. Register the coordinator in the production scheduler/worker and bind its
   exact repositories/readers without a browser-controlled target or scope.
2. Activate the reviewed `.8.5` permission pack and launch add-on, rotate the
   evidence-reference secret, and apply migrations through the release path.
3. Reconcile controlled organization exports in every configured Region for
   all eight AWS export families, including pagination, throttling, lease/crash
   ambiguity, object versioning, corrected exports and partial S3 failures.
4. Validate exported tag columns and governed business-unit keys with two
   independent tenants; prove cross-tenant negative paths and stale behavior.
5. Obtain an authorized QuickSight template definition/export if exact current
   sheet/visual/control counts are required; the public git source cannot prove
   them.
6. Complete signed-in browser, provider, rollback and live smoke evidence, then
   pass the repository-wide release gates before building/deploying an image.

Until these gates pass, maturity remains `PARTIAL_PIPELINE` and production
activation stays false.

## Focused verification

The exact focused suite covers launch replay/crash semantics, broker parity,
all-Region coordination, exact persistence, encrypted plan rehydration, v2 API
binding, 14-purpose projection, exact UI rendering and production build.

```sh
NODE_OPTIONS=--experimental-transform-types node --test \
  tests/finops-compute-optimizer-exact-dashboard.test.ts \
  tests/finops-compute-optimizer-export-plan-set-reader.test.ts \
  tests/finops-compute-optimizer-exact-generation-repository.test.mjs \
  tests/finops-compute-optimizer-exact-route.test.mjs \
  tests/finops-report-independent-official-ui.test.mjs
```

Latest evidence: coordinator **17/17**; cross-component projection/coordinator
**136/136**; collector **295/295**; exact dashboard/reader/route/UI **17/17**;
exact persistence **9/9**; PostgreSQL **110 migrations** and all adapter/schema
tests; root/collector typechecks, touched ESLint, secret scans, diff checks and
the production application build pass. These are local gates, not controlled
provider or live acceptance.
