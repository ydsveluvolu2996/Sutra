# Enabling real notification delivery (EC2 private beta)

This is the reviewable plan for turning on actual outbound notification
delivery on the live single-node EC2 stack. Nothing in this document is enabled
by merging it. Section 3 lists the repository changes that are already made and
inert; section 4 onward lists what only the owner can do, deliberately, on the
box and in AWS.

Read `docs/security-notification-delivery.md` first: it is the reviewed
provider, secret-document, and network-pinning contract. This document is the
operational enablement layer on top of it.

## 1. What is broken today

Every Sutra notification — FinOps budget/cost alerts
(`db/finops-alert-service.ts:176`), Kubernetes runtime events
(`app/api/v1/kubernetes/runtime-events/route.ts:145`), and manual test sends
(`app/api/v1/notification-destinations/route.ts:210`) — is durably written to
`security_notification_outbox` with `status='pending'`
(`db/security-notification-repository.ts:254`) and then never touched again,
because the only code that claims and delivers a row lives in a separate
container (`services/notification-worker/worker.ts:28` →
`lib/security-notification-delivery.ts`) and that container is not running:
Compose gates it behind the `notifications` profile with an intentionally
unpullable default image (`deploy/ec2/compose.prod.yaml:274-279`), the operator
switch ships `false` (`deploy/ec2/.env.ec2.example`,
`SUTRA_NOTIFICATIONS_ENABLED=false`), and no release workflow has ever built or
published the worker image at all.

The app-side `claim()`/`finish()` methods
(`db/security-notification-repository.ts:297` and `:370`) have no caller
anywhere in the application — they exist only so the worker's repository can
share their types. So a customer today is told nothing, and the outbox is a
growing record of alerts that were computed correctly and never sent.

## 2. Preconditions (each one is a verifiable check)

### 2.1 Database reachability — RESOLVED, already wired

The worker reaches the same Postgres the app writes to. This was the open
question and the answer is yes:

| Check | Evidence |
| --- | --- |
| Same database, same role | `deploy/ec2/compose.prod.yaml:282` gives the worker `DATABASE_URL=postgresql://sutra_app:…@postgres:5432/sutra`, byte-identical to the app's at `:92`. |
| Network path exists | The worker is attached to the internal `data` bridge (`compose.prod.yaml:309`), the same network `postgres` and `app` are on (`:58`, `:169`). `postgres` publishes no host port; the worker does not need one. |
| Schema exists before it starts | `depends_on: migrate: service_completed_successfully` (`compose.prod.yaml:290-291`); `postgres/migrations/0011_notification_destinations_outbox.sql` creates both tables. |
| Role has the required grants | `scripts/postgres-migrate.mjs:127-131` grants `SELECT, INSERT, UPDATE, DELETE` on all public tables to `sutra_app`, which covers the worker's `UPDATE … SET status='processing'` claim. |
| Driver works outside the Worker runtime | `services/notification-worker/postgres-repository.ts:82` uses `db/postgres-d1-adapter.ts` (node-postgres), bundled into the image by `services/notification-worker/Dockerfile`. `meta.changes` maps to `rowCount` (`postgres-d1-adapter.ts:75`), which `finish()` depends on. No TLS is required or attempted on the internal bridge. |

One operational caveat, not a blocker: the adapter opens and closes a fresh
`pg.Client` per statement, and the worker polls every
`SUTRA_NOTIFICATION_POLL_INTERVAL_MS` (default **1000**), doing 2–3 statements
per claim. On a `t3a.large` single node that is needless connection churn — set
`SUTRA_NOTIFICATION_POLL_INTERVAL_MS=5000` when enabling.

### 2.2 A published worker image — BLOCKING, does not exist yet

`deploy/ec2/compose.prod.yaml:279` reads
`${SUTRA_NOTIFICATION_WORKER_IMAGE:-sutra-notification-worker:unavailable}`, and
**nothing produces that image.** `.github/workflows/ec2-private-beta-release.yml`
builds exactly one image, from the root `Dockerfile`, into
`APP_ECR_REPOSITORY: sutra/app` (`:19`, `:158`). The host is forbidden from
building (15 GiB root volume; `up --no-build` in `sutra.service`).

