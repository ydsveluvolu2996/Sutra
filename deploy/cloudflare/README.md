# Sutra Cloudflare edge fallback

This Worker keeps `www.sutracmdb.com` customer-friendly when the EC2 origin is
stopped, starting, unreachable, or returning a Cloudflare/origin gateway error.
Healthy responses are returned unchanged, including session cookies and API
payloads. The Worker makes exactly one origin request and never retries writes.

The edge fallback is not an application replica. It cannot authenticate users or
serve stale customer data. During an outage it returns:

- a self-contained branded HTML page with HTTP `503` for browser routes;
- an RFC problem JSON document with HTTP `503` for `/api`, `/api/*`,
  `/openapi.json`, and path segments named `webhook`, `webhooks`, or `hooks`;
- a version-controlled `security.txt` document at both
  `/.well-known/security.txt` and `/security.txt`, served directly at the edge
  even when the origin is stopped; Caddy serves the byte-identical
  version-controlled file when a Worker request limit fails open;
- `Retry-After: 60`, strict security headers, and no-store directives;
- a bodyless response for `HEAD` requests.

The canonical `security.txt` URL is
`https://www.sutracmdb.com/.well-known/security.txt`. It is intentionally
cacheable at the edge for one day and identifies the public contact and security
policy pages without publishing a mailbox that may not be monitored.

Origin statuses `502`, `503`, `504`, and `520` through `530` activate the
fallback. Other application responses, including `4xx` and `500`, pass through
unchanged so real application errors remain observable.

## Protected origin and DNS records

The Tunnel is the only network path, but a Tunnel hostname is still publicly
requestable at Cloudflare's edge. Protect `origin.sutracmdb.com` with one Free
plan WAF custom rule that blocks every request except an internal subrequest
from this zone's Worker:

```text
(http.host eq "origin.sutracmdb.com" and cf.worker.upstream_zone ne "sutracmdb.com")
```

Use the `Block` action. `cf.worker.upstream_zone` is Cloudflare-managed request
metadata: it is empty on direct visitor requests and cannot be supplied as a
spoofable browser header. Caddy also strips Access identity headers before
proxying to Sutra, although this design does not require an Access subscription.

Use these DNS records. Replace
`<tunnel-id>` with the tunnel UUID shown by Cloudflare; do not include angle
brackets in the actual record value:

| Type | Name | Target | Proxy | Purpose |
|---|---|---|---|---|
| `CNAME` | `origin` | `<tunnel-id>.cfargotunnel.com` | Proxied | WAF-protected Worker origin through the tunnel |
| `CNAME` | `www` | `<tunnel-id>.cfargotunnel.com` | Proxied | Public hostname intercepted by the Worker route |
| `CNAME` | `@` | `<tunnel-id>.cfargotunnel.com` | Proxied | Apex hostname intercepted by the Worker route |

The Worker fetches `https://origin.sutracmdb.com`, never the public `www`
hostname, which prevents Worker-route recursion. Configure the tunnel public
hostname `origin.sutracmdb.com` to forward to the internal Caddy service over
HTTP, for example `http://caddy:8080` when both run in the same Docker Compose
network. Cloudflare terminates public TLS and carries the request through the
WAF-protected tunnel path, so EC2 does not need an Elastic IP, a publicly trusted
origin certificate, or inbound ports 80 and 443.

Keep every record proxied. Never add a DNS-only record exposing the instance IP.
The EC2 security group should have no public inbound rules; use AWS Systems
Manager as the administration path and permit only the outbound connectivity
needed by the application and `cloudflared`. The tunnel credential belongs in
the EC2 encrypted SSM parameter and never in Git, command output, or application
logs.

## Workers Free-limit fail-open path

Both Worker routes use Cloudflare's `request_limit_fail_open=true` route
setting. This prevents a Workers Free daily-request limit from replacing the
whole site with Error 1027: after the limit is exhausted, Cloudflare bypasses
the Worker and resolves the proxied public DNS record normally.

The more-specific `www.sutracmdb.com/assets/*` route is deliberately assigned
to no script. Static asset requests bypass Workers and do not consume Worker
runtime quota. `configure-routes.mjs` is the dry-run-first, idempotent
controller for all three route invariants; see [routes.md](./routes.md).

The named Tunnel and Caddy must be prepared before that setting is enabled:

```text
normal:    www/apex -> Worker -> origin hostname -> named Tunnel -> Caddy
fail-open: www/apex ----------> named Tunnel -------------------> Caddy
```

`deploy/ec2/cloudflared-config.yml.example` therefore contains three exact
ingress names (`origin`, `www`, and apex) followed by a `404` catch-all. Caddy
accepts only those same names, canonicalizes safe apex requests to `www`, and
returns `421` for unsafe apex methods instead of redirecting/replaying them.
This does not expose EC2: DNS remains proxied, `cloudflared` is outbound-only,
Docker publishes no host port, and the EC2 security group keeps zero inbound
rules. The `origin` WAF rule above remains unchanged and still blocks direct
visitors to the protected Worker-only origin hostname.

