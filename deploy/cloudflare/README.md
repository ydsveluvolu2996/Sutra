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
- `Retry-After: 60`, strict security headers, and no-store directives;
- a bodyless response for `HEAD` requests.

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

## Deploy the Worker

From this directory:

```bash
cp wrangler.example.toml wrangler.toml
npx wrangler deploy --config wrangler.toml
```

`wrangler.toml` contains no credentials. Wrangler authenticates through the
operator's Cloudflare session or a narrowly scoped deployment token. Never put
that token in this repository.

Before deploying the origin, create the exact WAF rule above. Do not replace it
with a browser header allowlist: request headers are client-controlled, while
`cf.worker.upstream_zone` is evaluated by Cloudflare before the origin request.

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

For the controlled outage test, stop only the application first and confirm the
HTML and JSON `503` responses. Test a full EC2 stop only after the normal path
has passed. Start EC2 again and confirm healthy origin responses and `Set-Cookie`
headers pass through unchanged.

## Roll back

Delete or disable both Worker routes before deleting the Worker. The proxied
`www` record can continue to target the tunnel directly only if an operator
accepts that a stopped EC2 instance or disconnected tunnel will show a
Cloudflare origin error instead of the Sutra maintenance page.