Verifiable check: `aws ecr describe-repositories --repository-names
sutra/notification-worker` currently fails with `RepositoryNotFoundException`.

To match the existing release convention exactly, a worker release must:

- use repository name **`sutra/notification-worker`** (the app repo is
  `sutra/app`; the Kubernetes workflow already parameterises sibling repos as
  `AGENT_ECR_REPOSITORY` / `FALCO_GATEWAY_ECR_REPOSITORY`);
- be created with `imageTagMutability=IMMUTABLE`, `scanOnPush`, AES256/KMS
  encryption, and the same lifecycle policy as
  `deploy/ec2/ecr-lifecycle-policy.json` (keep 3 × `sha-` releases, expire
  `candidate-` after 1 day, untagged after 14) — the app release job asserts all
  of these for `sutra/app` at `.github/workflows/ec2-private-beta-release.yml:109-129`;
- build from `services/notification-worker/Dockerfile` for `linux/amd64` with
  `--provenance=mode=max --sbom=true`;
- push as `candidate-<sha40>-run-<runId>-<attempt>`, Trivy-scan the resolved
  digest at `CRITICAL,HIGH` with `ignore-unfixed`, then promote the *same
  manifest digest* to `sha-<sha40>-run-<runId>-<attempt>` via `ecr put-image`;
- be consumed **by digest only**:
  `<acct>.dkr.ecr.<region>.amazonaws.com/sutra/notification-worker@sha256:<64 hex>`.

Note that the existing SSM release document (`Sutra-DeployImmutableRelease`)
cannot deploy this image: the workflow's `ImageRef` is regex-pinned to
`sutra/app` (`ec2-private-beta-release.yml:274`) and
`deploy/ec2/release-update.sh:36` rejects any other repository. Therefore
`SUTRA_NOTIFICATION_WORKER_IMAGE` is set once by hand in
`deploy/ec2/.env.ec2` on the box. That is durable:
`release-update.sh:317-321` copies `.env.ec2` forward line-by-line and rewrites
only `SUTRA_APP_IMAGE`, so the value and the profile switch survive every
subsequent app release.

### 2.3 Secrets Manager entries — BLOCKING, per destination

Reference format the app stores and both sides enforce
(`lib/notification-destination-boundary.ts:65`):

```
secret://notifications/<orgId>/<customerId>/<channel>/<name>
```

The worker strips `secret://notifications/` and prepends
`SUTRA_NOTIFICATION_SECRET_PREFIX` (default `sutra/notifications/`), so the
Secrets Manager secret **name** must be exactly
(`services/notification-worker/runtime-adapters.ts:169`, `:180`):

```
sutra/notifications/<orgId>/<customerId>/<channel>/<name>
```

`<channel>` is one of `slack`, `microsoft_teams`, `pagerduty`,
`generic_webhook`. Email destinations use **no secret** — recipients, from
address, and SES region are stored in the database.

Exact value shapes (unknown fields, cross-channel documents, binary secrets and
values above 16 KiB are rejected — `runtime-adapters.ts:53-109`):

```json
{ "version": 1, "channel": "slack",
  "webhookUrl": "https://hooks.slack.com/services/…",
  "expectedHostname": "hooks.slack.com" }
```

```json
{ "version": 1, "channel": "microsoft_teams",
  "webhookUrl": "https://<workflow-host>/…",
  "expectedHostname": "<same host as above>",
  "idempotencyHeader": "Idempotency-Key" }
```

```json
{ "version": 1, "channel": "generic_webhook",
  "webhookUrl": "https://<your-host>/…",
  "expectedHostname": "<same host as above>" }
```

```json
{ "version": 1, "channel": "pagerduty", "routingKey": "<20-64 alphanumerics>" }
```

