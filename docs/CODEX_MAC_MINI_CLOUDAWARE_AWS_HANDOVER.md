# Sutra AWS CMDB build — Codex Mac Mini continuous handover

Last prepared: 2026-08-21

Research-pack baseline: `f597d85d2694e6c006896ca470f02a570751ad36`

Working branch: `develop`

## 1. Purpose and authority

This document hands the CloudAware-informed AWS CMDB research to a Codex session running continuously on the Mac Mini. The goal is to build equivalent AWS product capabilities in Sutra through original implementation, not to copy CloudAware branding, source code, text, icons, or proprietary assets.

The research and implementation roadmap are ready. The full implementation is not yet complete or deployed.

Before doing any work, read these files completely, in this order:

1. `CLAUDE.md`
2. `AGENTS.md`
3. This handover
4. `docs/research/cloudaware-aws-product-map/README.md`
5. `docs/research/cloudaware-aws-product-map/05-sutra-gap-analysis.md`
6. `docs/research/cloudaware-aws-product-map/06-implementation-roadmap.md`
7. The research file for the vertical being implemented

`CLAUDE.md` is the highest repository authority. This handover supersedes `docs/CODEX_MAC_MINI_HANDOVER.md` only for this CloudAware-informed AWS CMDB workstream; it does not override current repository, security, release, or FinOps policies.

This handover authorizes implementation, testing, commits, and pushes to `develop`. It does not authorize:

- merging into `main`;
- deploying to production;
- changing a live AWS, Google, Cloudflare, or other external account;
- pasting or logging credentials;
- bypassing required checks or approvals.

Merging and deployment always require separate, explicit instructions from the user in the current turn, as defined in `AGENTS.md` and `CLAUDE.md`.

## 2. Captured research pack

The source-of-truth research pack is:

- `docs/research/cloudaware-aws-product-map/README.md`
- `docs/research/cloudaware-aws-product-map/01-product-shell-and-navigation.md`
- `docs/research/cloudaware-aws-product-map/02-aws-onboarding-and-administration.md`
- `docs/research/cloudaware-aws-product-map/03-aws-service-and-resource-catalog.md`
- `docs/research/cloudaware-aws-product-map/04-modules-and-operating-model.md`
- `docs/research/cloudaware-aws-product-map/05-sutra-gap-analysis.md`
- `docs/research/cloudaware-aws-product-map/06-implementation-roadmap.md`
- `docs/research/cloudaware-aws-product-map/raw/`
- `docs/research/cloudaware-aws-product-map/graphify-out/graph.html`
- `docs/research/cloudaware-aws-product-map/graphify-out/GRAPH_REPORT.md`
- `docs/research/cloudaware-aws-product-map/graphify-out/graph.json`

The captured reference taxonomy contains:

- 18 AWS category families;
- 114 service destinations;
- 978 CMDB object types;
- 317 taggable resource types.

These numbers describe the reference catalog, not Sutra's implemented or live-tested coverage. Never show a cataloged type as collected merely because it exists in the research data.

The research session inspected the signed-in reference product read-only. No AWS account was connected there, so visible inventory counts were zero. Public documentation supplemented navigation and workflow observations. The research did not capture cookies, private API payloads, credentials, source code, or proprietary design assets.

## 3. Current Sutra capability baseline

Reuse the existing implementation before creating anything new. Sutra already has:

- tenant-isolated organization, customer, and connection scopes;
- Google/Zoho OIDC and account-scoped application gates;
- AWS IAM-role onboarding with ExternalId, CloudFormation Quick Create, and manual artifacts;
- a feature-gated, Secrets Manager-backed static access-key fallback;
- an application shell with capability-filtered navigation;
- CMDB snapshots, search/filtering, Resource 360, saved queries, annotations, custom fields, custom assets, relationships, and blast-radius traversal;
- security, compliance, FinOps, operations, reporting, notification, and selected integration surfaces;
- PostgreSQL persistence and a separate AWS collector service.

The current main AWS inventory runner covers a useful but limited group of resource types concentrated around EC2/VPC, ELBv2, S3, RDS instances, DynamoDB, KMS, ECR, EKS, IAM account posture, CloudTrail, GuardDuty, Security Hub, SSM patch state, and Bedrock guardrails. Treat the code as the truth: architecture documents may describe types not yet normalized by the runner.

Important gaps include:

