# Sutra — EC2 deployment runbook

This is a **complete, step-by-step runbook for deploying Sutra on a single Ubuntu
EC2 instance**. It is written to be executed top-to-bottom by an operator or an
autonomous coding agent working **on the EC2 host** (over SSH). Every phase ends
with an explicit **success check** — do not proceed to the next phase until the
check passes.

The deep reference for each topic is [`deploy/ec2/README.md`](deploy/ec2/README.md);
this file is the authoritative execution order.

---

## 0. What gets deployed

One Ubuntu box running the whole stack with Docker Compose, fronted by Caddy:

| Service | Role | Host port |
| --- | --- | --- |
| `caddy` | TLS edge (Let's Encrypt), reverse proxy, automatic 503 maintenance page | 80, 443 |
| `app` | Sutra application (Next.js on workerd) | internal only |
| `postgres` | PostgreSQL 18 database | internal only |
| `migrate` | one-shot schema migrator (runs, then exits 0) | — |

Sign-in is email + password + **mandatory MFA**. Tenant isolation, per-account
lockout, a per-IP login rate limit, and always-`Secure` session cookies are all
on by default. `systemctl stop sutra` shows a maintenance page automatically.

### Agent boundaries (must respect)

An automated agent running this runbook **must NOT**:
- Enter or invent any human password, MFA code, or the first-run bootstrap token
  into the application — those are entered by the human operator in the browser
  (the agent prepares the box and reports the token; the human uses it).
- Weaken the deployment (no exposing `app`/`postgres` host ports, no disabling
  MFA, no committing `.env.ec2` or `.sutra/docker.env`).
- Proceed past a failed success check — stop and report instead.

---

## 1. Prerequisites (human provides before the agent starts)

| Item | Value |
| --- | --- |
| Instance | Ubuntu 22.04/24.04 LTS, `t3.large` (2 vCPU / 8 GB), 40 GB gp3 root |
| Elastic IP | Allocated + associated to the instance |
| DNS | `A` record for the apex domain **and** `www` → the Elastic IP |
| Security group | Inbound: `22/tcp` (your IP only), `80/tcp`, `443/tcp` (world). Outbound: all |
| Domain + email | A domain you control + an email address for Let's Encrypt |
| Repo access | The instance can `git clone` this repository |

Ports 80/443 must be world-reachable so Let's Encrypt can issue the certificate.
DNS must already resolve to the Elastic IP before Phase 3 (cert issuance).

---

## 2. Phase 1 — Bootstrap the stack

SSH into the instance, then:

```bash
sudo mkdir -p /opt/sutra && sudo chown "$USER":"$USER" /opt/sutra
git clone <your-repo-url> /opt/sutra
cd /opt/sutra
bash deploy/ec2/bootstrap.sh
```

`bootstrap.sh` is idempotent (it is also the redeploy path). It:
1. Installs Docker Engine + the compose plugin if missing.
2. Generates `.sutra/docker.env` (Postgres owner/app passwords + job-runner
   token, 256-bit each, mode `0600`) **only if absent**.
3. Creates `deploy/ec2/.env.ec2` from the template (prompts for `SUTRA_DOMAIN`
   and `SUTRA_ACME_EMAIL` on a TTY — set them non-interactively by copying
   `deploy/ec2/.env.ec2.example` to `deploy/ec2/.env.ec2` and editing first).
4. Builds the app image and runs `docker compose … up -d --wait`.

Define the compose invocation once (used throughout):

```bash
CE="docker compose -f deploy/ec2/compose.prod.yaml --env-file deploy/ec2/.env.ec2 --env-file .sutra/docker.env"
```

**✅ Success check — all containers up, migrate succeeded, app healthy:**

```bash
$CE ps
docker inspect -f '{{.State.ExitCode}}' sutra-prod-migrate-1   # expect: 0
docker inspect -f '{{.State.Health.Status}}' sutra-prod-app-1  # expect: healthy
docker inspect -f '{{.State.Health.Status}}' sutra-prod-postgres-1 # expect: healthy
```

Expected: `postgres` healthy, `migrate` exited 0, `app` healthy, `caddy` running.

### 2.1 Enable boot-start + the maintenance-page control (systemd)

`bootstrap.sh` does **not** install the systemd unit — do it once so the stack
starts on boot and `systemctl stop sutra` yields the maintenance page:

```bash
sudo cp deploy/ec2/sutra.service /etc/systemd/system/sutra.service
sudo sed -i "s#/opt/sutra#$(pwd)#g" /etc/systemd/system/sutra.service   # only if not /opt/sutra
sudo systemctl daemon-reload
sudo systemctl enable --now sutra
```

**✅ Success check:** `systemctl is-enabled sutra` → `enabled`;
`systemctl is-active sutra` → `active`.

---

## 3. Phase 2 — Verify database + application

```bash
# Database schema was applied (expect a count around 88, never 0):
docker exec sutra-prod-postgres-1 psql -U sutra_owner -d sutra -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"

# Core tables exist:
docker exec sutra-prod-postgres-1 psql -U sutra_owner -d sutra -tAc \
  "SELECT string_agg(table_name, ',') FROM information_schema.tables
   WHERE table_schema='public'
     AND table_name IN ('users','organizations','memberships',
                        'identity_invitations','local_password_credentials');"

# App answers its health endpoint and connects to Postgres (not D1):
docker exec sutra-prod-app-1 node -e \
  "fetch('http://127.0.0.1:3000/api/healthz').then(r=>{console.log('healthz',r.status);process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"
docker exec sutra-prod-app-1 printenv DATABASE_URL | sed -E 's#(://[^:]+:)[^@]+@#\1***@#'
```

**✅ Success check:** table count > 0 and includes the five core tables; `healthz`
prints `200`; `DATABASE_URL` starts with `postgresql://sutra_app:***@postgres`.

---

## 4. Phase 3 — TLS + public reachability

Caddy obtains a Let's Encrypt certificate automatically once DNS resolves to the
box. Give it up to ~60s after first start.

```bash
curl -sI https://<your-domain>/ | head -1        # expect: HTTP/2 200
docker logs sutra-prod-caddy-1 2>&1 | grep -i "certificate obtained" | tail -1
```

**✅ Success check:** `https://<your-domain>/` returns `200` and serves the Sutra
marketing site. If it returns the 503 maintenance page, the `app` container is not
healthy — re-check Phase 2. If the cert fails, confirm DNS resolves to the
Elastic IP and ports 80/443 are open to the world.

---

## 5. Phase 4 — Bootstrap the operator (master admin) — human-driven

The platform starts with **no accounts**. This step is done **by the human
operator in a browser**; the agent only retrieves the one-time token.

```bash
# Agent: print the one-time bootstrap token for the operator to paste.
$CE exec app node scripts/show-local-bootstrap-token.mjs
```

Operator, in a browser:
1. Open `https://<your-domain>/login` → the first-time setup screen appears.
2. Paste the token, set operator **email + password + organization name**. This
   creates the sole `org_owner` (the master admin over every client).
3. **Enroll MFA immediately** (scan the QR, confirm a code) over your trusted
   connection, before the account is used anywhere else. MFA is mandatory — no
   workspace data is reachable until it is enrolled and verified.

**✅ Success check:** the operator can sign in with email + password + a TOTP code
and reach `/dashboard`.

---

## 6. Phase 5 — Onboard the clients

For each client, as the signed-in operator (browser):

1. **Create the client workspace:** *Onboarding → Onboard a client*
   (`/onboard/client`), or *Customers* (`/customers`). Each customer is an
   isolated tenant.
2. **Invite the client's admin:** *Administration → Access & invitations*
   (`/access`) → enter their email, role **`customer_admin`**, scope assigned to
   that customer → **copy the one-time activation URL**
   (`https://<your-domain>/accept-invite?token=…`, shown once) and send it to the
   client over a trusted channel.
3. The client opens the link, sets their own password, enrolls MFA, and lands in
   **only** their own workspace. Client admins can then invite their own users
   (`customer_admin` / `customer_viewer`) into their customer only.

**✅ Success check:** an invited client can accept the link, set a password + MFA,
and sees only their own customer's data (never another client's).

