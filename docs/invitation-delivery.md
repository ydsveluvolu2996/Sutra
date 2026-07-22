# Membership invitation delivery

## What was previously happening

`POST /api/v1/invitations` created a secure, single-use invitation and returned
the activation URL to the administrator. It did **not** call an email provider.
The UI wording made the manual copy/share path easy to mistake for sent email,
which explains why a recipient could receive nothing even though the invitation
row existed.

Sutra now attempts transactional email and reports the result separately from
invitation creation. `accepted` means the configured provider returned 2xx; it
does not prove inbox placement. Missing configuration, provider rejection and
ambiguous network outcomes remain explicit. The one-time activation URL is
still returned once as a controlled fallback.

## Hosted EC2 private-beta configuration

First authenticate `sutracmdb.com` with a transactional provider and verify the
exact sender address. Then open an interactive SSM session to the host:

```bash
cd /opt/sutra
sudo deploy/ec2/configure-invitation-email.sh
```

The helper accepts only Resend or SendGrid, reads the API key without echo,
never accepts it on the command line, writes it to the ignored mode-`0600`
runtime file on encrypted EBS, and recreates only the application container.
It does not place the key in CloudFormation parameters, Git, shell history or
normal command output. The final managed/HA deployment should move this key to
a managed secret store and rotate it on a schedule.

Required runtime values are:

| Variable | Meaning |
| --- | --- |
| `SUTRA_INVITATION_FROM` | Provider-verified sender, for example `Sutra <access@sutracmdb.com>` |
| `SUTRA_INVITATION_EMAIL_PROVIDER` | `resend` or `sendgrid` |
| `SUTRA_INVITATION_EMAIL_API_URL` | Provider HTTPS send endpoint |
| `SUTRA_INVITATION_EMAIL_API_KEY` | Secret API credential |
| `SUTRA_PUBLIC_ORIGIN` | Canonical HTTPS site origin used in activation links |

## Delivery and resend guarantees

- Sutra stores only the invitation-token digest; email request bodies and raw
  activation URLs are never persisted or logged.
- Delivery state, bounded error code, attempt count and timestamps are durable.
- Each delivery start/outcome is appended to the invitation's immutable,
  hash-linked event stream without provider response bodies or secrets.
- Resend requires `Idempotency-Key`. Replaying the same key never rotates the
  token and never authorizes a second email. A deliberate retry uses a fresh
  key, invalidating the previous activation URL immediately.
- A timeout is `unknown`, because the provider may have accepted the message.
  Sutra never silently retries an unknown request with the same key.
- Email endpoints are restricted to public HTTPS literals/hosts and redirects
  are rejected. Network egress controls remain required to close DNS rebinding.

For a controlled delivery test, create an invitation to an address you own,
confirm the UI/API says `accepted`, and then check inbox and spam. If it says
`failed`, use `errorCode`; never paste an API key or activation URL into logs or
support tickets.