- a complete category → service → resource-type Navigator;
- broad AWS resource coverage outside the current collector set;
- organization-wide multi-account onboarding;
- unified server-backed global search;
- richer relationship extraction and a visual topology canvas;
- event-driven reconciliation and change subscriptions;
- production inventory scheduling and per-service collection health;
- dedicated Tag Analyzer, AWS Backup, and CloudWatch-style workspaces;
- a broader integration and administration catalog;
- real-provider acceptance for several implemented paths.

## 4. Non-negotiable product and security contracts

Every implementation slice must preserve these contracts.

### Tenant isolation

- Resolve organization, customer, connection, and AWS account scope on the server from the authenticated membership.
- Never accept a client-supplied tenant scope as authority.
- Scope every database read/write, cache key, background job, export, search result, relationship traversal, setting, and notification.
- A user must only see the organizations, customers, connections, AWS accounts, resources, and settings granted to that membership.
- Add negative two-tenant tests for new data paths. A successful same-tenant test is not sufficient.

### AWS credentials and onboarding

- IAM role with ExternalId remains the recommended path.
- Preserve CloudFormation Quick Create and manual role creation.
- Keep collection permissions least-privilege and read-only.
- Static access keys remain a fallback and may only be enabled through the existing Secrets Manager design and feature gate. Never store raw credentials in PostgreSQL, browser state, logs, fixtures, screenshots, or repository files.
- The collector owns AWS credential use and provider calls. The web application must not become a second AWS SDK execution plane.
- Organization onboarding must use management/delegated-admin trust, member-account discovery, explicit selection, per-account verification, and visible coverage states.

### Truthful collection states

Represent at least these states where applicable:

- loading;
- configuration required;
- waiting for first collection;
- verified empty;
- partial coverage;
- stale last-known-good data;
- failed with retained last-known-good data;
- complete for the declared boundary.

Never turn unavailable, unconfigured, permission-denied, timed-out, stale, or not-yet-implemented data into a truthful-looking zero.

### Collector and persistence

- Use bounded, paginated, deadline-aware AWS reads with explicit retry and throttling behavior.
- Record Region, partition, account, permission, and adapter coverage.
- Accept snapshots atomically and retain immutable evidence plus the last known good state.
- Keep source provenance and timestamps visible in APIs and UI.
- Register schema changes in every repository-required migration registry.
- Keep read-only collection separate from any future remediation/write plane.

### Runtime and operations

- Respect the current production topology: Dockerized application and PostgreSQL on the same managed single EC2 private-beta host, with the AWS collector as a separate service boundary.
- Do not claim high availability, organization coverage, or provider acceptance that has not been proven.
- Do not weaken the release workflow, environment approval, exact-SHA verification, rollback, health checks, or secret scanning.

### Original design

- Use the reference product to understand information architecture and workflow quality.
- Implement Sutra's own visual system, copy, components, and interaction details.
- Do not copy reference branding, logos, proprietary text, images, icons, HTML, CSS, or hidden/private data.

## 5. Mandatory implementation sequence

Work in complete vertical slices. Do not create a broad set of disconnected placeholders.

### Gate A — reconcile repository prerequisites

1. Run `pnpm work:start` and confirm a clean, current `develop` branch.
2. Read the current FinOps tracker and shared-file ownership rules referenced by `CLAUDE.md`.
3. If a mandatory prerequisite such as ADV-05 or a reserved shared integration lane is still open, respect it. Do not silently override it with this roadmap.
4. Inventory the existing implementation for the selected slice and classify each part as `REUSE_AS_IS`, `REPAIR`, `MISSING`, or `UNAVAILABLE_BY_CONTRACT`.
5. Record the exact baseline SHA, Node version, pnpm version, and selected vertical in the implementation ledger.

### Milestone 0 — catalog contracts and Navigator foundation

Build a versioned canonical AWS catalog using the captured 18/114/978/317 taxonomy as input. For every category, service, and resource type, track maturity separately:

- cataloged;
- planned;
- implemented in collector;
- accepted with real provider evidence;
- unavailable by explicit contract.

Deliver original Sutra Navigator pages with category/service/type routes, breadcrumbs, server-scoped counts, coverage state, Region/account scope, recent/pinned destinations, and search. Reuse the existing application shell and CMDB routes. Unsupported or uncollected types must display an honest state, not zero resources.

### Milestone 1 — first full service vertical: VPC networking

