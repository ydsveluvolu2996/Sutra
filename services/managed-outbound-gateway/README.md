# Sutra managed outbound gateway

This Worker is the destination-aware egress boundary for public SaaS and
vulnerability-feed dependencies whose addresses cannot be represented safely
by long-lived security-group CIDRs. Application tasks connect only to the
gateway hostname. The signed v2 envelope includes the normalized target origin,
but the gateway accepts it only when the registered target policy validates the
exact provider suffix, path, query, method, headers, and body. There is no
arbitrary-host target.

## Fixed destination contract

| Target ID | Method and exact upstream scope |
|---|---|
| `zoho-in-oauth` | `POST https://accounts.zoho.in/oauth/v2/token` for the exact refresh-token or OIDC authorization-code forms |
| `zoho-in-jwks` | `GET https://accounts.zoho.in/oauth/v2/keys` |
| `zoho-in-mail` | `POST https://mail.zoho.in/api/accounts/<4-32 digits>/messages` |
| `turnstile-siteverify` | `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` |
| `cisa-kev` | `GET https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json` |
| `first-epss` | `GET https://epss.cyentia.com/epss_scores-current.csv.gz` |
| `nvd-cves` | `GET https://services.nvd.nist.gov/rest/json/cves/2.0` with the bounded `cveId`, last-modified window, page-size, and start-index query keys |
| `slack-webhook` | `POST https://hooks.slack.com/services/<team>/<channel>/<token>` |
| `teams-logic-workflow` | `POST` to a `prod[-N].<region>.logic.azure.com` manual workflow trigger with the exact workflow path and bounded `api-version`/`sig` query |
| `teams-powerplatform-workflow` | `POST` to a tenant `.environment.api.powerplatform.com` direct Power Automate manual workflow trigger |
| `pagerduty-events` | `POST https://events.pagerduty.com/v2/enqueue` |
| `jira-cloud-webhook` | `POST https://automation.atlassian.com/pro/hooks/<token>` |
| `servicenow-webhook` | `POST https://<instance>.service-now.com/api/<scope>/<api>[/resource...]` without query parameters |

Methods, paths, query keys, request headers, request sizes, response sizes,
redirect behavior, and a 30-second upstream deadline are enforced per target.
Requests are buffered only within those caps. Redirects are returned to the
caller and are never followed by the gateway. Target parsing rejects alternate
schemes, credentials, ports, authority-relative paths, backslashes, fragments,
control characters, duplicate query keys, and any path outside the table.

There is intentionally no customer-controlled or generic webhook target.
Supporting a new SaaS requires a reviewed target registration with a bounded
provider authority/path/method/header/body policy and its own abuse analysis.
Unknown destinations fail closed with `TARGET_DENIED`.

## Authentication and replay behavior

Every gateway call is an Ed25519-signed envelope. The Worker stores only public
keys. Each public key record also carries its exact allowed-target set; target
authorization is enforced after signature verification. App, notification
worker, and vulnerability-feed callers use separate key pairs, so compromise of
one workload does not authorize another workload's providers. The private
PKCS#8 keys remain in the application runtime secret.
Signatures cover the target, method, path/query, selected headers, body digest,
timestamp, nonce, and idempotency key.

The `OUTBOUND_REQUEST_STATE` Durable Object serializes decisions per client key:

- every nonce is single-use for ten minutes, including GET requests;
- mail, webhook, and provider-event writes require a stable 16-128 character
  `Idempotency-Key`;
- the first write is durably marked pending before any upstream fetch;
- a completed response is stored for 24 hours and returned on an identical
  retry without contacting the provider;
- a changed request using the same key is rejected as a conflict;
- a transport-unknown write is held as uncertain and is never retried
  automatically.

These semantics prevent the gateway from duplicating mail or another write
after a timeout. They do not make a caller-generated random key safe across
process retries: the business operation must allocate and persist its key.

OAuth token requests are deliberately nonce-only and never enter idempotency
response storage. This prevents access, refresh, or ID token response bodies
from being persisted or replayed. A refresh-token exchange may be retried as a
fresh signed call. An authorization-code exchange with an unknown result must
restart the authentication transaction rather than replay the code.