Constraints worth knowing before provisioning: `expectedHostname` must equal
the URL hostname; Slack must be `hooks.slack.com` and must **omit**
`idempotencyHeader`; Teams must be under `logic.azure.com` or
`environment.api.powerplatform.com`; PagerDuty always posts to
`https://events.pagerduty.com/v2/enqueue`, so only the routing key is stored.

Verifiable check, per destination, run as the *operator* (not the instance
role): `aws secretsmanager describe-secret --secret-id
sutra/notifications/<org>/<customer>/<channel>/<name>` returns a secret, and
`get-secret-value | jq -e '.SecretString | fromjson | .version == 1'` succeeds.
Never paste a webhook URL or routing key into a shell history, this repo, a
Compose file, `.env.ec2`, or the Sutra database.

### 2.4 IAM — BLOCKING, three separate gaps in the instance role

`deploy/ec2/cloudformation-single-node.yaml` gives the instance role **no**
Secrets Manager and **no** SES permission today, and scopes ECR pull to
`sutra/app` alone (`:197-199`). The worker takes credentials from IMDS
(`HttpPutResponseHopLimit: 2` already permits bridged containers), so no static
keys are involved — but the role needs three additions, as a reviewed
CloudFormation change:

1. Extend `PullOnlySutraAppRepository` (or add a sibling statement) to
   `arn:aws:ecr:<region>:<acct>:repository/sutra/notification-worker` for
   `ecr:BatchCheckLayerAvailability`, `ecr:BatchGetImage`,
   `ecr:GetDownloadUrlForLayer`. Without this the `pull_policy: always` pull
   fails and the profile simply will not start.
2. `secretsmanager:GetSecretValue` scoped to
   `arn:aws:secretsmanager:<region>:<acct>:secret:sutra/notifications/*` —
   nothing broader. Add `kms:Decrypt` on the exact key ARN **only** if those
   secrets use a customer-managed key.
3. Email only: `ses:SendEmail` (SESv2 `SendEmail` maps to this action) scoped to
   `arn:aws:ses:<region>:<acct>:identity/<verified sender identity>`. Skip
   entirely if no email destination is in scope.

Verifiable check: `aws iam simulate-principal-policy` against the instance role
ARN for each of the three actions returns `allowed`, and returns `implicitDeny`
for a `sutra/notifications/`-adjacent path that should not be readable (for
example `sutra/other/…`).

### 2.5 SES identity state — email destinations only

- The sender identity (`email_from_address` on the destination row) must be
  verified in the destination's `ses_region`, which the worker uses verbatim to
  build `email.<region>.amazonaws.com` (`runtime-adapters.ts:339`). Check:
  `aws sesv2 get-email-identity --email-identity <sender>` shows
  `VerifiedForSendingStatus: true` in that exact region.
- If the account is still in the SES sandbox, **every** recipient must also be
  verified, or production access must be granted. Check:
  `aws sesv2 get-account` → `ProductionAccessEnabled`.
- The region in the destination row must be a region where the identity exists;
  a mismatch produces a permanent failure, not a retry.

## 3. Change set already in this repository (all inert)

These are committed and cannot enable delivery by themselves. Proof of
inertness: `docker compose -f deploy/ec2/compose.prod.yaml --env-file
deploy/ec2/.env.ec2.example config` renders **byte-identical** output before and
after these edits, and `notification-worker` remains absent from
`config --services`.

### 3.1 `deploy/ec2/.env.ec2.example`

The old comment said the single `SUTRA_NOTIFICATIONS_ENABLED=true` flip was
enough and that "bootstrap.sh then adds `--profile notifications`". That is
incomplete in a way that would have wasted an operator's time: bootstrap only
runs on a fresh box, and systemd — which is what actually starts the stack on
reboot — never sees that flag. The comment now enumerates all four independent,
fail-closed preconditions, and two inert keys are added:

