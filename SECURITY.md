# Security policy

Palisade Cloud handles security-sensitive AWS metadata and cross-account trust
configuration. The repository is currently a pre-production foundation using demo
data; no released version is approved for production customer accounts or data.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, exposed credential,
customer data, exploitable trust policy, or tenant-isolation weakness.

Use the repository's **Security** tab and choose **Report a vulnerability** to open a
private GitHub Security Advisory. Include only the minimum evidence needed to
reproduce the problem:

- affected commit or version and component;
- impact and the tenant/AWS boundary involved;
- safe reproduction steps using synthetic data or a disposable sandbox;
- relevant logs with credentials, ExternalIds, account IDs, role ARNs, customer
  identifiers, and inventory values redacted; and
- suggested mitigation, if known.

If private vulnerability reporting is not enabled, open a public issue containing
only a request for a private security contact. Do not include vulnerability details.
Maintainers should enable private vulnerability reporting before publishing or
accepting external production use.

There is no guaranteed response SLA while the project is pre-release. A production
launch must publish staffed acknowledgement, triage, remediation, and disclosure
targets together with an incident escalation path.

## Credential and customer-data policy

Never commit, upload, paste, or attach any of the following to source, issues, pull
requests, CI logs, tests, screenshots, chat, or support artifacts:

- AWS access key IDs, secret access keys, session tokens, console federation URLs,
  credentials files, or signed AWS requests;
- live ExternalIds, broker request signatures, encryption/signing keys, invitation
  or download tokens, cookies, authorization headers, or private keys;
- production role ARNs/account IDs when they identify a customer, raw inventory,
  tags, topology, findings, evidence, exports, or provider error payloads; or
- real customer names, user identities, email addresses, or other personal data.

Use obviously synthetic identifiers and disposable sandbox accounts in tests and
documentation. Local `.env` files are ignored and are not an approved production
secret store. The browser and Cloudflare control plane must never receive or store
temporary STS credentials. Production secrets belong in environment-specific
managed secret stores/KMS, with access logging, rotation, and tested revocation.

If a real credential or sensitive binding is exposed:

1. Revoke or rotate it immediately; do not wait for a code or history cleanup.
2. Disable affected connections or broker paths and preserve sanitized audit
   evidence.
3. Use the private reporting path above and identify where the value may have been
   copied (history, forks, actions artifacts, logs, caches, packages, or images).
4. Remove the material from current content and history as appropriate, then scan
   all affected stores. Rewriting Git history alone does not revoke a credential.
5. Document root cause, customer/tenant impact, recovery, and preventive tests before
   restoring access.

The ExternalId is not an AWS password, but it is a confused-deputy security binding.
Treat it as sensitive configuration: generate it server-side with at least 128 bits
of entropy, use a unique value per connection, encrypt it at rest, redact it from
general telemetry, and support audited rotation. Never accept a customer-selected
or browser-authoritative ExternalId.

## AWS trust and production hold

Do not onboard a production AWS account until the P0 gates in `README.md` and
`docs/security-and-quality.md` are complete and approved. In particular:

- The customer role trusts one exact vendor workload-role principal, not an account
  root or wildcard, and requires the connection's ExternalId.
- The base customer role is read-only and does not grant secret/payload reads,
  mutation, credential creation, `iam:PassRole`, role chaining, command execution,
  invocation, or KMS decryption.
- Only the isolated AWS broker may call `AssumeRole`. It resolves a registered role
  server-side and uses short-lived credentials in memory.
- Activation requires account/partition verification plus positive correct-
  ExternalId and negative missing/wrong-ExternalId probes.
- Jobs, caches, storage, evidence, and audit records are bound to both organization
  and customer scope, with cross-tenant negative tests.

Suspected cross-tenant disclosure, unauthorized AWS access, credential persistence,
or trust-policy bypass is release-blocking and should be treated as critical until
triage proves otherwise.

## Security expectations for changes

Changes to authentication, authorization, schema scope, AWS IAM/STS, broker/job
protocols, ingestion, exports, controls, logging, encryption, retention, or
deployment require explicit security review and adversarial tests. UI hiding is not
authorization. Missing, inaccessible, stale, or partial evidence must produce
`unknown` or `error`, never a false `pass`.

Pull requests must pass the repository CI checks. Those checks are a baseline only;
they do not replace threat modeling, tenant-isolation tests, IAM policy review,
sandbox acceptance tests, dependency and secret scanning, operational drills, or a
production security assessment.

## Safe-harbor intent

Good-faith research is welcome when it avoids privacy violations, service
disruption, persistence, social engineering, and access to data beyond what is
necessary to demonstrate the issue. Use only accounts and data you own or have
explicit permission to test. Do not test against customer or production systems
without written authorization. This statement does not grant access or override
applicable law or third-party terms.