Start with VPC because Sutra already has VPCs, subnets, security groups, route tables, internet gateways, flow-log posture, network ACLs, and elastic IP foundations.

First integrate existing data into the canonical catalog, Navigator, coverage, search, and Resource 360. Then add missing networking adapters in bounded slices, such as NAT gateways, transit gateways, VPC endpoints, peering, VPN, Direct Connect, route propagation, and richer topology.

Each bounded slice must include the adapter, IAM action, normalization, persistence, API, tenant scope, UI states, relationships, focused tests, and evidence update before moving on.

### Milestone 2 — organization-scale onboarding

Add organization onboarding without weakening per-account isolation:

- management or delegated-admin role templates;
- organization/account discovery;
- explicit member-account selection;
- per-account trust and permission verification;
- Region and partition policy;
- progress, partial, retry, disable, and offboard states;
- customer/account assignment enforcement.

### Milestone 3 — collector breadth waves

Deliver one service vertical at a time in this order, adjusting only when current code evidence shows a safer dependency order:

1. networking depth;
2. compute, containers, and serverless;
3. storage and databases;
4. governance, identity, and security metadata;
5. application integration and analytics;
6. AI/ML and specialist AWS services.

Do not claim completion from catalog rows alone. A resource type becomes implemented only after collection, normalization, persistence, tenant-scoped serving, truthful UI, tests, and evidence are complete.

### Milestone 4 — relationship and change intelligence

Expand typed relationships, dependencies, dependents, blast radius, resource timelines, configuration diffs, and last-known-good evidence. Add a visual topology canvas only after the underlying relationship graph is tenant-safe and tested.

### Milestone 5 — operational modules

Build dedicated, evidence-backed modules for:

- Tag Analyzer;
- AWS Backup inventory and coverage;
- CloudWatch metrics/logs/alarms metadata;
- production collection schedules, retries, cancellation, and service health;
- permission drift and stale-data alerts.

### Milestone 6 — integrations and administration

Add customer-scoped integration cards, health, credentials metadata, API credentials, subscriptions, audit visibility, and carefully selected SIEM/SOAR/observability connectors. Preserve existing Jira, ServiceNow, email, Slack, Teams, and PagerDuty work where applicable.

### Milestone 7 — governed automation and AI

Only after collection truth, tenancy, audit, and approval primitives are mature, add recommendations or automation. Keep any write/remediation action separately authorized, least-privilege, previewable, auditable, reversible where possible, and disabled by default.

## 6. Continuous checkpoint loop

Repeat this loop while safe, useful work remains.

1. **Synchronize** — run `pnpm work:start`; stop on an unexplained dirty tree.
2. **Read the ledger** — continue the first incomplete vertical instead of starting a competing slice.
3. **Inspect before editing** — map existing UI, API, library, database, collector, IAM, migration, test, and documentation paths.
4. **Bound the slice** — list intended files and one measurable vertical outcome.
5. **Implement end to end** — include tenant isolation, truthful states, provider coverage, error paths, and original UI polish.
6. **Verify proportionally** — run focused tests, affected typechecks, affected lint, secret scan, migration checks, and render/browser checks where relevant. Use Node `v22.23.2` for authoritative repository verification.
7. **Update evidence** — maintain `docs/CLOUDAWARE_AWS_IMPLEMENTATION_LEDGER.md` with the fields below. Create it on the first implementation checkpoint if it does not exist.
8. **Save safely** — run `pnpm work:save -- "<specific vertical outcome>"` so changes are committed and pushed to `develop` and the single standing `develop → main` pull request is updated.
9. **Watch exact CI** — fix a red standing-PR run immediately. Do not stack another vertical on unverified code.
10. **Continue** — select the next incomplete dependency-safe vertical and repeat.

The implementation ledger must record:

- date and baseline/final commit;
- vertical and measurable outcome;
- files and shared integration points changed;
- resource types and AWS API operations added;
- IAM policy changes;
- migrations and all registries updated;
- tenant-isolation tests;
- focused tests/typechecks/lint/secret scan/render results;
- live-provider evidence or explicit `PENDING_EXTERNAL_ACCEPTANCE`;
- known limitations and exact next slice;
- standing PR and CI run URL.

If context is compacted, the Mac restarts, or Codex is resumed, read this handover and the ledger before editing. Never infer progress from memory alone.

## 7. Vertical definition of done

A resource/service vertical is done only when all applicable items are complete:

- canonical catalog entry and maturity state;
- bounded/paginated collector adapter;
- least-privilege IAM permission and template update;
- normalized immutable snapshot evidence;
- database schema/migration and every registry update;
- organization/customer/connection/account-scoped repository and API;
- honest UI states, Navigator integration, search, and Resource 360;
- relationships and change evidence where available;
- same-tenant positive and cross-tenant negative tests;
- permission-denied, timeout, partial, stale, and retry tests;
- focused typecheck, lint, secret scan, and UI/render verification;
- real AWS sandbox acceptance or an explicit external-acceptance blocker;
- ledger and roadmap evidence update.

## 8. External acceptance boundary

Use disposable, least-privilege AWS sandbox accounts for provider acceptance. Validate at least two Sutra tenants and two distinct AWS account scopes before claiming isolation acceptance. Organization onboarding also needs an AWS Organizations sandbox with management/delegated-admin coverage.

If the necessary account, permission, budget, or credential is unavailable:

- do not paste credentials into chat or a repository file;
- do not fabricate acceptance;
- finish safe local code and tests;
- mark the exact case `PENDING_EXTERNAL_ACCEPTANCE` in the ledger;
- state the minimal user action needed.

Browser/UI verification should use a local or authorized test environment. Lack of access to the reference product must not block implementation because the captured research pack is the source of truth.

## 9. Git and release workflow

There is exactly one development branch: `develop`.

- Start or resume with `pnpm work:start`.
- Save verified checkpoints with `pnpm work:save -- "<what changed>"`.
- Do not create feature branches or extra pull requests.
- Keep the single standing pull request `develop → main` healthy.
- Do not force-push, rewrite `main`, bypass branch protection, or approve a different release run.
- Merge only after the user says `commit to main` or equivalent in that current turn.
- Deploy only after the user says `deploy` in that current turn.
- For an authorized deployment, state the exact current `origin/main` SHA and run `pnpm deploy:ec2 -- "<approved reason>"`; continue through exact-run approval, EC2 update, and live verification.

Implementation checkpoints on `develop` are allowed by this handover. Main promotion and production deployment are not.

## 10. Mac Mini preparation

Use the existing Mac Mini clone if it is clean and current. Otherwise, create a dedicated clone. Do not use a dirty historical clone.

```bash
mkdir -p /Users/Shared/sutra-codex
cd /Users/Shared/sutra-codex
git clone https://github.com/ydsveluvolu2996/Sutra.git
cd Sutra
corepack enable
corepack prepare pnpm@11.13.1 --activate
pnpm install --frozen-lockfile
pnpm work:start
gh auth status
```

The active GitHub account must be authorized to push `develop`. Never print or paste a token. Codex CLI normally reuses its saved authentication.

Run the continuous handover from the repository root:

```bash
codex exec --sandbox workspace-write "Read docs/CODEX_MAC_MINI_CLOUDAWARE_AWS_HANDOVER.md completely. Then execute the section named 'Ready-to-paste continuous execution prompt'. Continue through verified develop checkpoints until the roadmap is complete or a genuine blocker remains."
```

For an unattended Mac Mini run that remains active after the terminal closes and prevents the Mac from sleeping, use:

```bash
mkdir -p /Users/Shared/sutra-codex/logs
nohup caffeinate -dimsu codex exec --sandbox workspace-write "Read docs/CODEX_MAC_MINI_CLOUDAWARE_AWS_HANDOVER.md completely. Then execute the section named 'Ready-to-paste continuous execution prompt'. Continue through verified develop checkpoints until the roadmap is complete or a genuine blocker remains." > /Users/Shared/sutra-codex/logs/cloudaware-aws-codex.log 2>&1 &
```

Follow its progress from any terminal:

```bash
tail -f /Users/Shared/sutra-codex/logs/cloudaware-aws-codex.log
```

This is intentionally one long-running execution, not an infinite relaunch loop. A genuine blocker must remain stopped until a human resolves it; repeatedly relaunching the same blocked action can waste compute or produce conflicting checkpoints.

If the Mac or Codex session stops, resume the latest non-interactive session:

```bash
codex exec resume --last "Read the handover and implementation ledger again, verify repository state, and continue the first incomplete safe vertical."
```

Use explicit `workspace-write` sandboxing. Do not use `danger-full-access` or rely on deprecated `--full-auto` behavior. Reference: <https://learn.chatgpt.com/docs/non-interactive-mode>.