---

## 7. Phase 6 — Operate

```bash
# Maintenance page: stop ONLY the app; Caddy keeps serving the 503 page.
sudo systemctl stop sutra          # maintenance page shows
sudo systemctl start sutra         # back online
sudo systemctl status sutra

# Logs:
$CE logs -f app
$CE logs --since 15m caddy

# Redeploy after pulling new code (idempotent; rebuilds + rolls forward):
git -C /opt/sutra pull --ff-only && bash /opt/sutra/deploy/ec2/redeploy.sh

# Database backup (owner role; run on the box):
docker exec sutra-prod-postgres-1 pg_dump -U sutra_owner -d sutra \
  | gzip > "sutra-backup-$(date +%Y%m%d).sql.gz"

# Unlock a client locked out by failed logins (operator, with a fresh MFA step-up):
curl -sS -X POST https://<your-domain>/api/v1/accounts/unlock \
  -H 'content-type: application/json' \
  -b sutra_session=<operator-session-cookie> \
  --data '{"userId":"user_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}'
```

---

## 8. Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `https://domain` shows the maintenance page | `app` unhealthy | `$CE logs app`; re-check Phase 2; `$CE restart app` |
| Cert never issues | DNS not resolving / 80·443 closed | Confirm `A` record → Elastic IP and the security group |
| `migrate` exit code ≠ 0 | DB not reachable / bad secret | `$CE logs migrate`; ensure `.sutra/docker.env` present and unchanged |
| Login page never loads setup | bootstrap already completed | An operator already exists; sign in instead |
| `healthz` not 200 | app still starting or DB down | Wait for the 30s start period; check `postgres` health |

---

## 9. What NOT to change

- Do not publish `app` or `postgres` host ports — only Caddy is internet-facing.
- Do not commit `deploy/ec2/.env.ec2` or `.sutra/docker.env` (both git-ignored).
- Do not disable MFA or the deployment boundary.
- The optional AWS notification worker stays off until AWS credentials are wired
  (`deploy/ec2/README.md` §8); leaving it off is fine.

## 10. Repo-level checks (optional, on any machine with the repo)

```bash
pnpm install
pnpm typecheck
pnpm test        # full suite
pnpm build       # production build
```
