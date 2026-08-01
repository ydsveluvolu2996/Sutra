# ADV-02 — Compute Optimizer Dashboard

Status: `PARTIAL_PIPELINE` (export-history vertical implemented locally; provider activation not claimed)

| Official lens | Sutra implementation | Evidence boundary |
|---|---|---|
| Organization/all-Region right-sizing | Server-pinned organization export materialization with account/Region/resource filters | Discovery and direct Get APIs never substitute for history |
| EC2/ASG/EBS/Lambda and modeled services | All resource types modeled by the existing engine remain available | Only resource types present in completed exports appear |
| Over/under/idle/optimized | Provider finding classification with original finding/reason codes retained | No Sutra recommendation is represented as AWS evidence |
| Savings and operational risk | Rank-one AWS savings by currency; provider performance risk and migration effort | No currencies merged; missing values remain unavailable |
| Progress over time | Immutable accepted export generations grouped by export observation date | Completed hash-addressed S3 exports only |
| Account/team/business unit | Account plus explicit exported ownership dimensions | Unassigned remains visible; no inferred owner |
| Primary/secondary ownership and eligibility | Explicit primary/secondary owner and sorted eligibility tag evidence | Requires materialized export tag evidence |
| Lineage | Export job, object SHA-256, metadata SHA-256, row count, materialization hash and accepted generation | Discovery readiness is not a dashboard data source |

## Files

- Existing engine: `lib/finops-compute-optimizer-organization.ts`
- Export-only trust boundary/projection: `lib/finops-compute-optimizer-export-history.ts`
- Discovery-separated S3 materializer: `lib/finops-compute-optimizer-export-job.ts`
- Repository: `db/finops-compute-optimizer-export-repository.ts`
- Migrations: `drizzle/0101_finops_compute_optimizer_export_history.sql`, `postgres/migrations/0096_finops_compute_optimizer_export_history.sql`
- API/UI: `app/api/v1/finops/compute-optimizer/route.ts`, `app/costs/finops-compute-optimizer-dashboard.tsx`
- Verification: `tests/finops-compute-optimizer-organization.test.ts`, `tests/finops-compute-optimizer-export-vertical.test.mjs`

## Controls

- Session organization/customer boundaries are server-derived.
- Only active AWS trust-role connections with `connection:read` can read accepted history.
- The export-object job consumes completed export jobs selected by immutable discovery evidence, but its data plane is S3-only. It has no Compute Optimizer Get-recommendation operation.
- Organization/member scope, export ledger verification, completed export status, object/metadata hashes and bounds are mandatory.
- Current direct API observations are discarded by the export-history materializer even if present in the existing normalized engine snapshot.
- Snapshot JSON is content-addressed and immutable. Only a complete newer export generation advances the head; every complete prior generation remains available for progress views.
- Formula-safe CSV protects spreadsheet exports.

## Remaining live gates

1. Register the production export-object S3 adapter and durable scheduled handler.
2. Connect the existing discovery repository to completed-job target selection without treating discovery as recommendation evidence.
3. Validate real organization exports across all Regions/resource types, multipart objects, corrected exports, pagination, throttling and partial S3 failures.
4. Validate the exact exported tag columns used for primary/secondary owner, team, business unit and eligibility.
5. Apply SQLite/PostgreSQL migrations through release and complete signed-in visual, negative tenant-isolation, provider, and live smoke evidence.

Until these gates pass, maturity remains `PARTIAL_PIPELINE`; the API reports `COMPUTE_OPTIMIZER_EXPORT_OBJECT_MATERIALIZER_NOT_REGISTERED`, and production activation stays false.