```diff
+# SUTRA_NOTIFICATION_WORKER_IMAGE=000000000000.dkr.ecr.ap-south-1.amazonaws.com/sutra/notification-worker@sha256:00…00
 SUTRA_NOTIFICATIONS_ENABLED=false
+COMPOSE_PROFILES=
 AWS_REGION=ap-south-1
 SUTRA_NOTIFICATION_SECRET_PREFIX=sutra/notifications/
+# SUTRA_NOTIFICATION_POLL_INTERVAL_MS=5000
```

`COMPOSE_PROFILES=` (empty) is a no-op — verified: Compose renders the identical
service list with the key absent and with it empty. The worker-image line stays
commented so the unpullable `sutra-notification-worker:unavailable` fallback
keeps the service failing closed.

### 3.2 `deploy/ec2/compose.prod.yaml`

```diff
-      SUTRA_NOTIFICATION_WORKER_CONFIGURED: ${SUTRA_NOTIFICATION_WORKER_CONFIGURED:-false}
+      # The UI must never claim notification delivery is configured while the
+      # worker profile is off, so this is derived from the single operator switch
+      # instead of being independently settable. It only labels readiness; the
+      # app never delivers, whatever this says.
+      SUTRA_NOTIFICATION_WORKER_CONFIGURED: ${SUTRA_NOTIFICATIONS_ENABLED:-false}
```

Inert because `SUTRA_NOTIFICATION_WORKER_CONFIGURED` was never set in
`.env.ec2.example`, so it already resolved to `false`, and
`SUTRA_NOTIFICATIONS_ENABLED` is `false`. Same rendered value; the difference is
that the label can no longer be turned on independently of the worker. Header
and service comments additionally state that pending rows accumulate while the
profile is off. The root `compose.yaml` (local pilot) is untouched.

### 3.3 `deploy/ec2/sutra.service` — comment only, no directive changed

The old comment told a human to "append `--profile notifications` to the
ExecStart/ExecStop compose commands". That instruction is actively harmful:
`deploy/ec2/release-update.sh:364` reinstalls
`/etc/systemd/system/sutra.service` from the release bundle on **every** app
release, so a hand-edited unit is silently reverted and the worker stops coming
back after the next deploy — the worst possible failure mode, because alerts
would go quiet without any error.

The replacement comment documents the durable mechanism instead: set
`SUTRA_NOTIFICATIONS_ENABLED=true` **and** `COMPOSE_PROFILES=notifications` in
`deploy/ec2/.env.ec2`. Compose reads `COMPOSE_PROFILES` out of the `--env-file`
the unit already passes (verified locally: with the key set, `config --services`
includes `notification-worker`; empty, it does not), so systemd starts and
health-waits the worker with **no unit change at all**, and the setting survives
release bundle swaps because `release-update.sh` preserves `.env.ec2` verbatim.
The comment also records that `ExecStop` deliberately stops only `app`, and
gives the `--profile '*'` command to quiesce the worker for a maintenance
window.

### 3.4 `deploy/ec2/validate-ops.sh` — new regression gate

Added an offline check (it runs in the release workflow at
`ec2-private-beta-release.yml:89`) asserting that the committed template ships
`SUTRA_NOTIFICATIONS_ENABLED=false` and `COMPOSE_PROFILES=`, never their enabled
forms, leaves `SUTRA_NOTIFICATION_WORKER_IMAGE` unset, keeps the Compose service
profile-gated with the unpullable fallback image, and that `sutra.service`
contains no `--profile` directive. This makes "delivery turns on only as a
deliberate owner action on the box" a machine-enforced property rather than a
convention. Verified: passes as committed, and fails if either switch is
flipped in the template.

## 4. The `deliveryReadiness` hardcode — keep it static, with one honesty fix

`db/security-notification-repository.ts:120` returns
`deliveryReadiness: "adapter_not_configured"` for every stored destination.
**Recommendation: leave it.** It should not become a runtime probe now, for
three reasons:

1. It is not actually the value the API serves. `GET
   /api/v1/notification-destinations` already overlays a runtime signal
   (`app/api/v1/notification-destinations/route.ts:97-103`), so the repository
   constant is a safe default on a raw row, not a claim shown to a user.
