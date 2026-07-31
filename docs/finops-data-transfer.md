# AWS Data Transfer FinOps evidence contract

## Outcome

`lib/finops-data-transfer.ts` provides a pure, tenant-scoped analysis engine for
the AWS Cloud Intelligence Data Transfer capability. It covers the requested
internet, inter-Region, inter-AZ, and CloudFront categories and returns signed
cost, metered quantity, normalized-byte, account, service, Region,
Availability Zone, and resource drilldowns.

This module is an analysis contract, not a collector or persistence adapter.
The trusted server must load exactly one immutable active CUR 2.0 generation,
bind it to the authenticated tenant boundary, and pass that evidence to the
engine. No fixture or fallback data is produced.

## Authoritative source and IAM

The only data source is the existing AWS CUR 2.0 Data Export evidence plane.
AWS states that its Data Transfer dashboard is based on CUR data and covers
outbound/internet, inter-Region, inter-AZ, and CloudFront analysis. AWS also
documents the CUR `UsageType` patterns used by this engine and requires
`ProductCode` to distinguish CloudFront from otherwise similar internet
transfer usage types.

References:

- <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/datatransfer-dashboard.html>
- <https://docs.aws.amazon.com/cur/latest/userguide/cur-data-transfers-charges.html>

Additional collector IAM actions: **none**.

`DATA_TRANSFER_ADDITIONAL_READ_OPERATIONS` is intentionally empty. The engine
uses the existing tenant-bounded Data Export manifest/object read path. It does
not call Cost Explorer, CloudWatch, EC2, CloudFront, VPC, Pricing, or another
live AWS service. The permanent collector therefore does not need a broader
policy for this capability.

## Immutable input contract

The capture must identify:

- `AWS_CUR2_ACTIVE_GENERATION`, source format `aws-cur`, source version `2.0`;
- the same organization, customer, connection, export, billing period, and
  `fbg_...` generation as the authenticated request;
- a manifest SHA-256, source evidence identifier, generation/data-through/
  observation timestamps, and explicit `ACTIVE` state;
- exact payer and usage-account allowlists matching the independently supplied
  tenant boundary;
- manifest/processed object counts, source/accepted/rejected row counts,
  exhaustion flag, source status, and a bounded machine error code.

Every row must repeat the exact scope, be canonical AWS CUR 2.0, belong to an
allowed payer and usage account, and have a unique source line-item ID. A
substituted or staged generation, cross-client row, duplicate line, unsupported
currency, dishonest success count, or non-CUR2 source fails closed.

## Pinned classification taxonomy

The output carries taxonomy ID `aws-cur2-data-transfer`, version
`2026-07-31.v1`, a SHA-256 identifier, official references, matched rule IDs,
bounded usage-type evidence, and bounded source-line IDs.

Rules are deliberately narrow and ordered:

1. `AmazonCloudFront` plus the documented `DataTransfer-Out-Bytes` or
   `DataTransfer-Out-OBytes` pattern is `CLOUDFRONT`.
2. `DataTransfer-Regional-Bytes` is `INTER_AZ`.
3. `AWS-In-Bytes`, `AWS-Out-Bytes`, and their documented acceleration form are
   `INTER_REGION`.
4. Remaining documented `DataTransfer-In/Out-Bytes` forms are `INTERNET`.
5. A transfer product-family row without `UsageType` is `UNKNOWN`.
6. A transfer-looking but unmapped pattern, including Direct Connect
   `DataXfer` patterns, is `UNCLASSIFIED` until a reviewed taxonomy version
   explicitly adds it.
7. Rows with no transfer signal are counted as excluded non-transfer rows.

CloudFront is checked first because AWS explicitly warns that its usage types
look similar to internet transfer. No category is inferred from cost, resource
name, free text, or service name alone.

## Arithmetic and coverage

- All six canonical cost bases use signed `BigInt` micro-units. Credits,
  refunds, and corrections are retained; absolute-value or floating-point
  arithmetic is never used.
- Currency buckets are never combined or converted.
- Source quantities stay separated by their verbatim unit.
- Normalized bytes are available only for the pinned exact decimal units
  `Byte(s)`, `KB`, `MB`, `GB`, `TB` and binary units `KiB`, `MiB`, `GiB`,
  `TiB`. The engine calculates signed **microbytes** so it never rounds.
- A missing quantity/unit or an unrecognized unit remains explicit and makes
  the aggregate normalized-byte total `null`; it never becomes zero.
- Coverage separately reports classified, unknown, unclassified, excluded,
  missing-usage-type, missing-quantity, unknown-unit, and normalized rows.
- Account and service are mandatory canonical dimensions. Region and resource
  coverage can be complete, partial, or unavailable. The CUR Region and AZ are
  displayed only as line-item dimensions; they are not claimed to be both
  traffic endpoints.

## Source states

The engine never turns an absent or unhealthy source into live data:

| State | Meaning |
| --- | --- |
| `CONFIGURATION_REQUIRED` | No active CUR2 evidence was supplied. |
| `ERROR` | Reading the identified active generation failed; no rows are shown. |
| `EMPTY` | A complete successful active generation contains zero rows. |
| `PARTIAL` | Objects/rows were not exhausted, processing is incomplete, or source rows were rejected. |
| `STALE` | Complete evidence is older than the pinned 48-hour SLA. |
| `READY` | Complete successful evidence is within the SLA. |

Classification coverage is independent of source delivery state. A `READY`
source may still have partial classification coverage when AWS introduces a
new usage type; the unknown/unclassified rows remain visible for taxonomy
review.

## Bounds and client presentation

The contract limits capture/output bytes, source rows, manifest objects,
accounts, drilldown groups, usage types, source-line references, and text
lengths. A caller may lower the group limit but cannot raise the server cap.
Overflow fails closed instead of silently truncating monetary totals.

Client visuals should use category summaries for cost/byte trends and the
drilldowns for account, service, Region/AZ, and resource investigation. They
must display source state, freshness, classification coverage, cost-basis
coverage, unit coverage, taxonomy version, and the limitations returned by the
engine. `UNKNOWN`, `UNCLASSIFIED`, missing, stale, partial, and error states must
not be hidden behind a zero or a green health state.

