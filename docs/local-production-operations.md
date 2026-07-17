# Sutra local production operations

This runbook covers the production-shaped local stack. It does not turn a laptop
deployment into a highly available hosted service, and it does not authorize AWS
collection. The approved recovery objectives are a 24-hour RPO and four-hour RTO.

## Daily health review

1. Run `pnpm docker:up` and wait for both PostgreSQL and the application health
   checks.
2. Open Operations and verify collection freshness, queue capacity and failed
   schedules. AWS collection must remain disabled while the billing investigation
   is open.
3. Open Settings → Notifications. Review enabled routes, oldest actionable job,
   retries, adapter-blocked jobs and dead letters. A saved destination is not
   delivery-ready until the separate worker and provider adapter are configured.
4. Open the executive report. Treat stale evidence, collector gaps and unknown
   controls as review blockers. Readiness mappings are not certifications.

## Coordinated backup

Run:

```sh
pnpm db:postgres:backup
```

The command stops the application, produces a PostgreSQL custom dump and matching
application-state archive, hashes both, records runtime-key fingerprints and
restarts only after health checks pass. Backup manifests and data remain in the
ignored, permission-restricted `.sutra/postgres-backups` directory. Copy them
together to separately encrypted storage; GitHub is not a backup destination.

## Non-destructive recovery drill

First create a fresh backup, then run:

```sh
pnpm db:postgres:recovery-drill -- \
  --from .sutra/postgres-backups/<backup>.dump \
  --confirm-isolated-drill
```

The drill verifies manifest checksums, restores the PostgreSQL dump to a temporary
database, checks required tables and tenant referential integrity, validates that
the application-state archive is readable, drops the temporary database and writes
immutable-style evidence under `.sutra/recovery-drills`. It never replaces the
production database. A passing drill records measured recovery-point age and
duration against the 24-hour RPO and four-hour RTO.

The full destructive restore command remains:

```sh
pnpm db:postgres:restore -- \
  --from .sutra/postgres-backups/<backup>.dump \
  --confirm-restore
```

Use destructive restore only during an approved incident. It creates pre-restore
rollback artifacts, restores database and application state as one unit, migrates
forward, and starts the application only after health checks. Preserve the drill
evidence and incident timeline.

## Notification incident triage

- `blocked`: configure the worker's workload identity or managed-secret adapter;
  do not repeatedly enqueue tests.
- `degraded`: inspect retry codes and job age. Fix the provider dependency, then
  use a reviewed replay procedure rather than editing the database.
- `dead_letter`: preserve the job and audit evidence, correct the permanent
  configuration fault, and create a new idempotent test.
- A healthy queue proves delivery processing only. It does not prove that a human
  read or acted on the message.

## Release and incident evidence

For every customer demonstration or private-beta release, retain:

- application commit and migration identifiers;
- passing test and build output;
- latest recovery-drill evidence and backup location;
- notification health and delivery-test result;
- snapshot and report SHA-256 values;
- all evidence gaps, exceptions and unconfigured runtime modules.

Escalate cross-tenant scope failures, audit gaps, restore failures, unexplained
deletion deltas or compromised integration credentials immediately. Stop affected
workers, preserve evidence and revoke the narrow credential before recovery.
