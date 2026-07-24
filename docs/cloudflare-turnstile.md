# Cloudflare Turnstile for Sutra public mutations

Sutra uses Cloudflare Turnstile as defense in depth on public,
unauthenticated writes. It does **not** replace the existing per-source and
global rate limits, password lockout, mandatory MFA, invitation-token
validation, honeypot, same-origin enforcement or bounded request bodies.

## Protected actions

| Surface | Fixed Turnstile action | Server route |
| --- | --- | --- |
| Password sign-in (including the MFA follow-up submission) | `sutra_login` | `POST /api/auth/login` |
| Public contact form | `sutra_contact` | `POST /api/contact` |
| Password invitation acceptance | `sutra_accept_invite` | `POST /api/auth/invitations/accept` |

Each server route sends the browser token to Cloudflare Siteverify and accepts
it only when all of these are true:

- `success` is exactly `true`;
- `action` exactly matches the route's fixed action;
- `hostname` exactly matches the hostname in `SUTRA_PUBLIC_ORIGIN`;
- `challenge_ts` is current;
- the response is bounded JSON received before the four-second timeout.

Tokens are never logged or persisted. Siteverify tokens are single-use, so the
widget is reset after every failed submission and before an MFA retry.

## Cloudflare dashboard setup

Create a **Managed** Turnstile widget named `Sutra public forms`.

- Allowed hostname: `www.sutracmdb.com`
- Widget mode: Managed
- Pre-clearance: disabled

Use a separate widget for each future staging/custom-domain environment. Do not
select “Any hostname” for the current deployment.

Put the resulting values only in the ignored EC2 operator file
`deploy/ec2/.env.ec2`:

```dotenv
SUTRA_TURNSTILE_SITE_KEY=<public site key>
SUTRA_TURNSTILE_SECRET_KEY=<secret key>
```

The production Compose contract sets these fixed controls:

```dotenv
SUTRA_TURNSTILE_ENABLED=true
SUTRA_TURNSTILE_DEV_BYPASS=false
```

The container entrypoint copies the four values into its mode-0600 Worker
runtime file. The secret is not exposed by `/api/turnstile/config`, included in
the browser bundle, or committed to Git.

## Safe rollout

1. Create the hostname-restricted widget.
2. Add both keys to the ignored EC2 environment.
3. Validate the rendered Compose configuration locally/on the host.
4. Deploy the application image and runtime variables in the same transaction.
5. Confirm `/api/turnstile/config` returns `enabled: true` and only the site key.
6. Complete one real login, contact submission and disposable invitation
   acceptance.
7. Confirm wrong-host and reused tokens are rejected and the original rate
   limits remain active.

Do not deploy the application without its keys. Missing, malformed or
unreachable Turnstile configuration fails closed with HTTP 503 for the
protected mutation while public read-only pages remain available.

## Local development

`pnpm pilot:setup` materializes:

```dotenv
SUTRA_TURNSTILE_ENABLED=false
SUTRA_TURNSTILE_DEV_BYPASS=true
```

The bypass is accepted only when all three conditions are present: deployment
environment `local`, `SUTRA_LOCAL_MODE=true`, and a loopback request hostname.
It is rejected for preview, staging, production and non-loopback hosts. To test
the real widget locally, explicitly set `SUTRA_TURNSTILE_ENABLED=true`, set the
site/secret keys for a separate development widget, and set the bypass to
`false`.

## Content Security Policy

On the three protected UI routes, the application CSP permits only Cloudflare's
documented Turnstile origin for the widget script, frame and connection:

```text
https://challenges.cloudflare.com
```

The existing nonce policy remains in place for Sutra's inline framework
scripts; `unsafe-inline` is not added to `script-src`. All other routes retain
`frame-src 'none'` and do not allow the Turnstile origin.
