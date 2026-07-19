# Sutra local functional demo

This repository ships a demo-ready local slice and a separately gated path for
a real AWS sandbox account. The local slice is deliberately limited to one MSP
organization, but it includes multiple deterministic simulated customer accounts
and tenant/customer/connection-scoped contracts. It is not hosted production
multitenancy.

## One-command morning start

After opening Docker Desktop, start the preserved local demo without rebuilding
the application image:

```bash
pnpm morning:start
```

The command starts PostgreSQL, applies pending migrations, starts Sutra, waits for
the health endpoint, and prints the login URL. It preserves and reuses the named
PostgreSQL and application volumes. If the application image is missing, it builds
it automatically.

After changing application code or dependencies, deliberately rebuild once:

```bash
pnpm morning:rebuild
```

Stop all local containers without deleting data:

```bash
pnpm morning:stop
```

Neither morning command contacts AWS or creates EKS infrastructure. Live AWS
collection still requires the guarded `pnpm live:aws:host` launch documented in
`docs/local-live-aws.md`. Disposable EKS creation remains a separate, explicitly
acknowledged operation because it incurs hourly charges and requires a fresh
expiry timestamp and validator `/32`.

## Reliable sales demo (no AWS account required)

```bash
pnpm install
pnpm pilot:setup
pnpm dev:pilot
```

On the first start, open `http://localhost:3000/login`. Run
`pnpm local:bootstrap-token` in a local terminal and paste the one-time setup
token into that screen, then create the owner password and enroll a TOTP
authenticator. Sutra stores only a costed password digest, a session-token digest,
and an encrypted TOTP secret. Every CMDB API requires the persisted session, MFA,
and the corresponding RBAC capability.

After MFA verification, open `http://localhost:3000/operations`:

1. Choose a simulated customer and snapshot version.
2. Select **Run simulated collection**. The request enters the durable local queue;
   the collector leases it, executes only its signed fixture catalog entry, and
   persists a verified result.
3. When the job succeeds, select **Publish to CMDB**. Publication revalidates the
   complete tenant/customer/connection/job lineage and atomically promotes the
   immutable snapshot.
4. To demonstrate unattended collection, configure a fixture under **Scheduled
   fixture collections**. Choose its evidence version and cadence, then select
   **Enable & run now**. The durable collector creates the first signed job
   immediately and future occurrences at the saved interval. Pausing suppresses
   new occurrences; resuming schedules one immediate occurrence without replaying
   the paused interval as a backlog. After laptop downtime, Sutra runs only the
   newest bounded set of due occurrences, records the count and time of older runs
   it skipped, and advances the durable cursor, so a restart cannot flood or block
   already-queued work. The collector retains the
   newest 10,000 terminal job records for each manual/scheduled trigger class;
   published CMDB snapshots remain durable in D1 while old collector execution
   receipts are pruned. The file store also enforces a byte-safe 16 MiB envelope:
   new work is admitted only below a 90% target, while the reserve remains available
   for leases and settlement so a full queue can drain. Old terminal receipts are
   pruned when needed, and an oversized active update never replaces the last
   readable state. Job-count saturation is persisted and shown as a queue-capacity
   warning on the affected schedule instead of failing silently.
5. Review each completed scheduled result and select **Publish to CMDB**. Scheduling
   never bypasses the explicit RBAC and provenance checks at the publication gate.
6. Open the snapshot to inspect resources, relationships, coverage, security groups,
   findings, and exports.
7. For a change demo, publish Northstar Retail `2026.07.0`, then `2026.07.1`, and
   open **Change history**. The evolved version deterministically records one added,
   one changed, and one removed resource.

No simulated run registers a trust role or calls AWS. The UI and persisted snapshot
both identify the source as `SIMULATED FIXTURE`. Signed broker responses, snapshot
hashes, durable job state, D1 publication, CMDB queries, finding workflows, and
exports are real local application paths rather than static demo cards.

Schedule mutations are also real cross-process operations. Sutra writes the exact
scoped command to a D1 outbox before contacting the collector, sends a deterministic
mutation identifier through the signed loopback boundary, and completes one
hash-chained audit event after the collector accepts it. A process interruption
leaves the command pending; the next Operations load replays it idempotently and
finishes the audit record rather than silently losing or duplicating the change.
Every outbox row also carries a durable monotonic sequence that the collector
enforces per schedule, so a delayed older replay cannot overwrite newer automation
state. Concurrent retries of one operation converge on the timestamp stored by the
winning insert.

The generated `.dev.vars` and `.sutra/` directory contain local secrets and
encrypted connection state. They are permission-restricted and ignored by Git.
Delete both to reset all collector trust material. Local D1 data is managed by
the vinext/Miniflare development runtime.

