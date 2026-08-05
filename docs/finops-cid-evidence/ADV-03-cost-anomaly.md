# ADV-03 — Cost Anomaly Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cost-anomaly-dashboard.html>

Official visual reference: <https://docs.aws.amazon.com/images/guidance/latest/cloud-intelligence-dashboards/images/ca_demo.png>

Official provider behavior and field inventory: <https://docs.aws.amazon.com/cost-management/latest/userguide/getting-started-ad.html>

Pinned public source: <https://github.com/aws-solutions-library-samples/cloud-intelligence-dashboards-framework/tree/f9e36d88c47709f10e8fa784ad11d5cc0e728021/dashboards/cost-anomalies>

Assessment tree: working tree over `8f042cd`; the parent exact-tree gate must
record the eventual reviewed integration SHA.

Current maturity: `LOCAL_VERTICAL_CANDIDATE`

## Official requirement and visual inventory

- Centralized AWS Cost Anomaly Detection evidence across a payer organization.
- Early detection and investigation of sudden spend changes and root causes.
- Month-over-month, account, service, and regional trend analysis.
- Impact threshold, account, service, date-window, and lifecycle controls. The
  current AWS provider inventory additionally documents search by severity,
  assessment, usage type, Region, monitor type, account and anomaly ID, and
  sorting by start date, last detected date, duration, impact, impact percent,
  monitor name and top service root cause.
- Open/ended anomaly-window summary, top movers, actual-versus-expected spend,
  service/account/Region/usage-type root-cause contribution, assessment,
  monitor/subscription coverage, and resource-level detail.
- Cost Explorer and Cost Anomaly Detection must be enabled; the official CID
  solution also requires its Cost Anomalies Data Collection module.

The current AWS guidance still categorizes Cost Anomaly Dashboard as an
advanced dashboard and documents the Cost Anomalies Data Collection module as
a prerequisite. The pinned public manifest contains the complete QuickSight
`AnalysisDefinition` inline; therefore its object totals are exact rather than
image-derived estimates.

| Frozen artifact | Immutable evidence |
|---|---|
| Repository commit | `f9e36d88c47709f10e8fa784ad11d5cc0e728021` |
| Manifest | `dashboards/cost-anomalies/cost-anomalies.yaml` |
| Manifest SHA-256 | `3676df09c3e3933987dfad923e0fc1b418c30db0562c3344d0ff2f0e54726244` |
| Embedded definition SHA-256 | `299b580daf221ab61cc243eb5f3fe121aee9c7fb21a88d66be58c007ab6a3b14` |
| Changelog SHA-256 | `5a78599be4f131feb12944e5ea6da5bb87b38d55cd8d4ae00a0a1e9f205ac104` |
| Dataset identifier | `ca_summary_view` |
| Standalone query artifact | Not published at the pinned commit; query totals and parity are not claimed. |

Exact structural inventory: **2 sheets, 6 visuals, 4 parameter controls, 8
filter-control placements, 10 parameter declarations, 11 calculated fields, 9
filter groups, and 1 dataset declaration**. The primary sheet contains four
bar charts, one table, and one pie chart. The About sheet contains no visual
objects and repeats the four cross-sheet filter controls.

