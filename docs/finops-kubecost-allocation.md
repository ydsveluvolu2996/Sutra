# Kubecost/OpenCost container allocation source

`lib/finops-kubecost-allocation.ts` is the pure normalization and acceptance boundary for the Additional-level Kubecost allocation capability. It consumes an already-collected, tenant-pinned export; it does not call Kubecost, OpenCost, Kubernetes, S3, or AWS Billing itself.

The source is an attribution view, not a second spend ledger. AWS CUR 2.0 remains authoritative spend. A Kubecost snapshot cannot become `READY` until its aggregate currency totals reconcile to the exact immutable `ACTIVE` CUR2 generation named in the tenant scope. The presentation policy is always `ATTRIBUTION_VIEW_ONLY_DO_NOT_ADD_TO_CUR2`.

## Evidence contract

The normalized export schema is `sutra.kubecost-opencost-allocation` version `1.0.0`. Every capture pins:

- provider and exporter name/version;
- schema, manifest, query, and cost-model SHA-256 hashes;
- explicit UTC query window, hourly step, and output format;
- exact S3 bucket and tenant/export prefix;
- object key, ETag, optional version ID, SHA-256, and size;
- source object, row number, row identifier, and row SHA-256 for every allocation;
- exact cost basis and whether Kubecost cloud-bill reconciliation was enabled;
- expected/processed/failed object coverage and expected/captured clusters;
- the registered Sutra organization, customer, connection, AWS accounts, clusters, billing period, and active CUR2 generation.

Every raw request must preserve lineage rather than aggregate it away:

`AWS account -> cluster -> namespace -> controller kind -> controller -> workload -> pod -> container`

Null lineage stays null. The engine never maps an unallocated row to a made-up namespace, workload, or container.

The export query contract is:

- an explicit RFC3339 UTC start/end pair;
- `step=1h`;
- `accumulate=false`;
- raw allocation lineage retained;
- `shareIdle=false` and `splitIdle=true`;
- shared-cost breakdown enabled;
- external costs enabled;
- cloud-bill reconciliation metadata consistent with the declared cost basis.

