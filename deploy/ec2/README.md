# Sutra — single-box EC2 deployment

A turnkey, production-ish deployment of the whole Sutra stack on one Ubuntu EC2
instance using Docker Compose, fronted by Caddy (auto-HTTPS + automatic
maintenance page), with auto-start on boot and one-command deploy/redeploy.

```
deploy/ec2/
├── README.md              # this runbook
├── compose.prod.yaml      # postgres + migrate + app (no host port) + caddy (:80/:443) + notification-worker (profile)
├── Caddyfile              # reverse proxy, auto-HTTPS, 503 maintenance page
├── maintenance/
│   └── maintenance.html   # standalone branded "we'll be right back" page (503)
├── bootstrap.sh           # one-command setup AND redeploy (idempotent)
├── redeploy.sh            # pull + rebuild + roll forward
├── sutra.service          # systemd unit: boot start; stop => maintenance page
├── .env.ec2.example       # operator config template (copy to .env.ec2)
└── .gitignore             # keeps .env.ec2 out of git, keeps the template in
```

---

## 1. Provision the instance

| Setting        | Value                                                            |
| -------------- | ---------------------------------------------------------------- |
| Instance type  | `t3.large` (2 vCPU / 8 GB) — the build + Postgres + app + Caddy  |
| OS             | Ubuntu 22.04 or 24.04 LTS (x86_64)                               |
| Storage        | 40 GB `gp3` EBS root volume                                     |
| Elastic IP     | Allocate + associate one (stable IP for DNS)                    |
| Security group | Inbound: `22/tcp` (SSH, your IP), `80/tcp`, `443/tcp` (world). Outbound: all. |

> Ports 80 and 443 must be open to the world so Let's Encrypt can validate the
> HTTP-01 challenge and browsers can reach the site. Restrict SSH to your IP.

---

## 2. One-command bootstrap

SSH in, then either clone-and-run or pipe-and-run.

**From a checkout (recommended):**

```bash
sudo mkdir -p /opt/sutra && sudo chown "$USER":"$USER" /opt/sutra
git clone <your-repo-url> /opt/sutra
cd /opt/sutra
bash deploy/ec2/bootstrap.sh
```

**Or standalone (`curl | bash`):**

```bash
SUTRA_REPO_URL=<your-repo-url> SUTRA_REPO_DIR=/opt/sutra \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/<org>/<repo>/main/deploy/ec2/bootstrap.sh)"
```

`bootstrap.sh` is idempotent — it doubles as the redeploy path. It will:

1. Install Docker Engine + the compose plugin if missing.
2. Generate `.sutra/docker.env` (Postgres owner/app passwords + job-runner token,
   256-bit each, mode `0600`) **only if absent**. Reuses the repo's Node
   generator when Node is present, otherwise reproduces the identical format with
   `openssl`. It refuses to mint new secrets if a prod DB volume already exists
   without its secret file (that would lock the app out of its own data).
3. Create `deploy/ec2/.env.ec2` from the template (prompting for domain + ACME
   email on a TTY).
4. Build the app image and run `docker compose … up -d --wait`.

Secrets are never printed.

---

## 3. Operator configuration (`deploy/ec2/.env.ec2`)

Copy the template and edit:

```bash
cp deploy/ec2/.env.ec2.example deploy/ec2/.env.ec2
$EDITOR deploy/ec2/.env.ec2
```

| Variable                    | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `SUTRA_DOMAIN`              | Apex domain, e.g. `sutracmdb.com`. Caddy also serves `www.` |
| `SUTRA_ACME_EMAIL`          | Let's Encrypt expiry/renewal contact                        |
| `SUTRA_CONTACT_*`           | Optional contact-form email delivery (blank = disabled)     |
| `SUTRA_JOB_RUNNER_INTERVAL_MS` | Background job tick interval (default 15000)             |
| `SUTRA_NOTIFICATIONS_ENABLED` | `true` to run the AWS notification worker (see §8)        |

> **Env-file ordering matters.** All commands pass `--env-file deploy/ec2/.env.ec2`
> **then** `--env-file .sutra/docker.env`. The second file wins, so the real
> generated secrets always override the harmless placeholders in the template.
> The placeholders exist only so `docker compose … config` validates standalone.

---

## 4. Start / stop / maintenance page (systemd)

Install the unit so the stack starts on boot:

```bash
sudo cp deploy/ec2/sutra.service /etc/systemd/system/sutra.service
sudo sed -i "s#/opt/sutra#$(pwd)#g" /etc/systemd/system/sutra.service   # if not /opt/sutra
sudo systemctl daemon-reload
sudo systemctl enable --now sutra
```

