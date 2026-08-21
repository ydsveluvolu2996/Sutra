# AWS VPC subresource vertical closure worksheet

This worksheet adapts `docs/FINOPS_VERTICAL_CLOSURE_TEMPLATE.md` to the first
bounded Milestone 1 VPC slice. It constrains reuse and prevents the existing
collector, CMDB, Navigator, IAM, and persistence contracts from being rebuilt.

## Identity and starting state

| Field | Value |
|---|---|
| Vertical | VPC subresource projection from already-authorized EC2 metadata reads |
| Sutra resource types | `aws.ec2.route`, `aws.ec2.route-table-association`, `aws.ec2.network-acl-entry`, `aws.ec2.network-acl-association`, `aws.ec2.internet-gateway-attachment` |
| Starting branch | `develop` |
| Starting SHA / origin SHA | `e3224404de15c0447b215fe1c82297e24d45c677` |
| Required predecessor | Canonical catalog/Navigator evidence checkpoint `e3224404de15c0447b215fe1c82297e24d45c677` |
| Permission reservation | No new AWS operation. Reuse the exact existing `ec2:DescribeRouteTables`, `ec2:DescribeNetworkAcls`, and `ec2:DescribeInternetGateways` grants. `.8.19` remains reserved for FOCUS and must not be edited or reused. |
| Drizzle/PostgreSQL reservations | None. The immutable CMDB snapshot already persists arbitrary normalized resource types and derived relationships. |
| Primary implementer / shared integrator | Codex `/root`; no subagents |
| Node | `v22.23.2` |

## Existing-asset reuse inventory

| Surface | Existing files/symbols | Classification | Proof or exact gap | Planned action |
|---|---|---|---|---|
| Official definition/evidence | Captured VPC catalog rows in `data/aws-cmdb-catalog.v1.json` | `REUSE_AS_IS` | The five object types are present but have no implemented bindings. | Do not alter generated source inventory. |
| Domain/normalization | `resourceFromApi`, `collectRouteTables`, `collectNetworkAcls`, `collectInternetGateways` | `REPAIR` | Parent resources retain child arrays/counts but do not emit first-class child resources. | Emit bounded, safe, deterministic subresources from the same returned pages. |
| Collector adapter / SDK client | `Ec2InventoryClient`; three existing paginator tasks | `REUSE_AS_IS` | All source calls, pagination, retry, and deadlines already exist. | Add no SDK operation or second collector task. |
| Session/IAM contract | Existing standard exact allowlists for the three Describe actions | `REUSE_AS_IS` | No additional permission is required; explicit deny already permits these actions. | Freeze every permission template and central command map. |
| Role broker | Signed inventory job path and collector-owned temporary credentials | `REUSE_AS_IS` | Provider calls already remain inside the collector boundary. | No change. |
| Signed snapshot relationship projector | `liveRelationships` in `services/aws-collector/src/local-server.ts` | `REPAIR` | It persists generic VPC/subnet/instance/KMS edges but does not recognize the new `routeTableId`, `networkAclId`, `internetGatewayId`, `target`, or `gatewayId` fields. | Add only exact field-backed links and prove them through `normalizeLiveSnapshot`. |
| Drizzle/PostgreSQL migrations and registries | Generic immutable snapshot/resource persistence | `REUSE_AS_IS` | No new table, column, mutable state, or constraint is required. | No migration or registry change. |
| Durable repository / API | Pilot snapshot persistence, `/api/v1/cmdb/navigator`, CMDB resource and relationship routes | `REUSE_AS_IS` | Routes derive tenant/account scope on the server and serve arbitrary normalized types. | Prove the inherited boundary with focused positive/negative tests. |
| Navigator/search/Resource 360 UI | `lib/aws-cmdb-catalog.ts`, `lib/aws-navigator.ts`, generic Navigator and CMDB pages | `REPAIR` | The five catalog rows remain `not_collected` until explicitly bound. | Add exact bindings; reuse generic truthful states and Resource 360 links. |
| Relationships/topology | `deriveRelationships` | `REPAIR` | Parent-only edges hide route/association/entry/attachment identities. | Derive edges only from collected child configuration fields. |
| Focused tests | Collector, catalog/Navigator, relationship suites | `REPAIR` | No fixture asserts first-class child normalization, pagination sharing, truthful coverage, or child edges. | Add exact focused cases without broad test refactors. |
| Permission successor | `.8.19` | `UNAVAILABLE_BY_CONTRACT` | Reserved for FOCUS by `CLAUDE.md` and the FinOps handover. | Do not edit, renumber, or create a successor in this slice. |
| Later VPC adapters | NAT/transit gateways, endpoints, peering, VPN, Direct Connect, propagation | `MISSING` | They require new operations and separate bounded contracts. | Preserve honest `not_collected`; implement only after the current slice and a valid permission successor dependency. |

