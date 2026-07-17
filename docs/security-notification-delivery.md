# Security notification delivery boundary

Sutra builds provider-neutral notification payloads before delivery. The
delivery worker accepts only managed-secret references for Slack and Microsoft
Teams; webhook URLs must never be sent by a browser, written to D1, logged, or
included in a job payload.

## Provider contracts

- Amazon SES uses the SES v2 `SendEmail` HTTPS endpoint for the selected AWS
  region. The injected transport signs each request with workload IAM
  credentials. Static AWS access keys are not part of the adapter contract.
- Slack accepts only an HTTPS Incoming Webhook on the exact
  `hooks.slack.com` hostname and a `/services/...` path.
- Microsoft Teams accepts only an HTTPS Workflow webhook whose exact hostname
  matches the hostname stored with the secret and whose hostname belongs to
  `logic.azure.com` or `environment.api.powerplatform.com`.

The managed secret record contains the URL and its expected hostname. Only a
tenant- and channel-scoped reference such as
`secret://notifications/org-id/customer-id/slack/primary` crosses the job
boundary. Both the authenticated API and the worker enforce that scope. With
the default `sutra/notifications/` prefix, the example resolves only
`sutra/notifications/org-id/customer-id/slack/primary` in Secrets Manager.

The Secrets Manager value is a bounded JSON document:

```json
{
  "version": 1,
  "channel": "slack",
  "webhookUrl": "https://hooks.slack.com/services/WORKSPACE/CHANNEL/REDACTED",
  "expectedHostname": "hooks.slack.com"
}
```

Teams uses the same shape with `channel` set to `microsoft_teams` and the exact
Workflow hostname. `idempotencyHeader` may be set to `Idempotency-Key` only
when the receiving Workflow actually deduplicates that value. Unknown fields,
cross-channel documents, binary secrets, and values above 16 KiB are rejected.

## Network requirements

The HTTP transport must:

1. connect only to the DNS addresses validated by the adapter;
2. preserve the validated hostname for TLS SNI and certificate verification;
3. disable redirects;
4. abort after five seconds; and
5. stop reading after 16 KiB.

Pinning the validated addresses is mandatory. A normal `fetch` after a separate
DNS lookup is not sufficient because it permits DNS rebinding. Any private,
loopback, link-local, multicast, documentation, or mixed public/private DNS
answer rejects the delivery.

The deployed Node transport uses a custom HTTPS lookup callback to connect
only to the already-validated address while retaining the original hostname
for TLS SNI and certificate verification. DNS, Secrets Manager, webhook, and
SES operations are bounded to five seconds. Redirects are not followed.

Payloads are capped at 128 KiB for SES, 48 KiB for Slack, and 64 KiB for Teams.
Provider response bodies and thrown error messages are never returned. Results
contain only the channel, retry classification, status code, sanitized error
code, and a bounded `Retry-After` value.

Slack Incoming Webhooks and SES v2 `SendEmail` do not provide an idempotency
contract. A Teams Workflow can opt into `Idempotency-Key` only when that
workflow is explicitly configured to deduplicate the notification ID. The
queue remains responsible for at-most-once claim semantics.

## Worker runtime

The worker is a separate process and never runs inside an authenticated web
request:

```bash
DATABASE_URL='postgresql://sutra_app:REDACTED@postgres:5432/sutra' \
AWS_REGION=ap-south-1 \
SUTRA_NOTIFICATION_SECRET_PREFIX='sutra/notifications/' \
pnpm notification:worker
```

`GET /healthz` is the process liveness probe. `GET /readyz` returns 200 only
while the polling loop is ready. Logs contain event names, sanitized outcomes,
and counters only; destination URLs, secret references, provider bodies, and
exception messages are excluded.

The dedicated image is built from
`services/notification-worker/Dockerfile`. The local Compose service is
deliberately behind the `notifications` profile:

```bash
SUTRA_NOTIFICATION_WORKER_CONFIGURED=true \
docker compose --profile notifications up -d --build
```

Do not put AWS keys or webhook URLs in Compose environment variables. In AWS,
run the image with an ECS task role, EKS IRSA role, or EKS Pod Identity. The
minimum data-plane permissions are:

- `secretsmanager:GetSecretValue` on the exact
  `sutra/notifications/<org>/<customer>/*` secret ARN paths that the worker
  serves;
- `ses:SendEmail` for approved sender identities and regions; and
- `kms:Decrypt` only when those Secrets Manager values use a customer-managed
  KMS key.

The database role remains `sutra_app`; migrations execute separately with the
owner role before the worker starts. The runtime container is read-only,
capability-free, non-root, has `no-new-privileges`, and exposes only its health
port.

## Live activation gates

Code readiness does not prove provider delivery. Before marking a destination
live:

1. verify the SES sender identity in the configured region;
2. if the SES account is still in the sandbox, verify every test recipient, or
   request production access;
3. create the Slack Incoming Webhook and Teams Workflow secrets through a
   protected secret-entry path—never chat, source control, browser storage, or
   the Sutra database;
4. attach the narrow task-role permissions above;
5. queue one customer-scoped test per channel and confirm a `delivered` outbox
   result; and
6. revoke or rotate test webhooks after disposable validation.

Slack and Teams endpoint ownership, SES identity verification, SES sandbox
status, workload-role deployment, and actual delivery receipts remain
live-environment requirements.
