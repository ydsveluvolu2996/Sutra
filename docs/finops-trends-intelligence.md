# Enterprise FinOps Trends intelligence

`lib/finops-trends-intelligence.ts` is the evidence-honest AWS CUR 2.0 trends
engine. It is a pure projection over immutable generations that the billing
repository has already reconciled and atomically marked active. It does not
replace or modify `lib/finops-trends.ts`; the older generic engine and its
Number-based regression remain available to their existing callers but are not
used by this enterprise contract.

## Evidence boundary

The caller supplies one active generation slice for each available billing
month. Every slice carries and is re-validated against:

- organization, customer, connection, export and billing-period scope;
- the immutable `fbg_<sha256>` generation identifier;
- source evidence identifier and manifest SHA-256;
- source-update, observation, commit and activation timestamps;
- active, immutable and reconciled assertions;
- collection completeness, pagination exhaustion and rejected-row count;
- available cost-basis evidence; and
- original, correction or backfill lineage, including the superseded
  generation for a correction.

Every row must repeat the exact slice scope, be canonical AWS CUR 2.0 rather
than FOCUS or a generic fixture, use an allowlisted expected currency and have
a unique line-item identifier within its generation. A cost basis declared
complete must be present on every row. Any mismatch fails closed instead of
being converted to a partial total.

Persistence remains responsible for proving that each supplied generation is
currently active before calling the engine. The engine deliberately performs
no storage or network access.

## Arithmetic and comparisons

Money is signed integer micro-units held in `BigInt`. Percentages and averages
are reduced rational numbers with decimal-string numerator and denominator.
No cost calculation converts through JavaScript `Number`.

Each `(currency, cost basis)` is a separate series. Currency conversion and
cross-basis merging are prohibited. Supported cost bases are unblended, net,
amortized, list, contracted and public. Unavailable or partially populated
bases remain explicitly unavailable or partial.

For each complete contiguous period the engine can produce:

- exact month-over-month amount and percentage change;
- an exact trailing average for the configured bounded window;
- an exact comparison of the current rolling window with the immediately
  preceding window; and
- top movement contributors for account, service, Region and charge category,
  including each contributor's exact share of absolute dimension movement.

Missing or incomplete months are never interpolated. A comparison, contributor
set or signal whose required period is missing, current/in-progress, partial,
configuration-blocked or errored is withheld with a machine-readable reason.

## Explainable signals, not forecasts

Signal formulas and thresholds are exported as
`FINOPS_TRENDS_SIGNAL_POLICY` and cannot be changed through request options:

1. Month-over-month review signal:
   `abs(current-prior)*100 >= abs(prior)*20`.
2. Previous-three-month baseline review signal:
   `abs(current*3-sum(previous3))*100 >= sum(previous3)*30`.

The trailing-baseline signal requires a positive, complete baseline. Both
signals are informational review indicators with formula, threshold, exact
observed rational percentage and plain-language explanation. They are not AWS
Cost Anomaly Detection findings and are not presented as statistical or
machine-learning inference.

The response always returns forecast availability as false with reason
`NOT_PRODUCED_EVIDENCE_HONEST_TRENDS_ONLY`. It makes no invoice, quote,
forecast or savings claim.

## Readiness and lifecycle states

The snapshot state is one of `READY`, `PARTIAL`, `STALE`, `EMPTY`, `ERROR` or
`CONFIGURATION_REQUIRED`. Every expected month is materialized and carries a
primary state plus all applicable reasons from:

- `COMPLETE`
- `MISSING`
- `CURRENT_PARTIAL`
- `CORRECTION`
- `BACKFILL`
- `PARTIAL`
- `STALE`
- `EMPTY`
- `ERROR`
- `CONFIGURATION_REQUIRED`

This preserves combined facts. For example, an old correction can have primary
state `STALE` while retaining `CORRECTION` in its state reasons.

The evaluated time is supplied by the caller. The module never calls the wall
clock. Freshness defaults to 36 hours and may be tightened or extended only
within the bounded 31-day maximum.

## Deterministic lineage and bounds

Output ordering is deterministic by period, currency, cost-basis order,
dimension movement and dimension key. Each active month retains its manifest,
generation and source evidence, plus a sorted bounded list of source line-item
identifiers and an explicit truncation flag.

The engine fails closed on unsafe volume. Current limits include 120 months,
250,000 rows per month, 500,000 rows total, 1,200 series, 50,000 values per
contributor dimension, a contributor display limit of 50 and a rolling window
of at most 12 months.

## AWS permissions

No additional IAM permission is required. The engine consumes the same active
CUR2 generations already acquired through the governed Data Exports/S3 billing
pipeline. `FINOPS_TRENDS_ADDITIONAL_READ_OPERATIONS` is therefore the exact
empty set. The permanent collector does not need a write permission, and this
capability does not require a new AWS API source.

## Verification

Focused coverage is in `tests/finops-trends-intelligence.test.ts`. It verifies
large values beyond JavaScript's safe-integer range, exact rational rolling
math, all contributor dimensions, pinned signals, readiness states, currency
and cost-basis isolation, missing-month suppression, active-generation
lineage, deterministic output, safe bounds and cross-tenant rejection.
