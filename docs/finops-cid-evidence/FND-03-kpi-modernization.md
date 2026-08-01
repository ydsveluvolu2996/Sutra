# FND-03 — KPI and Modernization Dashboard evidence record

Reviewed: 2026-08-01

Official source: <https://docs.aws.amazon.com/guidance/latest/cloud-intelligence-dashboards/cudos-cid-kpi.html#kpi-dashboard>

Immutable source revision: `f9e36d88c47709f10e8fa784ad11d5cc0e728021`

Current maturity: `LOCAL_VERTICAL_CANDIDATE`

## Official requirement inventory

- Governed modernization and optimization goals across lines of business.
- Percent On-Demand, Spot adoption, and Graviton usage tracking.
- Potential savings only when meeting a defined KPI can be evidenced.
- Opportunity discovery for infrequently used S3 buckets, old EBS snapshots,
  and Graviton-eligible usage.

## Immutable definition audit

The audit pins the AWS public CID repository at commit
`f9e36d88c47709f10e8fa784ad11d5cc0e728021`:

- manifest `dashboards/kpi_dashboard/KPI.yaml`, SHA-256
  `fd669f207c5589b4b54b981d6d85affb3af449871e908b85a4c1b9b357c35b1a`;
- analysis `dashboards/kpi_dashboard/KPI-definition.yaml`, SHA-256
  `299c6d39c55c28221b0d0d771358f526931d60fb5f4d00ba4f663d22554b89a1`;
- dashboard ID `kpi_dashboard`, version `v2.2.1`, category `Foundational`,
  theme `MIDNIGHT`;
- 10 sheets, 91 visuals, 60 sheet-level parameter controls, 34 filter
  controls, 50 parameter declarations, 191 calculated fields and 161 filter
  groups.

| Official sheet | Visuals | Parameter controls | Filter controls | Native evidence state |
|---|---:|---:|---:|---|
| KPI Tracker | 6 | 3 | 2 | Partial: all 19 governed formulas and goal progress are present; savings at goal is withheld without an approved rate assumption. |
| Set KPI Goals | 8 | 19 | 2 | Partial: all 19 goal families have versioned RBAC-protected persistence; the native dashboard remains read-only. |
| Metrics Summary | 14 | 10 | 2 | Partial: selected-period scorecard is present; simultaneous month-over-month pivots are not. |
| EC2 | 10 | 4 | 8 | Partial: previous-generation, Spot, Graviton and AMD coverage candidates are present; compatibility and savings rankings are withheld. |
| EBS | 18 | 5 | 2 | Partial: gp3 and snapshot KPIs are present; volume inventory, age and pricing evidence remain required. |
| S3 | 11 | 4 | 2 | Partial: storage-class concentration is present; bucket request inactivity and migration savings are not inferable from CUR. |
| RDS | 15 | 4 | 2 | Partial: Graviton and open-source coverage candidates are present; compatibility and migration savings remain unavailable. |
| Other Graviton | 5 | 5 | 3 | Partial: ElastiCache, OpenSearch and Lambda architecture candidates are present without migration savings claims. |
| Commit Optimizations | 2 | 6 | 9 | Partial: seven On-Demand ratios are present; purchase recommendations are not inferred from ratios. |
| About | 2 | 0 | 2 | Supported by the pinned definition and explicit evidence boundary. |

Visual-type totals reconcile exactly to the 91 published objects: 15 bar, 9
combo, 39 insight, 1 line, 3 pie, 20 pivot-table, 3 table and 1 word-cloud
visual. The native inventory is encoded in
`lib/finops-kpi-official-definition.ts` and verified by focused tests.

## Sutra implementation evidence

| Gate | Status | Evidence |
|---|---|---|
| G0 requirements | `VERIFIED` | Immutable v2.2.1 source, sheet, visual and control inventory above, reviewed 2026-08-01. |
| G1–G3 source/pipeline | `IMPLEMENTED_UNVERIFIED` | Active CUR2 generations plus versioned tenant KPI goals and immutable taxonomy publications. |
| G4 API | `IMPLEMENTED_UNVERIFIED` | Tenant-resolved read-only KPI report with bounded billing-period, linked-account and payer-account filters, plus separately authorized goal-management and taxonomy routes. |
| G5 visual UI | `IMPLEMENTED_UNVERIFIED` | Exact 10-sheet navigation, immutable 91-visual/94-control inventory, versioned 19-formula scorecard, account/payer/period filters, goal state, progress bars, evidence window, sheet-specific formula views, and unavailable/partial disclosures. |
| G6 focused verification | `VERIFIED` | Goal overlap/RBAC, exact formulas, source scope, currencies/units, missing compatibility/savings evidence, routes, migrations, repository, official inventory and UI pass in the focused 31-test set. |
| G7–G10 | `NOT_STARTED` | Exact-tree, controlled AWS reconciliation, reviewed release, immutable deployment, and live visual acceptance remain. |

## Evidence-honesty limits

Sutra withholds architecture compatibility and savings when billing or inventory
evidence cannot prove them. Billing-only signals do not become idle S3/EBS or
Graviton eligibility claims. Goals do not mutate source data or authorize
remediation. Resource-ID controls, S3 request inactivity, EBS snapshot age,
architecture compatibility, migration rates and commitment purchase
recommendations remain explicit gaps until their authoritative data sources are
registered and accepted.

Focused result: **31 passed, 0 failed, 0 skipped** across the KPI engine, goal
configuration migrations/repository/routes, exact official definition, native
SSR view, API contract and shared Foundational UI contract tests.