Kubecost documents `__idle__`, `__unallocated__`, and `__unmounted__` as distinct special allocations, and its Allocation API exposes shared and external cost controls. Sutra retains those distinctions instead of redistributing or hiding them. See the [Kubecost Allocation API](https://www.ibm.com/docs/en/kubecost/self-hosted/3.x?topic=apis-allocation-api) and [OpenCost documentation](https://opencost.dev/docs/).

## Cost and utilization math

All source decimals are parsed as exact reduced rational numbers. JavaScript floating-point arithmetic is not used for money, quantities, ratios, reconciliation, or tolerance checks.

Each row must satisfy:

`total = CPU + RAM + GPU + network + PV + load balancer + shared + external`

Economic categories are disjoint:

- a workload row contributes its base cost to `WORKLOAD_ALLOCATION`, its `sharedCost` to `SHARED`, and its `externalCost` to `EXTERNAL`;
- special `IDLE`, `SHARED`, `EXTERNAL`, `UNALLOCATED`, and `UNMOUNTED` rows contribute their full total only to their matching category.

The category totals therefore add back to the source total without double counting. Currency keys remain independent; the engine performs no conversion or cross-currency total.

Efficiency is emitted only from explicit matching numerator/denominator fields:

- CPU: used core-hours / requested core-hours;
- RAM: used byte-hours / requested byte-hours;
- GPU: used GPU-hours / requested GPU-hours;
- PV: used byte-hours / provisioned byte-hours;
- network: used bytes / capacity bytes only when the exporter supplies authoritative capacity.

Kubecost's standard allocation response exposes traffic volumes but does not prove network capacity. Network efficiency is therefore normally `UNAVAILABLE`. Missing metrics remain null/partial; they never become zero.

## CUR2 reconciliation and double-counting control

The CUR2 evidence must be:

- generation state `ACTIVE`;
- the exact generation and billing period named by the tenant scope;
- complete (`rowsExhausted=true`);
- scoped to the exact authorized AWS account and cluster sets;
- identified by its manifest SHA-256;
- summarized per currency as exact integer micro-units.

Kubecost totals are compared per currency to CUR2 totals. The default tolerance is zero. A caller may set an explicit non-negative integer micro-unit tolerance; it applies independently to each currency. A missing currency on either side is `UNAVAILABLE`, and a delta outside tolerance is `MISMATCH`. Either result prevents `READY`.

The snapshot exposes both totals and their exact delta for audit, but CUR2 remains the only authoritative spend source. Consumers must never sum a Kubecost allocation total with CUR2.

## Source states

The engine emits explicit operational states:

- `CONFIGURATION_REQUIRED`: exporter, permanent read permission, or active CUR2 evidence is absent;
- `WAITING_FIRST_DELIVERY`: configured but no export has arrived;
- `UNKNOWN`: collector outcome is unknown;
- `ERROR`: the exporter/collector failed;
- `EMPTY`: a complete, reconciled capture contains no usage rows;
- `PARTIAL`: object/cluster/row coverage is incomplete or CUR2 does not reconcile;
- `STALE`: otherwise complete evidence exceeds the 24-hour freshness SLA;
- `READY`: complete current evidence reconciles to active CUR2.

Only `READY` and `EMPTY` have `complete=true`.

## Runtime IAM contract

The permanent Sutra collector remains read-only. For current-object reads, its baseline actions are exactly:

```text
s3:GetBucketLocation
s3:ListBucket
s3:GetObject
```

Policy resources and conditions must be narrowed as follows:

- `s3:GetBucketLocation` and `s3:ListBucket` use the exact export bucket ARN;
- `s3:ListBucket` includes an `s3:prefix` condition for the one tenant/export prefix;
- `s3:GetObject` uses only `arn:<partition>:s3:::<bucket>/<tenant-prefix>*`;
- expected bucket owner is pinned on requests.

If the collector requests a specific S3 `versionId`, use `s3:GetObjectVersion` for the object ARN instead of `s3:GetObject`. AWS documents that a versioned `GetObject` request requires `s3:GetObjectVersion`, while a current-object request requires `s3:GetObject`. See [Amazon S3 GetObject permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).

If the prefix is encrypted with a customer-managed KMS key, add only `kms:Decrypt`, restricted to that exact key ARN and constrained through `kms:ViaService` to the bucket Region. It is conditional and is not part of the S3 action set.

No `s3:PutObject`, `s3:DeleteObject`, Kubernetes mutation, Billing mutation, IAM mutation, or wildcard service action belongs in the permanent collector.

## Exporter prerequisites and separate writer

The export-producing identity is separate from Sutra's permanent collector. Before enabling the source, the owner must provide:

1. A supported Kubecost or OpenCost installation in every registered cluster, with a stable cluster identifier and sufficient retention for the requested windows.
2. An authenticated exporter that can query the Allocation API at raw lineage, hourly resolution for explicit UTC windows, page or split windows within configured limits, and reject partial responses.
3. Cost model and query configuration captured and hashed with each generation.
4. Explicit currency and cost basis for every row. If Kubecost cloud-bill reconciliation is used, the cloud integration must be healthy and the export must declare `CLOUD_BILL_RECONCILED`.
5. A complete authorized mapping of AWS account IDs to cluster IDs. The exporter may not infer tenant ownership from user-supplied labels.
6. A dedicated S3 destination with an organization/customer/connection-specific prefix, encryption, versioning, retention/lifecycle, and preferably Object Lock where the customer requires WORM evidence.
7. A separate writer identity with only `s3:PutObject` on that prefix. If SSE-KMS is used, its conditional KMS permissions are `kms:Encrypt` and `kms:GenerateDataKey` on the exact CMK. These permissions never flow to the permanent collector.
8. An active immutable CUR2 generation and a separately derived Kubernetes-scoped total for the same accounts, clusters, period, currency, and data-through boundary.

## Acceptance gates

A production source is not accepted until focused tests and live evidence prove:

- the exact tenant/customer/connection scope and complete account/cluster membership;
- all objects processed, no failed objects, and row exhaustion;
- deterministic manifest, object, and row hashes;
- non-overlapping hourly windows and preserved container lineage;
- exact row-component, category, efficiency, and currency arithmetic;
- active CUR2 generation identity and reconciliation within the approved micro-unit tolerance;
- stale, partial, empty, error, unknown, waiting, and configuration-required state behavior;
- bucket/prefix/CMK restrictions and absence of writer actions in the permanent collector;
- rendered UI labels Kubecost as allocation and CUR2 as authoritative spend.

This library adds no route, UI, persistence, role, export, credential, commit, deployment, or production acceptance by itself.