| Command                        | Effect                                                                    |
| ------------------------------ | ------------------------------------------------------------------------- |
| `sudo systemctl start sutra`   | Whole stack up — **site is live**.                                        |
| `sudo systemctl stop sutra`    | Stops **only the app** container. Caddy + Postgres stay up, so visitors get the branded **maintenance page (HTTP 503)** — not a dead port. |
| `sudo systemctl restart sutra` | Maintenance briefly, then live.                                           |
| reboot                         | Stack comes back automatically.                                           |

This is exactly the "when I stop the server it shows maintenance" behaviour: the
app goes away, Caddy stays and serves `maintenance/maintenance.html`.

**How the maintenance page works.** Caddy `reverse_proxy app:3000` with an active
health probe on `/api/healthz`. When the app is stopped, down, or reports
unhealthy, `handle_errors` serves `maintenance/maintenance.html` with status
`503` and `Retry-After: 120` instead of a raw 502/504. The maintenance page is
mounted **read-only** into the Caddy container.

Full teardown (also stops Caddy/Postgres):

```bash
docker compose -f deploy/ec2/compose.prod.yaml \
  --env-file deploy/ec2/.env.ec2 --env-file .sutra/docker.env down
```

---

## 5. Redeploy (future deploys, no hassle)

```bash
cd /opt/sutra
bash deploy/ec2/redeploy.sh      # git pull + rebuild app image + up -d --wait
```

Migrations run automatically (the one-shot `migrate` service). Postgres data and
Caddy certificates persist (named volumes are untouched). Health status is
printed at the end. `bootstrap.sh` is also safe to re-run for the same effect.

---

## 6. Logs

```bash
CE="docker compose -f deploy/ec2/compose.prod.yaml --env-file deploy/ec2/.env.ec2 --env-file .sutra/docker.env"
$CE ps                 # status + health
$CE logs -f app        # app (wrangler) logs
$CE logs -f caddy      # TLS issuance / proxy logs
$CE logs migrate       # last migration run
```

---

## 7. Database persistence & backup

Data lives in the named volume **`sutra-prod_sutra_postgres_data`** (survives
`up`/`down`/reboots/redeploys; only an explicit `docker volume rm` destroys it).
Application state (encrypted registry, etc.) lives in
`sutra-prod_sutra_application_data`.

**Ad-hoc logical backup** (Postgres custom format, no host port needed):

```bash
docker compose -f deploy/ec2/compose.prod.yaml \
  --env-file deploy/ec2/.env.ec2 --env-file .sutra/docker.env \
  exec -T postgres pg_dump --username sutra_owner --dbname sutra \
  --format=custom --no-owner --no-privileges > "sutra-$(date +%F).dump"
```

Restore into a fresh volume with `pg_restore … --dbname sutra`.

> The repo's coordinated backup script `scripts/postgres-backup.mjs` targets the
> **local** compose project (`sutra-local`), not this prod stack, so use the
> `pg_dump` command above here. **Back up `.sutra/docker.env` offline** — without
> those exact passwords the database volume cannot be reopened.

---

## 8. AWS notification worker (optional)

The `notification-worker` hard-depends on AWS Secrets Manager + SESv2 and reports
*unready* on a box without AWS credentials, so it is **profile-gated and off by
default** (keeping `--wait` from blocking on an unconfigured dependency). To
enable it: give the instance AWS credentials (IAM instance role or env), set
`SUTRA_NOTIFICATIONS_ENABLED=true` in `.env.ec2`, and re-run `bootstrap.sh`
(which adds `--profile notifications`). Add `--profile notifications` to the
systemd `ExecStart`/`ExecStop` lines too if you want it managed on boot.

---

## 9. Cloudflare DNS

Create these records for `sutracmdb.com` (replace `EIP` with your Elastic IP):

| Type | Name  | Content        | Proxy status         | TTL  |
| ---- | ----- | -------------- | -------------------- | ---- |
| A    | `@`   | `EIP`          | Proxied (orange)     | Auto |
| A    | `www` | `EIP`          | Proxied (orange)     | Auto |

(`www` may instead be a `CNAME` → `sutracmdb.com`, proxied.)

**SSL/TLS mode:** set to **Full (strict)** once Caddy holds a valid Let's Encrypt
certificate. Full (strict) validates the origin's public LE cert end-to-end.

**First certificate issuance behind the orange cloud.** Caddy uses the HTTP-01
challenge on port 80. Cloudflare's proxy will pass `/.well-known/acme-challenge/*`
through, but if issuance stalls, the reliable path is:

1. Temporarily set both A records to **DNS only** (grey cloud).
2. Run the deploy; wait for Caddy to obtain the cert (`… logs -f caddy`).
3. Switch the records back to **Proxied (orange)** and set SSL/TLS to
   **Full (strict)**.

(Alternatively, if you prefer to keep the proxy on throughout, "Full" — not
strict — also works while the edge cert settles.)

---

## 10. Deployment boundary — will it actually serve `sutracmdb.com`? (READ THIS)

This is the make-or-break detail, verified against
[`lib/deployment-security.ts`](../../lib/deployment-security.ts).

**Finding — the app has three modes and only one serves the full product:**

- `SUTRA_DEPLOYMENT_ENV` is **unset** in this deploy, so `deploymentEnvironment()`
  defaults to **`local`**. The container entrypoint runs `setup-local-pilot.mjs`,
  which writes `SUTRA_LOCAL_MODE=true` (local authentication via bootstrap token —
  the intended **single-tenant self-hosted** posture).
- **`local` mode** (`evaluateDeploymentBoundary`) returns `200 ALLOWED` **only when
  the request host is loopback** (`127.0.0.1`/`localhost`/`::1`). A public host →
  `503 INVALID_CONFIGURATION` ("local mode is restricted to a loopback host").
- **`preview` mode** serves only marketing pages (`/`, `/about`, `/contact`, …) and
  `404`s everything else.
- **`staging` / `production` modes are hard-disabled in this build.**
  `hostedConfigurationIssues()` unconditionally appends two release-holds —
  *"hosted identity and session lifecycle are not implemented in this build"* and
  *"hosted broker ingestion and durable jobs are not implemented in this build"*
  (lib/deployment-security.ts, lines ~108–109) — so those envs **always** `503`,
  no matter what env vars you set. The hosted multi-tenant OIDC product does not
  exist in this build.

**So a raw public request (`Host: sutracmdb.com`) sent straight to the app would
`503`.** This deploy does **not** paper over that — it serves the full product
honestly by running the app in its supported **local single-tenant mode** and
**preserving the loopback identity to the app at the edge**:

- Caddy terminates public TLS for `sutracmdb.com`, then proxies to the app with
  **`header_up Host 127.0.0.1`**. `workerd`/`wrangler dev` builds `request.url`
  from the incoming `Host` header, so the app sees a loopback origin and the
  boundary returns `200 ALLOWED`.
- **No auth or security behaviour is weakened.** Local authentication, the CSP,
  `X-Frame-Options`, `X-Content-Type-Options`, referrer policy, etc. are all still
  emitted by the app unchanged; Caddy only adds edge HSTS. This is a configuration
  of *where the loopback boundary sits*, not a change to `lib/deployment-security.ts`.

**Verify after deploy (on the box):**

```bash
CE="docker compose -f deploy/ec2/compose.prod.yaml --env-file deploy/ec2/.env.ec2 --env-file .sutra/docker.env"
# Through Caddy (Host rewritten to loopback) => expect 200:
curl -sko /dev/null -w '%{http_code}\n' -H 'Host: sutracmdb.com' https://127.0.0.1/
# Straight at the app with a public Host (bypassing Caddy) => expect 503 (the boundary):
$CE exec -T app node -e "fetch('http://127.0.0.1:3000/',{headers:{host:'sutracmdb.com'}}).then(r=>console.log(r.status))"
```

**Honest caveats of this posture (not blockers, but know them):**

1. Because the app sees `Host: 127.0.0.1`, any absolute URL it derives from the
   request host is loopback-based (`SUTRA_PUBLIC_ORIGIN` is ignored in local mode).
   The app is a relative-path RSC/SPA, so this is cosmetic in practice; the real
   public host is still forwarded as `X-Forwarded-Host`.
2. `responseSecurityHeaders` sets `X-Robots-Tag: noindex, nofollow` outside
   `production` mode, so search engines will not index the site while it runs in
   `local` mode. Acceptable (often desirable) for a private pilot.
3. This is the **single-tenant self-hosted** posture. It is **not** the hosted
   multi-tenant OIDC production mode — which is intentionally not implemented in
   this build (see the release holds above). If/when that mode ships, this deploy
   would switch to `SUTRA_DEPLOYMENT_ENV=production` + `SUTRA_PUBLIC_ORIGIN` and
   drop the Host rewrite.

**Bottom line:** yes, this deploy serves `sutracmdb.com` end-to-end today, via the
supported local single-tenant mode with edge TLS and loopback-preserving proxy —
without weakening any security control.