2. The only truthful stronger check available today is "is the worker process
   deployed", which is what the env flag now expresses. A genuine
   per-destination check would have to resolve that destination's Secrets
   Manager document and (for email) the SES identity — a network call, made from
   an authenticated read path, with AWS credentials the app should not need.
   That belongs in the worker, not in a `GET`.
3. `"configured"` must never mean "queued and hoping". Until the worker is
   live, static `adapter_not_configured` is exactly true, and
   `lib/notification-delivery-health.ts:59` correctly reports the whole feature
   as `blocked` because of it.

The one dishonesty that *was* possible is now closed (§3.2): before, an operator
could set `SUTRA_NOTIFICATION_WORKER_CONFIGURED=true` with no worker running and
the UI would say "configured" and health would say "healthy" while nothing
delivered. It is now derived from the same switch that starts the worker.

Residual, and stated plainly in this doc rather than papered over: with the
worker live, `configured` means "a worker is deployed", not "this destination's
secret exists". A destination with a missing secret shows `configured` and then
produces `dead_letter` rows with `DESTINATION_REJECTED`. The honest follow-up,
if the owner wants it later, is for the app to query the worker's
`/readyz` on the shared `data` network and for the worker to expose a
per-destination resolve-only preflight — a separate, approvable change.

## 5. Rollout runbook

Do these in order. Steps 1–4 change nothing that customers can observe.

1. **Build and publish the worker image** (§2.2). Confirm:
   `aws ecr describe-images --repository-name sutra/notification-worker
   --image-ids imageTag=sha-<sha>-run-<id>-<attempt>` returns the expected
   digest.
2. **Apply the IAM change** (§2.4) and verify with
   `simulate-principal-policy`.
3. **Provision secrets** (§2.3) and the SES identity (§2.5) for the *one*
   destination you intend to test with first.
4. **Deal with the backlog before starting the worker** — see §6. This is the
   step most likely to be skipped and most likely to hurt.
5. **Set the switches on the box** (SSM session, no repo change):
   ```
   sudo sed -i 's/^SUTRA_NOTIFICATIONS_ENABLED=false$/SUTRA_NOTIFICATIONS_ENABLED=true/' /opt/sutra/deploy/ec2/.env.ec2
   sudo sed -i 's/^COMPOSE_PROFILES=$/COMPOSE_PROFILES=notifications/' /opt/sutra/deploy/ec2/.env.ec2
   # add the digest line, then:
   sudo grep -E '^(SUTRA_NOTIFICATIONS_ENABLED|COMPOSE_PROFILES|SUTRA_NOTIFICATION_WORKER_IMAGE|SUTRA_NOTIFICATION_POLL_INTERVAL_MS)=' /opt/sutra/deploy/ec2/.env.ec2
   ```
   Then dry-render before starting anything:
   ```
   cd /opt/sutra && sudo docker compose -f deploy/ec2/compose.prod.yaml \
     --env-file deploy/ec2/.env.ec2 --env-file .sutra/docker.env config --services
   ```
   `notification-worker` must now appear. If it does not, `COMPOSE_PROFILES` is
   wrong — stop here.
6. **Start it through systemd**, so you are exercising the real boot path:
   `sudo systemctl restart sutra`, then
   `sudo docker compose … ps notification-worker` must be `healthy`. `/readyz`
   only returns 200 while the poll loop is succeeding, so an unreachable
   database or bad `DATABASE_URL` shows up here, before any provider call.
7. **Watch the logs** — they are structured and contain no secrets:
   `sudo docker compose … logs -f notification-worker`. Expect
   `notification_worker.started`, then `notification_worker.job_finished` with a
   `result` for each non-idle poll. `notification_worker.poll_failed` with a
   climbing `consecutiveFailures` means database or claim trouble.
