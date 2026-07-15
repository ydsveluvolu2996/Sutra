# Contributing to Sutra

Sutra is a pre-production, security-sensitive foundation. Contributions should
preserve the read-only first-release boundary and make the difference between demo,
sandbox, and production behavior unmistakable.

## Set up the repository

Use a current Node.js 22 LTS patch (`>=22.13.0` is the package engine floor) and
pnpm 10. `pnpm-lock.yaml` is the canonical dependency lockfile even though a legacy
`package-lock.json` is currently present.

```bash
corepack enable
corepack prepare pnpm@10.13.1 --activate
pnpm install --frozen-lockfile
pnpm dev
```

Do not run npm install or submit incidental `package-lock.json` changes. If a
dependency change is intentional, use pnpm, explain why it is needed, review its
transitive impact, and commit the resulting `pnpm-lock.yaml` update.

The demo requires no AWS credentials. Use synthetic data and a disposable sandbox
for integration work. Read `SECURITY.md` before handling IAM, ExternalIds, account
metadata, logs, or reports.

## Before opening a pull request

Run the baseline checks:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:rendered
```

Add focused tests for the behavior you change. The current smoke tests are not an
adequate security suite. Any customer-scoped API, repository, job, cache, export,
or object path needs positive and negative tests with at least two organizations
and two customers, including overlapping resource identifiers.

Keep pull requests small and describe:

- the problem and bounded behavior changed;
- whether the change affects demo, sandbox, staging, or production paths;
- tenant, IAM, credential, data-retention, migration, and failure-mode impact;
- test evidence and any checks that could not be run; and
- rollout, compatibility, and rollback/forward-fix considerations.

Do not claim production readiness because the UI, build, template deployment, or a
happy-path sandbox scan works. Link the relevant P0 gate and its acceptance evidence.

## Security and architecture rules

- Derive organization/customer scope from authenticated server-side membership.
  Never authorize from browser-supplied IDs, roles, email, account IDs, or resource
  identifiers.
- Require both `org_id` and `customer_id` on customer data, queries, jobs, caches,
  objects, exports, and audit events. Avoid unscoped lookup helpers in public and job
  code.
- Keep AWS credentials out of browser/control-plane responses, storage, queues,
  logs, traces, fixtures, and exceptions. Only the isolated broker may assume a
  registered customer role.
- Keep the CMDB role read-only. A resource-management feature must use the separate
  remediation-plane design and may not widen the collector role.
- Treat AWS names, tags, ARNs, errors, and imported evidence as untrusted input.
  Bound and validate it on ingestion and encode it for HTML, JSON, CSV, logs, and
  exports.
- Preserve partial-failure semantics. Missing or inaccessible evidence is `unknown`
  or `error`; incomplete scans cannot retire resources or replace a complete
  snapshot.
- Redact secrets and sensitive bindings through allowlist logging. New environment
  variables must be documented in `.env.example` with non-secret placeholders and
  provisioned through managed secrets in deployed environments.

Changes to the target architecture should update the relevant documents in `docs/`
in the same pull request. Changes to IAM permissions must explain every new action,
its returned data, why a narrower action is insufficient, its default/opt-in status,
and the sandbox tests used to verify it.

## Database and control changes

Schema changes need a reviewed forward-only migration, tenant-safe constraints and
indexes, compatibility reasoning, and a restore/forward-fix plan. Do not edit a
previously released migration.

Security controls need a stable ID and version, applicability and permission
contract, deterministic fixtures, severity rationale, evidence schema, remediation
guidance, false-positive/limitation notes, and explicit behavior for missing or
partial evidence. Historical evaluations must remain attributable to the exact rule
and input versions that produced them.

## Commit and review hygiene

Never include real credentials or customer data. Check staged changes and generated
artifacts before pushing. Security fixes should use the private reporting and
coordinated-disclosure process in `SECURITY.md`, not a public pull request containing
exploit details.

At least one reviewer familiar with the affected boundary should approve changes to
authentication, tenant authorization, IAM/STS, broker/job protocols, schema scope,
ingestion, exports, controls, encryption, logging, retention, or deployment. A
production workflow must also enforce branch protection and required checks outside
this repository.
