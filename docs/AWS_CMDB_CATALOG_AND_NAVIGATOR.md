# AWS CMDB catalog and Navigator

## Status

This document describes the local implementation candidate for the first
Milestone 0 vertical in
`docs/CODEX_MAC_MINI_CLOUDAWARE_AWS_HANDOVER.md`.

The catalog and Navigator are implemented and locally verified. They are not a
claim that every catalog type has a collector, that every supported type has
been exercised in every AWS partition, or that signed-in live AWS acceptance is
complete.

## Canonical source model

`data/aws-cmdb-catalog.v1.json` is generated deterministically from the three
captured research inventories:

- 18 Navigator categories;
- 114 Navigator service destinations;
- 978 AWS-prefixed resource-coverage extraction records;
- 317 Tag Analyzer resource-type records.

The resource-coverage extraction includes the page heading `AWS Resource
Coverage` among the 978 AWS-prefixed records. Sutra preserves that fact in the
source provenance but does not manufacture a resource type from the heading.
The usable resource-coverage inventory therefore contains 977 types. Nine Cloud
WAN types occur only in the Tag Analyzer capture. The lossless union contains
986 reference types, and the catalog adds one explicitly labeled Sutra
extension for the already-implemented normalized SSM instance patch-state
record.

Each resource type carries independent maturity fields for catalog membership,
adapter planning, implementation, external acceptance, and unavailability.
Catalog membership alone never sets implementation or acceptance.

Regenerate and verify the committed catalog with:

```sh
pnpm catalog:aws:generate
pnpm catalog:aws:check
```

The generated artifact includes SHA-256 hashes for every captured input. Tests
fail when either the source files or the generated artifact drift.

## Existing collector integration

Twenty-seven normalized CMDB resource types are explicitly bound to catalog
records, collector coverage keys, scope, and exact read operations. Twenty-six
are reference-catalog records and one is the Sutra SSM patch-state extension.
Bindings are reviewable in `lib/aws-cmdb-catalog.ts`; name similarity never
promotes a type automatically.

The Navigator does not call AWS. It reads only the existing durable CMDB
projection and coverage evidence. AWS SDK clients and temporary credentials
remain inside `services/aws-collector`.

## Tenant and account boundary

`GET /api/v1/cmdb/navigator` accepts only these filters:

- `connectionId`;
- `path`;
- `region`;
- `q`.

It does not accept organization, customer, or account identifiers. The route:

1. derives the organization from the authenticated/MFA-verified actor;
2. resolves the connection under that organization;
3. checks `connection:read` for the connection's persisted customer;
4. loads the CMDB state under the same organization and connection;
5. rejects state whose connection, customer, or AWS account differs from the
   authorized connection.

When no authorized connection exists, the response remains a catalog-only
view. Counts are unavailable, not zero.

## Evidence and count semantics

An authoritative numeric resource count appears only when all of the following
are true for the selected resource type and Region boundary:

- the adapter is implemented;
- a complete snapshot is active;
- the exact collector coverage row exists;
- every expected selected Region has a successful coverage row;
- no newer partial or failed attempt supersedes the collection time;
- the active snapshot is less than 48 hours old.

| State | Numeric behavior |
|---|---|
| `complete` | Current authoritative count is shown, including a truthful zero. |
| `not_configured` / `waiting` | No count is shown. |
| `not_collected` / `unavailable` | No count and no synthetic last-known zero are shown. |
| `permission_required` / `partial` / `failed` | Current count is suppressed; actual retained evidence may be labeled last known. |
| `retained` | A newer incomplete attempt did not replace the immutable complete snapshot; retained evidence is not current. |
| `stale` | Current count is suppressed; actual retained evidence may be labeled last known. |

Retirement-pending resources are displayed separately and are excluded from the
current authoritative count.

Service and category cards never label their subset sums as total inventory.
They say “observed in covered types” and disclose the implemented/complete type
counts beside the full catalog count.

## UI routes

- `/cmdb/navigator` — category catalog and scoped search;
- `/cmdb/navigator/<category-id>` — service destinations;
- `/cmdb/navigator/<service-id>` — resource-type contracts;
- `/cmdb/navigator/<service-id>/<type-id>` — one resource-type evidence and
  permission contract.

All routes reuse the authenticated application shell and carry the selected
connection and Region scope. Search runs on the server over the AWS catalog and
the selected account's authorized CMDB resources. Resource results link to the
existing Resource 360 route. Recent and pinned destinations contain only
catalog routes/titles, are bounded, validated, and stored per connection in the
current browser; they contain no credentials or resource evidence.

## Persistence and migrations

This vertical adds immutable generated catalog data and reads existing CMDB
tables. It adds no mutable persistence schema, so no Drizzle runtime or
PostgreSQL migration is required. The existing three migration registries are
unchanged.

## Known limits and next work

- External disposable-account, multi-partition, and signed-in browser
  acceptance remain pending.
- Search currently covers the AWS taxonomy, selected account identity, and
  selected account resources. The broader application-wide index for findings,
  reports, settings, and organization-scale multi-account scope is a separate
  Milestone 0 vertical.
- Catalog rows whose adapter contract is not assessed intentionally have
  unknown scope, partition, permission, pagination, and freshness metadata.
- Missing VPC networking adapters remain planned for the next deep vertical;
  catalog rows do not imply their collection.
