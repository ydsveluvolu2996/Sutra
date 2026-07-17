# Sutra hosted production foundation

Status: implementation in progress. The repository now fails closed when a local
runtime is placed on a public host and when staging/production is selected before
the hosted identity and broker adapters are complete.

## Selected target

- Cloudflare control plane for the UI, tenant-authorized API and hot D1 state.
- Amazon Cognito in the Sutra management AWS account for managed OIDC login.
- Required authenticator-app TOTP MFA, administrator-created users and short tokens.
- An AWS-hosted broker/worker with workload IAM, asymmetric request authentication,
  durable jobs and no long-lived AWS access keys.
- Customer-owned read-only trust roles with one ExternalId per connection.
- Separate staging and production environments, identities, keys and data.

This split preserves the existing Worker/D1 application and keeps AWS credentials
out of the browser and control plane. It also supports future customer SAML/OIDC
federation through Cognito without changing Sutra's authorization model.

## Implemented release controls

1. `local` is restricted to `localhost`, `127.0.0.1` and `::1`.
2. `preview` exposes only the public product page and static assets.
3. Requests to a hosted environment must exactly match `SUTRA_PUBLIC_ORIGIN`.
4. Staging and production reject local authentication, loopback broker URLs,
   shared-secret broker mode, unmanaged secrets and shared environment keys.
5. Staging and production remain hard-blocked in source until both the hosted
   identity/session adapter and hosted broker/durable-job adapter pass their
   adversarial acceptance suites.
6. Every response receives framing, MIME-sniffing, referrer, browser-capability,
   cross-origin and CSP headers. Public HTTPS receives HSTS. Protected and
   non-production surfaces are excluded from search indexing.

## Identity infrastructure

`infrastructure/hosted-identity.yaml` creates a retained, deletion-protected
Cognito user pool and an authorization-code client suitable for PKCE. It does not
create users or deploy itself. The template deliberately has no client secret in
source or CloudFormation outputs.

Before deployment, choose:

- a staging hostname and a production hostname;
- a Cognito domain prefix for each environment;
- the AWS Region and management-account budget;
- the initial administrator identities;
- the support and recovery ownership model.

The hosted identity release is delivered in security-reviewed slices. The
application-side protocol boundary is present; the remaining lifecycle and
isolation work is listed below. Only after that evidence exists can the identity
release hold be removed.

## Application-side identity progress

The application-side Cognito boundary now implements:

- authorization-code login with S256 PKCE, encrypted five-minute transaction
  cookies, state and nonce binding, and same-origin return paths;
- bounded, redirect-disabled token exchange that never persists access or refresh
  tokens;
- exact issuer JWKS endpoint pinning, bounded key sets, RS256 signature and
  issuer/audience/nonce/token-use/lifetime/email verification;
- a rotating opaque server session stored only as an irreversible digest;
- exact `(issuer, subject, email)` matching to one active, pre-provisioned
  organization membership, without email-only account linking;
- MFA-protected organization invitations with one-time token disclosure,
  digest-only persistence, one active invitation per email, one-hour to
  seven-day expiry, revocation, exact verified-email acceptance and atomic
  identity/membership activation;
- immutable hash-linked invitation create, accept and revoke activity in both
  D1 and PostgreSQL;
- hosted session lookup through the existing centralized authorization policy,
  plus local-auth compatibility for the laptop demo.

The identity release hold remains in place. Recovery administration, membership
switching, session/device administration, hosted step-up authentication,
distributed rate limiting, customer-assignment administration and the complete
two-organization route/job/export isolation suite are not yet implemented.
