# Sutra local one-account demo

This repository ships a demo-ready local slice and a separate path for a real
AWS sandbox account. The local slice is deliberately limited to one MSP
workspace and one AWS connection. Its database and collector contracts retain
explicit organization, customer, connection, account, partition, and Region
keys so the cloud version can add tenancy and fan-out without changing the
inventory schema.

## Reliable sales demo (no AWS account required)

```bash
pnpm install
pnpm pilot:setup
pnpm dev:pilot
```

Open `http://localhost:3000/onboard`. Use the prefilled pilot account, register
the displayed fixture role ARN, validate the trust contract, and run the first
sync. Fixture mode exercises the same HMAC boundary, encrypted connection
registry, schema validation, immutable D1 snapshot publication, UI, finding
workflow, and exports as live mode. It does not call AWS, and every screen labels
the source as fixture data.

The generated `.dev.vars` and `.sutra/` directory contain local secrets and
encrypted connection state. They are permission-restricted and ignored by Git.
Delete both to reset all collector trust material. Local D1 data is managed by
the vinext/Miniflare development runtime.

To repeat the onboarding demo while preserving the generated local keys, stop
the dev server, run `pnpm pilot:reset`, then start `pnpm dev:pilot` again.

## Real AWS sandbox demo

Use a disposable non-production AWS account. The local collector uses the AWS
SDK default credential provider chain; it does not accept long-lived AWS keys in
the Sutra UI or `.dev.vars`.

1. Configure a short-lived AWS profile, SSO session, or workload identity whose
   IAM role exactly matches `SUTRA_COLLECTOR_PRINCIPAL_ARN`.
2. Change `SUTRA_COLLECTOR_MODE=live` in `.dev.vars` and set that exact collector
   principal ARN.
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
- versioned resource, relationship, finding, and coverage payloads;
- strict byte/schema/count/reference/hash validation before persistence;
- immutable snapshots with complete-only CMDB head promotion;
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
| One local organization/customer | tenant authorization on every repository and export |
| Miniflare D1 | managed relational hot index plus backup/restore |
| Encrypted local registry | KMS-backed connection secret service |
| Loopback HMAC call | private authenticated queue/workflow |
| One collector process | AWS-hosted workers with workload IAM and regional fan-out |
| Manual sync | durable scheduler, leases, retries, quotas, and dead-letter handling |
| Local JSON evidence | bounded object storage, retention, deletion, and audit export |

Before hosting customer production data, add and independently test multi-tenant
authorization, real identity/MFA, durable jobs, managed key rotation, observability,
backups, retention/deletion, incident response, and sandbox acceptance tests. The
full gates remain documented in `docs/security-and-quality.md`.