To reset all local application data—including schedules and durable jobs—while
preserving the generated local keys, stop the dev server, run `pnpm pilot:reset`,
then start `pnpm dev:pilot` again.

## Local backup and restore

Stop `pnpm dev:pilot` before either operation. Sutra refuses to copy or replace
state while the local web or collector port is open.

```bash
pnpm local:backup
pnpm local:restore -- .sutra/backups/<backup-directory>
```

The backup contains the D1 files, encrypted collector registry, and durable local
job/schedule state. It deliberately excludes `.dev.vars` and plaintext
encryption/signing keys. Every state file is
covered by a SHA-256 manifest, and one-way key fingerprints prevent a restore with
incompatible local keys. Keep `.dev.vars` in a separate secure secret backup.
Restore verifies the complete manifest before replacing any state and rolls back
the previous files if replacement fails. Backup directories are permission-
restricted under ignored `.sutra/backups/`; never attach them to issues, chats, or
source control.

## Real AWS sandbox demo

Use only the guarded host launcher and the complete runbook in
`docs/local-live-aws.md`. It isolates live PostgreSQL data and encryption keys from
the fixture stack, requires an explicit acknowledgement plus a short-lived named
AWS SSO/profile, performs the source-identity preflight, and starts the built web
and collector processes on the host. Do not enable live mode by editing `.dev.vars`,
do not run the manual collector preflight as a substitute for the launcher, and do
not place an AWS profile cache, access key, or session token in any Sutra file or
container.

Disable and offboard requests update Sutra's durable control-plane state before
they attempt local collector cleanup. They therefore still block new work when
the collector is stopped or is running in fixture mode. The onboarding page
reports collector cleanup as pending and provides an idempotent reconcile action
that can be repeated after the collector returns. Registering or replacing a
customer role and the initial irreversible offboard action require a fresh
six-digit authenticator code; emergency disable and idempotent cleanup retries do
not wait for a new step-up.

Local offboarding removes the role ARN and ExternalId material held by Sutra and
then asks the local collector to erase its copy. It does **not** call IAM,
CloudFormation, or otherwise delete or change the customer-owned AWS role. To
revoke AWS-side trust, the customer must separately delete the CloudFormation
stack or remove the role's trust policy. Confirm that revocation in AWS before
treating offboarding as complete.

Temporary STS credentials exist only inside the collector process. Browser and
control-plane responses contain normalized metadata and safe status codes, never
credentials, ExternalIds after creation, or raw AWS errors.

## What the pilot demonstrates

- server-generated, encrypted, connection-bound ExternalIds;
- exact role/account/partition binding and behavioral trust validation;
- signed, replay-resistant loopback collector requests and responses;
- persistent local identities, MFA, sessions, RBAC, and customer grants;
- collector-owned fixture discovery plus durable jobs, bounded retries, and explicit
  idempotent publication;
- persistent fixture schedules with signed scope, pause/resume controls, bounded
  catch-up, crash-safe audited mutation replay, and manual-versus-scheduled job
  provenance;
- versioned resource, relationship, finding, and coverage payloads;
- strict byte/schema/count/reference/hash validation before persistence;
- immutable snapshots with source provenance and complete-only CMDB head promotion;
- scoped resource add/change/remove history across complete snapshots;
- searchable CMDB, relationship counts, coverage, finding workflow, and exports;
- selected configuration checks and optional visibility into already-enabled AWS
  GuardDuty and Security Hub services.

This pilot is not an Amazon Inspector vulnerability scanner or a GuardDuty-style
runtime threat detector. It does not enable AWS billable security services and it
does not mutate customer resources.

## Scale-out path

The local process boundaries map directly to a hosted architecture:

| Local pilot | Hosted MSP platform |
| --- | --- |
| One local operator | OIDC/SAML users, MFA, invitations, scoped grants |
| One local organization with simulated customers | production tenants, invitations, isolation tests, and lifecycle controls |
| Miniflare D1 | managed relational hot index plus backup/restore |
| Encrypted local registry | KMS-backed connection secret service |
| Loopback HMAC call | private authenticated queue/workflow |
| One collector process | AWS-hosted workers with workload IAM and regional fan-out |
| Durable local file queue and explicit publication | managed scheduler/workflow, distributed leases, quotas, and dead-letter operations |
| Local JSON evidence | bounded object storage, retention, deletion, and audit export |

Before hosting customer production data, add and independently test true multi-tenant
provisioning and isolation, managed identity/SSO, managed distributed jobs, managed
key rotation, observability, retention/deletion, incident response, disaster
recovery, and sandbox acceptance tests. The full gates remain documented in
`docs/security-and-quality.md`.
