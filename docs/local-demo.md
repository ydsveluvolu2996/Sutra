# Sutra local functional demo

This repository ships a demo-ready local slice and a separately gated path for
a real AWS sandbox account. The local slice is deliberately limited to one MSP
organization, but it includes multiple deterministic simulated customer accounts
and tenant/customer/connection-scoped contracts. It is not hosted production
multitenancy.

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
4. Open the snapshot to inspect resources, relationships, coverage, security groups,
   findings, and exports.
5. For a change demo, publish Northstar Retail `2026.07.0`, then `2026.07.1`, and
   open **Change history**. The evolved version deterministically records one added,
   one changed, and one removed resource.

No simulated run registers a trust role or calls AWS. The UI and persisted snapshot
both identify the source as `SIMULATED FIXTURE`. Signed broker responses, snapshot
hashes, durable job state, D1 publication, CMDB queries, finding workflows, and
exports are real local application paths rather than static demo cards.

The generated `.dev.vars` and `.sutra/` directory contain local secrets and
encrypted connection state. They are permission-restricted and ignored by Git.
Delete both to reset all collector trust material. Local D1 data is managed by
the vinext/Miniflare development runtime.

To reset local application data while preserving the generated local keys, stop the
dev server, run `pnpm pilot:reset`, then start `pnpm dev:pilot` again.

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

Use a disposable non-production AWS account. The local collector uses the AWS
SDK default credential provider chain; it does not accept long-lived AWS keys in
the Sutra UI or `.dev.vars`.

1. Configure a short-lived AWS profile, SSO session, or workload identity whose
   IAM role exactly matches `SUTRA_COLLECTOR_PRINCIPAL_ARN`.
2. Change `SUTRA_COLLECTOR_MODE=live`, set `SUTRA_ALLOW_LIVE_AWS=true`, and set
   that exact collector principal ARN in `.dev.vars`. Without both live-mode
   settings the collector refuses to start.
3. Start Sutra with `pnpm dev:pilot`.
4. Create the connection in Sutra. Copy its generated ExternalId and collector
   principal.
5. Deploy `public/sutra-customer-role.yaml` once in the customer account with
   those values. The default customer role is `/sutra/SutraReadOnlyRole`.
6. Register the stack output RoleArn. Sutra activates it only after the correct
   ExternalId succeeds, `GetCallerIdentity` matches, and missing/wrong ExternalId
   probes are denied.
7. Run inventory and review the collector coverage before relying on results.

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
