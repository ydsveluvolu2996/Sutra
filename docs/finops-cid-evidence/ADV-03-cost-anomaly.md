# ADV-03 — Cost Anomaly Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cost-anomaly-dashboard.html>

Official visual reference: <https://docs.aws.amazon.com/images/guidance/latest/cloud-intelligence-dashboards/images/ca_demo.png>

Assessment revision: `a9f7cb7`

Current maturity: `LOCAL_VERTICAL_CANDIDATE`

## Official requirement and visual inventory

- Centralized AWS Cost Anomaly Detection evidence across a payer organization.
- Early detection and investigation of sudden spend changes and root causes.
- Month-over-month, account, service, and regional trend analysis.
- Impact threshold, account, service, date-window, and lifecycle controls.
- Open/ended anomaly-window summary, top movers, actual-versus-expected spend,
  service impact, and resource-level detail.
- Cost Explorer and Cost Anomaly Detection must be enabled; the official CID
  solution also requires its Cost Anomalies Data Collection module.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Official narrative and visual inventory above, reviewed 2026-08-01. |
| G1 source contract | `IMPLEMENTED_UNVERIFIED` | Exact read-only `ce:GetAnomalies`, `ce:GetAnomalyMonitors`, and `ce:GetAnomalySubscriptions` source policy; commercial-partition entitlement and current permission-pack activation are explicit. |
| G2 collector | `IMPLEMENTED_UNVERIFIED` | `cost-anomaly-runner.ts` owns the 90-day request window, fixed Cost Explorer endpoint, pagination/record/output/deadline bounds, deterministic normalization, partial coverage, and sanitized errors. |
| G3 persistence | `IMPLEMENTED_UNVERIFIED` | Durable source job ledger, immutable evidence object and generation snapshot, checksum/sealed reference, complete-only active head, and last-good retention are exercised by the source-collection integration tests. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Authenticated `GET`/`POST /api/v1/finops/cost-anomaly`; exact connection-only query/body, server-derived tenant/account/source, bounded canonical billing input, freshness, and waiting/complete/partial/stale/failed states. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Native responsive panel provides minimum-impact, payer-account, service, region, date, and window controls; month/service trends; actual/expected impact context; safe CSV; root-cause drilldown; provider/Sutra separation; and collection-evidence coverage. |
| G6 focused verification | `VERIFIED` | Exact revision `a9f7cb7`: 43 application/persistence/security/render tests plus 24 collector/dispatch tests passed; 0 failed, 0 skipped. |
| G7 exact-tree gate | `NOT_STARTED` | Must be rerun after all 29 rows are locally complete on the eventual release SHA. |
| G8–G10 | `NOT_STARTED` | Controlled payer-account reconciliation, two-tenant provider proof, reviewed merge, immutable image deployment, and live visual acceptance remain. |

## Evidence-honesty limits

The provider response contract does not carry a currency code, so provider
amounts are labelled as billing currency units and are never hard-coded to USD
or converted. “Open window” and “Window ended” are derived from the accepted
finding end date and are not represented as an AWS workflow status. Provider
findings and Sutra statistical billing signals remain separate. A zero-finding
response is not proof that spend is correct or optimized.

Application command:

```text
node --experimental-strip-types --test tests/finops-aws-cost-anomaly.test.ts tests/finops-cost-anomaly-route-contract.test.mjs tests/finops-cost-anomaly-ui-contract.test.mjs tests/finops-source-collect-job.test.mjs tests/customer-onboarding-role-standard-2026-08.1.test.mjs tests/collector-permission-coverage.test.mjs tests/finops-aws-policy-artifact.test.ts
```

Result: **43 passed, 0 failed, 0 skipped**.

Collector command after `pnpm --dir services/aws-collector build`:

```text
node --test services/aws-collector/dist/test/cost-anomaly-runner.test.js services/aws-collector/dist/test/finops-source-runner.test.js
```

Result: **24 passed, 0 failed, 0 skipped**.