Denials return stable codes and an opaque request ID. Denial audit records
contain the code, status, authenticated key ID, registered target ID, and
request ID only. Completed-call audit records contain the status and the same
identifiers plus a boolean idempotent-replay flag. They never contain a URL
query, request body, response body, provider credential, mail recipient, or
header value.

## Deploy and configure

1. Copy `wrangler.example.toml` to an ignored `wrangler.toml`.
2. Generate a distinct Ed25519 key pair for each production caller. Export the
   public key as 32 raw bytes and the private key as PKCS#8 DER; encode both as
   unpadded base64url.
3. Put the JSON authorization map into the Worker secret. Key IDs and public
   key material must be unique. Use these exact least-privilege target sets:

   - app: Zoho OAuth/JWKS/mail, Turnstile, Jira Cloud, and ServiceNow;
   - notification worker: Slack, Teams Logic/Power Platform, PagerDuty, Jira
     Cloud, and ServiceNow;
   - vulnerability feed: CISA KEV, FIRST EPSS, and NVD.

   Each entry has the shape
   `{"publicKey":"<32-byte-raw-base64url>","allowedTargets":["..."]}`.

   ```bash
   npx wrangler secret put SUTRA_OUTBOUND_CLIENT_KEYS
   ```

4. Deploy with a narrowly scoped Cloudflare token and confirm
   `GET https://outbound.sutracmdb.com/healthz` returns `200`.
5. Store these application values only in the managed runtime secret:

   ```text
   SUTRA_MANAGED_OUTBOUND_URL=https://outbound.sutracmdb.com
   SUTRA_MANAGED_OUTBOUND_APP_KEY_ID=production-app
   SUTRA_MANAGED_OUTBOUND_APP_PRIVATE_KEY=<base64url PKCS#8 private key>
   SUTRA_MANAGED_OUTBOUND_WORKER_KEY_ID=production-notification-worker
   SUTRA_MANAGED_OUTBOUND_WORKER_PRIVATE_KEY=<distinct base64url PKCS#8 private key>
   SUTRA_MANAGED_OUTBOUND_FEED_KEY_ID=production-vulnerability-feed
   SUTRA_MANAGED_OUTBOUND_FEED_PRIVATE_KEY=<distinct base64url PKCS#8 private key>
   ```

6. Permit task security-group egress to a controlled network path which can
   reach only the gateway hostname. DNS resolution must use the VPC resolver.
   Do not add the providers' transient A/AAAA records to an AWS prefix list and
   do not restore `0.0.0.0/0` task egress.

Cloudflare account Access policies are optional defense in depth, not the
caller-authentication mechanism. The signed protocol and Durable Object remain
required.

## Application/feed adapter

`client.ts` exports `createManagedOutboundFetch`. It is fetch-compatible for
the exact URLs in the table and throws before network I/O for every other URL.
`lib/managed-outbound-fetch.ts` selects it when the complete three-value
managed configuration is present, rejects a partial configuration, and
preserves explicit test injection and an unconfigured local runtime.

The app call sites now select that adapter for Zoho refresh-token mail,
Zoho OIDC authorization-code exchange and JWKS, and Turnstile verification.
Zoho mail derives a stable, non-secret transport idempotency key;
Turnstile promotes its existing provider idempotency value into a separate
stable HTTP `Idempotency-Key`. Notification-worker Slack, Teams, PagerDuty,
Jira Cloud, and ServiceNow delivery, plus app-side ITSM and provider-bounded
FinOps report delivery, use the same signed boundary. Both bounded runtime KEV/NVD refresh and the
standalone CISA/EPSS/NVD bulk runner select the same adapter. Production task
definitions and the entrypoint require and propagate the complete managed
outbound secret tuple, while unit tests can continue to inject a local fetch
without making a gateway call.

## Release checks

Run:

```bash
node --test services/managed-outbound-gateway/gateway.test.ts
pnpm typecheck
pnpm eslint services/managed-outbound-gateway
```

Deploy the Worker and verify its health, denial audit stream, replay behavior,
and each provider in a non-customer acceptance environment before changing the
application task egress policy.