## Frozen reuse set and bounded edit set

### Frozen `REUSE_AS_IS` files

```text
services/aws-collector/src/types.ts
services/aws-collector/src/hosted-server.ts
services/aws-collector/src/role-broker.ts
db/runtime-migrations.ts
db/postgres-runtime-migrations.ts
scripts/postgres-migrate.mjs
infrastructure/customer-onboarding-role*.yaml
infrastructure/local-collector-role.yaml
public/sutra-customer-onboarding-role.yaml
app/api/v1/cmdb/navigator/route.ts
app/cmdb/navigator/**
db/pilot-repository.ts
db/cmdb-workspace-repository.ts
```

### Vertical-specific files allowed to change

```text
services/aws-collector/src/inventory-runner.ts
services/aws-collector/test/inventory-runner.test.ts
services/aws-collector/src/local-server.ts
lib/aws-cmdb-catalog.ts
lib/cmdb-relationships.ts
tests/aws-cmdb-catalog.test.ts
tests/aws-navigator.test.ts
tests/cmdb-relationships.test.ts
docs/AWS_CMDB_CATALOG_AND_NAVIGATOR.md
docs/CLOUDAWARE_AWS_IMPLEMENTATION_LEDGER.md
docs/CLOUDAWARE_AWS_VPC_SUBRESOURCE_CLOSURE.md
```

No other file may change unless this worksheet is updated first with the exact
new requirement.

## Contract decisions

| Question | Decision and authoritative basis |
|---|---|
| Exact provider sources/actions | Reuse only EC2 `DescribeRouteTables`, `DescribeNetworkAcls`, and `DescribeInternetGateways`. No AWS call is added outside `services/aws-collector`. |
| Pagination, row, payload and deadline bounds | Reuse the existing `MaxResults: 100`, repeated-token rejection, `MAX_PAGES`, per-command deadline, collection deadline, retry, and task-coverage logic. Child rows are emitted only from each successfully returned parent page. |
| Stable identity | Use provider association IDs where present. For provider objects without IDs, use an explicit deterministic composite of the owning native ID and the exact returned key fields; do not invent an ARN. |
| Tenant/account/connection binding | Inherit the signed collector request, account/partition/Region normalization, immutable snapshot boundary, organization-scoped repository reads, and Navigator state-boundary assertion. Client parameters cannot select organization/customer/account. |
| Replay/lease/CAS and READY-head semantics | Reuse atomic snapshot promotion and last-known-good retention. No mutable vertical-specific ledger is introduced. |
| Evidence signature and verification | Reuse existing collector request/response signatures and snapshot digests; normalized child configuration carries the exact source API. |
| Privacy/redaction | Persist only routing destinations/targets/states, association owner IDs, ACL rule fields, and attachment states returned by metadata APIs. No credentials, payloads, user data, or provider responses are stored wholesale. |
| Supported UI dimensions | Catalog maturity, exact Region coverage, current/retained/stale/failure states, scoped counts/search, Resource 360 details, and evidenced relationships. |
| Explicitly unavailable dimensions | `AWS VPC Static Route` remains unimplemented because the captured product research does not define its distinction from the general route object. All new-operation VPC types remain `not_collected`. |
| Failure-state behavior | The five child types share their owning collector key. Permission denial, partial pagination, failure, missing snapshot, incomplete Region coverage, and staleness suppress authoritative counts exactly as for the parent type. |