8. **Send exactly one test notification** without touching a customer
   destination: create a destination scoped to *your own* org/customer with your
   own Slack webhook (or your own verified email), then use the existing
   authenticated test-send path (`POST /api/v1/notification-destinations`, the
   branch at `route.ts:210` that enqueues one job). Watch that single row:
   ```sql
   SELECT id, destination_id, status, attempt_count, last_error_code,
          to_timestamp(created_at/1000), to_timestamp(delivered_at/1000)
     FROM security_notification_outbox
    WHERE org_id = :org AND customer_id = :customer
    ORDER BY created_at DESC LIMIT 5;
   ```
   Expected transition: `pending` → `processing` (briefly, with a
   `lease_token`) → `delivered` with `delivered_at` set. Confirm the message
   actually arrived in Slack/inbox — a `delivered` row means the provider
   returned 2xx, not that a human read it.
9. **Read the same thing through the product**, so the UI is verified too: the
   notification-destinations `GET` returns `worker.configured: true` and
   `health.state` should move off `blocked`.
10. **Revoke the disposable test webhook** and delete the test destination.
11. Only then enable real customer destinations, one channel at a time.

### Failure signatures to expect

| Outbox result | `last_error_code` | Meaning |
| --- | --- | --- |
| `not_configured` | `DELIVERY_ADAPTER_NOT_CONFIGURED` | Destination row is `enabled=0`, or adapters absent. Not a provider failure. |
| `dead_letter` | `DESTINATION_REJECTED` | Secret missing/malformed, scope mismatch, or hostname not permitted. Fix the secret; the row will not retry. |
| `retry_scheduled` | `PROVIDER_THROTTLED` / `PROVIDER_UNAVAILABLE` / `REQUEST_TIMEOUT` / `TRANSPORT_FAILURE` | Transient. Backoff is `2^attempt × 30 s` capped at 1 h, or the provider's `Retry-After`. |
| `dead_letter` | `PROVIDER_REJECTED` (401/403) or attempt ≥ 5 | Credentials wrong, or five attempts exhausted. |

## 6. Blast radius and the backlog flush

**The moment the worker starts, it begins delivering the entire existing
backlog, oldest first.** `claim()`
(`services/notification-worker/postgres-repository.ts:94-98`) selects any row
with `status IN ('pending','retry_scheduled') AND next_attempt_at <= now`,
ordered by `next_attempt_at, created_at`. Every alert Sutra has queued since the
outbox tables were created is eligible immediately. There is no age filter, no
"only deliver rows newer than X", and no rate limit beyond the poll interval —
at the default 1000 ms poll that is roughly one delivery per second,
indefinitely, to whatever real Slack / Teams / PagerDuty / webhook / SES
destinations exist.

Concretely, what starts being sent: FinOps budget-breach and cost-anomaly
alerts (including ones whose condition has long since resolved), Kubernetes
runtime security events, and any old manual test sends — each to whichever
enabled destination row it was enqueued against. PagerDuty is the worst case:
old rows would page a human at 3 a.m. about a cost anomaly from weeks ago.
Slack is the second worst: a wall of stale alerts is exactly the first
impression that teaches a customer to mute the channel.

### Do this before step 6 of the rollout

Measure first (read-only):

```sql
SELECT status, count(*), min(to_timestamp(created_at/1000)) AS oldest,
       max(to_timestamp(created_at/1000)) AS newest
  FROM security_notification_outbox
 GROUP BY status ORDER BY status;

SELECT d.channel, count(*)
  FROM security_notification_outbox o
  JOIN security_notification_destinations d ON d.id = o.destination_id
 WHERE o.status IN ('pending', 'retry_scheduled') AND d.enabled = 1
 GROUP BY d.channel ORDER BY 2 DESC;
```

If that first query returns anything but a handful of rows, retire the backlog
**before** the worker can claim it. The right way is to move stale rows to
`not_configured` — the exact status the worker itself assigns when it cannot
deliver, so the history stays truthful and auditable (nothing is deleted, and
nothing is falsely marked `delivered`), and `claim()` will never select it
because the status is outside its `IN` list:

```sql
-- Take a backup first; this is a data mutation on live customer history.
BEGIN;
UPDATE security_notification_outbox
   SET status = 'not_configured',
       last_error_code = 'DELIVERY_ADAPTER_NOT_CONFIGURED',
       lease_token = NULL, lease_expires_at = NULL,
       updated_at = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
 WHERE status IN ('pending', 'retry_scheduled')
   AND created_at < (extract(epoch FROM clock_timestamp()) * 1000)::bigint
                    - (24 * 60 * 60 * 1000);   -- older than 24 h
-- Inspect the reported row count against the measurement above, then:
COMMIT;
```

Choose the cutoff deliberately: 24 h retires everything historical while
letting genuinely current alerts through. Zero rows older than the cutoff is a
fine outcome — run the measurement anyway, because "the backlog was empty" is
a fact worth having recorded before flipping the switch.

Do **not** mark stale rows `delivered`: that would put a `delivered_at` on
something no customer ever received, and would make the health assessment lie.

Two smaller risks worth naming:

- Even a *clean* start is a behaviour change customers have never seen. Consider
  telling the first affected customers that alerting is going live, and enable
  one channel at a time (§5 step 11).
- `security_notification_outbox` has a unique index on
  `(org_id, customer_id, destination_id, idempotency_key)`, so re-enqueued
  duplicates are already prevented — but Slack Incoming Webhooks and SES
  `SendEmail` have no provider-side idempotency, so a row that times out after
  the provider actually accepted it will be retried and can double-send. That is
  inherent to those providers, not a Sutra defect; it is bounded by the five
  attempt cap.

## 7. Rollback

Rollback is a single switch and it is clean, because the outbox is durable and
the claim is leased rather than destructive.

1. Revert the two lines in `/opt/sutra/deploy/ec2/.env.ec2`
   (`SUTRA_NOTIFICATIONS_ENABLED=false`, `COMPOSE_PROFILES=`).
2. Stop the container, activating all profiles so Compose can see it regardless
   of the switch state (the same technique `release-update.sh:341` uses):
   ```
   cd /opt/sutra && sudo docker compose -f deploy/ec2/compose.prod.yaml \
     --env-file deploy/ec2/.env.ec2 --env-file .sutra/docker.env \
     --profile '*' stop -t 30 notification-worker
   ```
3. `sudo systemctl restart sutra` — with `COMPOSE_PROFILES` empty the worker is
   no longer part of the stack, and the app returns to queue-only behaviour.
   Nothing else in the stack is touched; the site does not go down.

**In-flight rows:** a row the worker had claimed is left `status='processing'`
with a `lease_token` and a `lease_expires_at` roughly 30 s in the future
(`postgres-repository.ts:86-87`). Because it never reaches `delivered`, it is
not lost: the claim query also selects `status='processing' AND lease_expires_at
< now`, so whenever the worker is next enabled that row is re-claimed and
retried. If you do not want that retry on re-enable, sweep those rows with the
same `not_configured` UPDATE as §6 (widen the `WHERE` to include
`status='processing'`). Rows already `delivered` are final. Rows already
`dead_letter` never retry.

Worst case — a stuck worker delivering something you want stopped *right now* —
step 2 alone is sufficient and takes effect in under 30 seconds; the switches can
be reverted afterwards.

## 8. Strictly owner actions (not doable in this repository)

- Create the `sutra/notification-worker` ECR repository, its lifecycle policy,
  and a release workflow (or one-off approved release) that builds, scans,
  promotes, and publishes the worker image by digest.
- Apply the CloudFormation IAM change in §2.4 to the live instance role.
- Create the Secrets Manager documents, and verify the SES identity / request
  production access.
- Set `SUTRA_NOTIFICATIONS_ENABLED`, `COMPOSE_PROFILES`, and
  `SUTRA_NOTIFICATION_WORKER_IMAGE` in `/opt/sutra/deploy/ec2/.env.ec2` on the
  box, and restart the unit.
- Measure and retire the outbox backlog (§6) — the one step no code change can
  make safe on the owner's behalf.
- Decide and communicate to customers when alerting starts arriving.