## 11. Genuine stop conditions

Stop, preserve a safe checkpoint when possible, and report the exact blocker if any of these occur:

- unexplained local changes or a merge/rebase conflict;
- a conflict between this handover and `CLAUDE.md`/`AGENTS.md`;
- overlapping ownership of a shared integration file;
- an unsafe or ambiguous migration, IAM, tenancy, credential, or data-retention decision;
- a required external permission, provider account, budget, or credential is unavailable;
- required CI is red and cannot be fixed from the current repository evidence;
- the next action would merge `main`, deploy, or mutate an external system without current authorization.

A difficult task, long roadmap, context compaction, or one failed test is not by itself a reason to stop. Diagnose, repair, verify, save, and continue while the work remains inside the authorized boundary.

## 12. Ready-to-paste continuous execution prompt

```text
You are continuing the Sutra AWS CMDB implementation on a dedicated Mac Mini.

Work autonomously and continuously, but only inside the authority described below. Do not stop after making a plan. Implement a bounded end-to-end vertical, verify it, save it to develop, confirm the exact standing-PR CI result, and continue to the next dependency-safe vertical while useful work remains.

Start by running pnpm work:start and reading, completely and in order: CLAUDE.md, AGENTS.md, docs/CODEX_MAC_MINI_CLOUDAWARE_AWS_HANDOVER.md, docs/research/cloudaware-aws-product-map/README.md, docs/research/cloudaware-aws-product-map/05-sutra-gap-analysis.md, docs/research/cloudaware-aws-product-map/06-implementation-roadmap.md, the current implementation ledger if present, and the research file for the chosen vertical. CLAUDE.md is authoritative.

Treat the captured CloudAware material as product research only. Build original Sutra code, UI, copy, and assets. Do not access private reference APIs, copy branding or proprietary assets, or depend on a live reference session.

Before editing, reconcile repository prerequisites and shared-file ownership. Respect current FinOps/ADV-05 requirements and reserved integration lanes. Inspect and reuse the existing Sutra implementation. Classify relevant code as REUSE_AS_IS, REPAIR, MISSING, or UNAVAILABLE_BY_CONTRACT. Use one integrator for shared files. If bounded subagents are useful, give them disjoint read-only or file-owned tasks, collect their results, and close or interrupt them when finished so no stale work remains.

Execute the roadmap in this order unless concrete current-code dependencies require a safer order: catalog contracts and Navigator foundation; the complete VPC networking vertical; organization-scale onboarding; collector breadth waves; relationship/topology and change intelligence; Tag Analyzer/AWS Backup/CloudWatch/scheduling operations; integrations and administration; governed automation and AI.

For every slice, complete the collector adapter, least-privilege IAM, normalization, persistence and migration registries, server-derived tenant scope, API, honest UI states, search/Navigator/Resource 360 integration, relationships where applicable, positive and cross-tenant negative tests, failure and stale-data behavior, focused verification, and evidence update. Never represent unsupported, unavailable, unconfigured, permission-denied, stale, partial, or not-yet-collected data as a true zero. Never store or expose raw AWS credentials. Keep AWS SDK activity in the collector boundary.

Maintain docs/CLOUDAWARE_AWS_IMPLEMENTATION_LEDGER.md. Record exact SHAs, outcome, files, resource types and APIs, IAM and migrations, isolation/security tests, verification, external acceptance, limitations, next slice, PR, and CI. Use Node v22.23.2 for authoritative verification. If a real AWS sandbox is unavailable, complete safe local work and mark PENDING_EXTERNAL_ACCEPTANCE; never fabricate acceptance or request credentials in chat.

After each verified vertical checkpoint, run pnpm work:save -- "<specific outcome>". Push only to develop and keep exactly one standing develop → main pull request. Wait for and inspect the exact CI run; fix red CI before starting another vertical. Do not create feature branches. Do not merge main. Do not deploy. Do not mutate AWS, Google, Cloudflare, GitHub settings, or any other external system unless the user gives explicit current-turn authorization for that exact mutation.

If interrupted or resumed, reread the handover and ledger, inspect git and CI state, and continue the first incomplete vertical. Stop only for a genuine authorization, safety, credential, provider, ownership, or unresolvable CI blocker. When blocked, leave the repository recoverable, save any safe verified checkpoint to develop, and report the exact blocker and next command. Otherwise continue until the documented roadmap and acceptance criteria are genuinely complete.
```
