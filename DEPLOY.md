# Deploying Sutra on a single EC2 instance

This is the entry point for deploying Sutra to your own Ubuntu EC2 host. The full,
authoritative runbook — every command, the security model, and the account
lifecycle — lives in [`deploy/ec2/README.md`](deploy/ec2/README.md). This page is
the short orientation and checklist.

## What you get

One Ubuntu box running the whole stack with Docker Compose, fronted by Caddy:

- **App** (Next.js on Cloudflare workerd) + **PostgreSQL**, neither exposed to the
  host network — only Caddy is.
- **Caddy** edge: automatic HTTPS via Let's Encrypt, HSTS, and an **automatic
  maintenance page** (HTTP 503) whenever the app is stopped or unhealthy.
- **systemd** unit: starts on boot; `systemctl stop sutra` stops only the app so
  the maintenance page shows.
- Email + password + **mandatory MFA** sign-in, per-tenant isolation, per-account
  lockout, a per-IP login rate limit, and always-`Secure` session cookies.

## Prerequisites (you provide)

| Item | Value |
| --- | --- |
| Instance | Ubuntu 22.04/24.04 LTS, `t3.large` (2 vCPU / 8 GB), 40 GB gp3 |
| Elastic IP | Allocated + associated (stable IP for DNS) |
| DNS | An `A` record for your apex domain (and `www`) → the Elastic IP |
| Security group | Inbound `22/tcp` (your IP only), `80/tcp`, `443/tcp` (world); outbound all |
| Domain + email | A domain you control + an email for Let's Encrypt renewal notices |

Ports 80/443 must be world-reachable so Let's Encrypt can validate the certificate.

## Deploy (one command, idempotent)

```bash
sudo mkdir -p /opt/sutra && sudo chown "$USER":"$USER" /opt/sutra
git clone <your-repo-url> /opt/sutra
cd /opt/sutra
bash deploy/ec2/bootstrap.sh
```

`bootstrap.sh` installs Docker + the compose plugin if missing, generates the
database/job secrets into `.sutra/docker.env` (mode `0600`, never committed),
creates `deploy/ec2/.env.ec2` from the template (prompting for your domain +
ACME email), builds the image, and brings the stack up with `--wait`. It doubles
as the redeploy path (see `deploy/ec2/redeploy.sh`). Secrets are never printed.

## Verify

```bash
CE="docker compose -f deploy/ec2/compose.prod.yaml --env-file deploy/ec2/.env.ec2 --env-file .sutra/docker.env"
$CE ps                      # app + postgres + caddy healthy; migrate exited 0
curl -sI https://<your-domain>/ | head -1   # 200 once DNS + cert are live
```

## First accounts

The platform starts empty. Follow **§11 "Account lifecycle"** in
[`deploy/ec2/README.md`](deploy/ec2/README.md):

1. **Bootstrap the operator** (master admin) — read the one-time token with
   `… exec app node scripts/show-local-bootstrap-token.mjs`, then complete the
   first-time setup at `/login` and enroll MFA.
2. **Create a customer** per client (`/onboard/client`).
3. **Invite each client admin** (`/access`) — send them the one-time
   `/accept-invite?token=…` URL. They set a password + MFA and land in their own
   isolated workspace.

## Notes

- The stack builds and runs entirely from this repository — no external services
  are required to stand it up. The optional AWS notification worker stays off
  until you configure AWS credentials (`deploy/ec2/README.md` §8).
- All test/verification commands: `pnpm install`, `pnpm typecheck`, `pnpm test`.