Fail-open is degraded service, not a substitute for Worker capacity monitoring.
Worker-only behavior such as the full-EC2-off branded page is unavailable while
Cloudflare bypasses the Worker. The two security.txt paths remain available from
Caddy with the same content and cache/security headers, and an automated
contract prevents the Worker and Caddy copies from drifting. If the app alone is
stopped, Caddy still returns its `503` maintenance response. If the entire
instance or Tunnel is offline, Cloudflare can show a Tunnel/origin error until
Worker capacity returns.

## Deploy the Worker

From this directory:

```bash
cp wrangler.example.toml wrangler.toml
npx wrangler deploy --config wrangler.toml
export CLOUDFLARE_ZONE_ID='<32-character-zone-id>'
read -r -s CLOUDFLARE_API_TOKEN
export CLOUDFLARE_API_TOKEN
node configure-routes.mjs
```

`wrangler.toml` contains no credentials. Wrangler authenticates through the
operator's Cloudflare session or a narrowly scoped deployment token. Never put
that token in this repository. Routes are intentionally absent from the
Wrangler configuration so a script deployment cannot overwrite the no-script
asset exclusion or route-level fail-open settings. After reviewing the dry-run,
follow the explicit apply procedure in [routes.md](./routes.md).

Before deploying the origin, create the exact WAF rule above. Do not replace it
with a browser header allowlist: request headers are client-controlled, while
`cf.worker.upstream_zone` is evaluated by Cloudflare before the origin request.
Also verify both route objects report `request_limit_fail_open=true`; do not
assume a Worker script deployment changes that route-level property.

The two routes serve distinct behavior:

- `www.sutracmdb.com/*` proxies to the origin and provides the fallback;
- `sutracmdb.com/*` redirects only `GET` and `HEAD` to `www` with status `308`.

The Worker deliberately returns `421` for writes sent to the apex. Redirecting
a `POST`, `PATCH`, or other unsafe request could make a client replay the body.
API and webhook senders must use `https://www.sutracmdb.com` directly.

## Validate before changing DNS

Run the deterministic contract suite:

```bash
node --test edge-fallback.test.mjs
```

After deployment, confirm the tunnel connector is healthy and validate the
Worker on a temporary route or with `wrangler dev`. Then verify:

```bash
curl -fsS -D- https://www.sutracmdb.com/login -o /dev/null
curl -fsS -D- https://www.sutracmdb.com/api/healthz -o /dev/null
curl -fsS -I https://sutracmdb.com/docs
curl -sS -o /dev/null -w '%{http_code}\n' https://origin.sutracmdb.com/api/healthz
```

The last command must return `403`, never the Sutra health response. Public
`www` requests must continue through the Worker.

When the committed Tunnel ingress changes, the active EC2 file does not update
implicitly because `.sutra/cloudflared/config.yml` is operator-managed. From an
SSM session, first validate the new release bundle with
`bash deploy/ec2/verify-runtime.sh`, then back up the active config, install the
reviewed template with owner/group `65532:65532` and mode `0400`, and
force-recreate only Caddy and cloudflared:

```bash
cd /opt/sutra
sudo cp -a .sutra/cloudflared/config.yml .sutra/cloudflared/config.yml.pre-fail-open
sudo install -o 65532 -g 65532 -m 0400 \
  deploy/ec2/cloudflared-config.yml.example .sutra/cloudflared/config.yml
CE='sudo docker compose -f deploy/ec2/compose.prod.yaml --env-file deploy/ec2/.env.ec2 --env-file .sutra/docker.env'
$CE run --rm --no-deps cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
$CE run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
$CE up -d --no-deps --force-recreate caddy cloudflared
$CE ps caddy cloudflared
```

Run those lines in an interactive shell exactly as shown; the `CE` variable is a
command prefix, not a persisted secret. If either validation fails, restore the
backup before recreating either service. Finally test `www`, apex, and the
protected `origin` from outside the host, plus both public security.txt paths:

```bash
curl -fsS https://www.sutracmdb.com/.well-known/security.txt
curl -fsS https://www.sutracmdb.com/security.txt
```

Never change the DNS records to DNS-only as a workaround.

For the controlled outage test, stop only the application first and confirm the
HTML and JSON `503` responses. Test a full EC2 stop only after the normal path
has passed. Start EC2 again and confirm healthy origin responses and `Set-Cookie`
headers pass through unchanged.

## Roll back

Delete or disable both Worker routes before deleting the Worker. The exact
public Tunnel/Caddy routes keep a healthy host reachable without the Worker,
but a stopped EC2 instance or disconnected Tunnel shows a Cloudflare
Tunnel/origin error instead of the Worker-maintained branded page.
