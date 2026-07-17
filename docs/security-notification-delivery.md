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
secret reference such as `secret://notifications/slack/customer-id` crosses the
job boundary.

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

Payloads are capped at 128 KiB for SES, 48 KiB for Slack, and 64 KiB for Teams.
Provider response bodies and thrown error messages are never returned. Results
contain only the channel, retry classification, status code, sanitized error
code, and a bounded `Retry-After` value.

Slack Incoming Webhooks and SES v2 `SendEmail` do not provide an idempotency
contract. A Teams Workflow can opt into `Idempotency-Key` only when that
workflow is explicitly configured to deduplicate the notification ID. The
queue remains responsible for at-most-once claim semantics.