| Official visual | Type | Native coverage | Preserved gap |
|---|---|---|---|
| Daily Cost Anomalies Total Impact | Bar chart | `PARTIAL_SEMANTICS` | Native trend is monthly, not daily. |
| Total Impact Cost | Bar chart | `SUPPORTED` | Exact QuickSight geometry is not reproduced. |
| AWS Cost Anomalies - Service (Total Cost Impact) | Bar chart | `PARTIAL_SEMANTICS` | Native view ranks provider root-cause contribution; it does not assign whole-anomaly impact to service. |
| AWS Cost Anomalies Details | Table | `SUPPORTED` | Native bounded details omit the upstream dataset-only account-name field and do not claim table geometry. |
| Total Impact Cost by Anomaly Start Date | Bar chart | `PARTIAL_SEMANTICS` | Native aggregation is by start month, not exact date. |
| Anomalies Status | Pie chart | `PARTIAL_SEMANTICS` | Official Active/Past uses last-update age plus a configurable day parameter; native Open/ended uses the provider anomaly end date. |

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Current CID narrative/provider guidance and the complete public QuickSight definition above, reviewed 2026-08-01 at the immutable source commit and hashes. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Exact read-only `ce:GetAnomalies`, `ce:GetAnomalyMonitors`, and `ce:GetAnomalySubscriptions` source policy; commercial-partition entitlement and current permission-pack activation are explicit. |
| G2 collector | `IMPLEMENTED_UNVERIFIED` | `cost-anomaly-runner.ts` owns the 90-day request window, fixed Cost Explorer endpoint, pagination/record/output/deadline bounds, deterministic normalization, partial coverage, and sanitized errors. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | Durable source job ledger, immutable evidence object and generation snapshot, checksum/sealed reference, complete-only active head, and last-good retention are exercised by the source-collection integration tests. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated `GET`/`POST /api/v1/finops/cost-anomaly`; exact connection-only query/body, server-derived tenant/account/source, bounded canonical billing input, freshness, and waiting/complete/partial/stale/failed states. Every GET state also returns the immutable `sutra.aws-cost-anomaly-official-definition.v1` audit. The accepted provider response includes a bounded `sutra.aws-cost-anomaly-analysis.v1` projection with null-aware actual/expected/total/maximum coverage, monthly aggregates, four root-cause dimensions, assessment counts, monitor method/dimension coverage and redacted subscription-channel coverage. Anomalies receive only matched monitor type/dimension metadata; monitor ARNs and caller labels are not exposed. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Native responsive panel provides anomaly ID, minimum provider score, minimum total impact, linked-account, service, Region, usage type, assessment, monitor type, overlapping date-window and lifecycle controls plus deterministic sort. It renders monthly total-impact coverage without substituting maximum impact, actual-versus-expected spend with observed counts, ranked provider contribution for service/account/Region/usage type, open/ended windows, assessment, monitor/subscription evidence, safe CSV, bounded root-cause drilldown, provider/Sutra separation and collection coverage. A native evidence drawer exposes the exact official sheet/visual/control totals, immutable source hashes, all six visual mappings and preserved gaps even before provider materialization exists. |
| G6 focused verification | `VERIFIED` | Working tree over the last integrated revision: provider boundary/analysis tests, authenticated route contracts and server-rendered UI contracts pass, including null-total non-substitution and redacted monitor/subscription coverage. Exact commands and totals are recorded below. |
| G7 exact-tree gate | `NOT_STARTED` | Must be rerun after all 29 rows are locally complete on the eventual release SHA. |
| G8–G10 | `NOT_STARTED` | Controlled payer-account reconciliation, two-tenant provider proof, reviewed merge, immutable image deployment, and live visual acceptance remain. |

## Evidence-honesty limits

The provider response contract does not carry a currency code, so provider
amounts are labelled as billing currency units and are never hard-coded to USD
or converted. “Open window” and “Window ended” are derived from the accepted
finding end date and are not represented as an AWS workflow status. Provider
findings and Sutra statistical billing signals remain separate. A zero-finding
response is not proof that spend is correct or optimized.

`MaxImpact` is not a substitute for `TotalImpact`. Missing total, actual,
expected, percentage, contribution, start-date or root-cause values remain
unavailable and are counted as such. The dashboard does not persist or expose
monitor/subscription labels, anomaly dimension labels, linked-account names,
subscriber addresses, SNS ARNs or raw threshold/monitor expressions. It is a
read-only investigation surface: it does not submit anomaly feedback or create,
edit or delete monitors and subscriptions.

Application command:

```text
node --experimental-strip-types --test tests/finops-aws-cost-anomaly.test.ts tests/finops-cost-anomaly-official-definition.test.ts tests/finops-cost-anomaly-route-contract.test.mjs tests/finops-cost-anomaly-ui-contract.test.mjs tests/finops-source-collect-job.test.mjs tests/customer-onboarding-role-standard-2026-08.1.test.mjs tests/collector-permission-coverage.test.mjs tests/finops-aws-policy-artifact.test.ts
```

Result: **49 passed, 0 failed, 0 skipped**.

Collector command after `pnpm --dir services/aws-collector build`:

```text
node --test services/aws-collector/dist/test/cost-anomaly-runner.test.js services/aws-collector/dist/test/finops-source-runner.test.js
```

Result: **24 passed, 0 failed, 0 skipped**.

Focused ESLint over the ADV-03 domain, route, panel and contracts passed with no
warnings. Root TypeScript `--noEmit` and exact-file `git diff --check` passed.
