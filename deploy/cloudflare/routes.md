# Cloudflare Worker route control

`configure-routes.mjs` is the authoritative, idempotent controller for Sutra's
zone Worker routes. Wrangler deploys the `sutra-edge-fallback` script but does
not own route state. This separation prevents a routine script release from
removing the static-asset exclusion or reverting the route-level fail-open
setting.

## Required state

| Route pattern | Script | Request-limit behavior |
|---|---|---|
| `www.sutracmdb.com/assets/*` | none | Requests bypass Workers and go directly through the proxied Tunnel/Caddy path |
| `www.sutracmdb.com/*` | `sutra-edge-fallback` | `request_limit_fail_open=true` |
| `sutracmdb.com/*` | `sutra-edge-fallback` | `request_limit_fail_open=true` |

Cloudflare evaluates the more-specific `/assets/*` exclusion before the broad
`www` route. Static assets therefore do not consume Worker invocations. Dynamic
browser, API, and apex requests retain the maintenance fallback while Worker
capacity is available. When a Worker request limit is reached, the two broad
routes fail open to the same protected Tunnel and exact-host Caddy
configuration.

The utility never creates, changes, or deletes an unrelated route. It also has
no delete operation for a Sutra route. Duplicate managed patterns fail closed
for manual review.

## Credentials

Create a narrowly scoped Cloudflare API token limited to the
`sutracmdb.com` zone with `Zone / Workers Routes / Edit`. Do not use the Global
API Key. Supply credentials only through the process environment:

```bash
export CLOUDFLARE_ZONE_ID='<32-character-zone-id>'
read -r -s CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
```

The token is sent only in the HTTPS `Authorization` header. It is never placed
in a URL, command argument, plan, success message, or API error message. Clear
it from the shell after use:

```bash
unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ROUTE_APPLY_CONFIRM
```

## Script release and route reconciliation

Copy the route-free example before deploying the Worker script:

```bash
cd deploy/cloudflare
cp wrangler.example.toml wrangler.toml
npx wrangler deploy --config wrangler.toml
```

Run the controller without arguments first. This makes one read-only route-list
request and prints the required changes:

```bash
node configure-routes.mjs
```

Applying requires both `--apply` and a separate exact confirmation value:

```bash
export CLOUDFLARE_ROUTE_APPLY_CONFIRM='APPLY_SUTRA_EDGE_ROUTES'
node configure-routes.mjs --apply
```

The apply sequence is:

1. read the complete zone route set;
2. reject duplicate managed patterns;
3. create or update only an inexact Sutra pattern;
4. validate every mutation response against its exact invariant;
5. read the complete route set again;
6. validate all three Sutra routes and prove unrelated routes are unchanged.

Run a second dry run after apply. It must report zero changes and confirm that
the exact invariants are satisfied:

```bash
node configure-routes.mjs
```

If an API request fails partway through, Cloudflare has no multi-route
transaction. Do not guess what succeeded: rerun the dry run, review the
remaining plan, and then apply again. The controller is idempotent.

## Validation

Run the repository contract tests:

```bash
node --test configure-routes.test.mjs edge-fallback.test.mjs
```

Then confirm the normal and fail-open application paths described in
`README.md`. The route controller does not change DNS, WAF, Tunnel ingress,
Caddy, Worker source, or account billing settings.