## Ordered implementation plan

1. Emit first-class VPC child resources and verify collector normalization,
   shared pagination, missing-ID handling, failure coverage, and no new command.
2. Bind the five exact catalog rows and add derived relationship cases; verify
   catalog/Navigator false-zero, tenant-boundary, and topology tests.
3. Update documentation and evidence, run focused tests, root/collector
   typechecks, affected/full lint, secret scan, migration-diff proof,
   CloudFormation permission coverage, build/rendered checks, then save and
   monitor the exact standing-PR CI.

## Candidate verification record

| Gate | Exact command(s) | Result | Evidence/notes |
|---|---|---|---|
| Focused domain/runtime tests | `node --experimental-strip-types --test --test-concurrency=1 tests/aws-cmdb-catalog.test.ts tests/aws-navigator.test.ts tests/aws-navigator-route-contract.test.mjs tests/aws-navigator-ui-contract.test.mjs tests/cmdb-relationships.test.ts tests/cmdb-relationships-route-contract.test.mjs` | Passed | 24 tests, 0 failed. |
| Collector/provider/route tests | Collector build, then `node --test services/aws-collector/dist/test/inventory-runner.test.js` and `local-server.test.js` | Passed | 21 inventory plus 14 signed local-server tests; exact normalized children, counts, API provenance, shared pagination, partial/failure/deadline behavior, and persisted edges. |
| Shared registration/predecessor tests | `pnpm catalog:aws:check`; `node --test tests/collector-permission-coverage.test.mjs tests/aws-template-contract.test.mjs` | Passed | Catalog artifact current; 12 permission/template tests passed with no new command. |
| SQLite/PostgreSQL migration parity | `git diff --name-only -- db scripts/postgres-migrate.mjs` | Passed / not applicable | No database schema, migration, migrator, or registry file changed. |
| Permission/CloudFormation tests | Pinned local `cfn-lint` 1.46.0 on `pnpm lint:cloudformation` | Passed | 28 templates passed; 42 documented Bedrock catalog false positives suppressed. Existing exact actions only. |
| Root typecheck/build | `pnpm typecheck`; `pnpm build` | Passed | Navigator API/page routes present in the production route manifest. |
| Collector typecheck/build | `pnpm typecheck:collector`; collector `pnpm build` | Passed | Node `v22.23.2`. |
| UI/render/accessibility contracts | Focused Navigator UI contracts; `pnpm test:rendered` | Passed locally | 4 rendered checks passed, including anonymous private-route redirect. Signed-in browser acceptance remains external because Chrome has no Sutra application session. |
| Lint, secrets and `git diff --check` | Affected ESLint, full `pnpm lint`, `pnpm security:secrets`, `git diff --check` | Passed | Full lint passed; secret scan passed for 2,666 files. |

## Handoff and promotion

| Field | Value |
|---|---|
| Feature commit | `b45b05fbfdba7280f3993d375e7d340f7cae0a67` |
| Feature pushed and remote SHA matched | Yes; local and `origin/develop` matched after `pnpm work:save` |
| Evidence file updated | Yes; this worksheet records the final local and exact implementation-CI evidence |
| Execution ledger updated | Yes; `docs/CLOUDAWARE_AWS_IMPLEMENTATION_LEDGER.md` records the implementation SHA and exact workflow URLs |
| Evidence commit / exact CI | Evidence commit pending. Implementation [CI run 32461752486](https://github.com/ydsveluvolu2996/Sutra/actions/runs/32461752486) and [Kubernetes/supply-chain run 32461752428](https://github.com/ydsveluvolu2996/Sutra/actions/runs/32461752428) passed for the exact feature SHA. |
| Remaining external gates | Disposable multi-Region/two-tenant AWS reconciliation and signed-in browser evidence |
