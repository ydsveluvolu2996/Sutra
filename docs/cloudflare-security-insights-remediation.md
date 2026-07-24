# Cloudflare Security Insights remediation

Reviewed on 24 July 2026 for `sutracmdb.com`. Security Insights are
configuration suggestions discovered by periodic scans. A finding is not proof
of an exploitable vulnerability, and a resolved finding can remain visible until
it is archived or the next scan runs.

## Decision register

| Insight | Decision | Owner / action | Verification |
| --- | --- | --- | --- |
| `Security.txt not configured` | Resolved in the release. Both standard paths are served by the Worker and by Caddy during Worker-limit fail-open. | Deploy the reviewed origin bundle; deploy the Worker when quota permits. | Both `https://www.sutracmdb.com/.well-known/security.txt` and `https://www.sutracmdb.com/security.txt` return `200`, `text/plain`, the same reviewed fields, and never require application authentication. |
| `Domains without HSTS: sutracmdb.com` | Begin with a reversible edge policy. Do not preload this private-beta zone. | In Cloudflare **SSL/TLS → Edge Certificates → HSTS**, set HSTS **On**, max-age **1 month**, includeSubDomains **Off**, preload **Off**, and No-Sniff **On**. | HTTPS responses for apex, `www`, and the WAF-blocked `origin` hostname contain `Strict-Transport-Security: max-age=2592000` and `X-Content-Type-Options: nosniff`. |
| `Domains without HSTS: origin.sutracmdb.com` | Use the same zone-edge HSTS setting. The protected origin returns its `403` at Cloudflare before Caddy, so an origin-only header cannot cover that response. | Same dashboard change as above. | A direct request to `https://origin.sutracmdb.com/` remains `403` and gains the HSTS header. It must never return Sutra content. |
| Live HTTP first-request exposure (not in the latest seven-row insight export) | Resolve before extending HSTS. On review, `http://www.sutracmdb.com/` returned application HTML with `200` instead of redirecting. HSTS does not protect a visitor's first HTTP request. | Turn Cloudflare **Always Use HTTPS** **On** for the zone. This edge control does not consume Worker requests and remains effective when the Worker fails open. | `http://www.sutracmdb.com/` and `http://sutracmdb.com/` redirect to HTTPS without application HTML or session material; the protected origin remains blocked. |
| `DMARC Record Error: send.sutracmdb.com` | Add a valid monitoring policy without publishing an unmonitored reporting mailbox. Do not enforce quarantine/reject until delivery has been observed. | Add TXT name `_dmarc.send`, value `v=DMARC1; p=none;`, TTL Auto. Also add the organizational-domain TXT name `_dmarc`, value `v=DMARC1; p=none;`, because the visible From address is evaluated at the organizational domain, not the Return-Path domain. | `dig +short TXT _dmarc.send.sutracmdb.com` and `dig +short TXT _dmarc.sutracmdb.com` each return exactly one valid DMARC record; test messages show `dmarc=pass` in received headers. |
| `Bot Fight Mode not enabled` | Accepted risk: keep basic Bot Fight Mode **Off**. It is zone-wide, may challenge API/mobile traffic, and cannot be bypassed with WAF rules. Sutra exposes API v1, webhooks, collectors, health probes, and automation clients. | Archive the insight with the rationale below. Continue endpoint rate limits and add narrowly scoped WAF controls only after observing Security Analytics. A future paid bot product is optional, not required for this release. | API, webhook, collector, health, and browser journeys remain functional; abuse controls and rate-limit tests remain green. Review this exception before 24 October 2026. |
| `No Turnstile enabled` | Implement on anonymous human forms only, never globally and never on machine endpoints. A widget alone is not a security control. | Create a Managed Turnstile widget restricted to `www.sutracmdb.com`; store the secret outside Git; embed it on the public contact form; require server-side Siteverify before accepting the form. Add login only after recovery and accessibility testing. | Valid single-use tokens pass; missing, invalid, expired, replayed, wrong-hostname, and wrong-action tokens fail; provider outage behavior is explicit and monitored. |
| `Cloudflare user yds.veluvolu@gmail.com without MFA` | Must be fixed by the human account owner. Do not automate enrollment or handle recovery secrets through an agent. | In **My Profile → Authentication**, add a phishing-resistant security key or device passkey plus TOTP as a second method. Save backup codes in the password manager, then enable account member 2FA enforcement if available. | Sign out and sign in with the primary factor; test one backup method; confirm Security Insights no longer reports the user after rescan. |

## Dashboard values

### HSTS

Use these initial values:

```text
Always Use HTTPS:         On
Enable HSTS:              On
Max Age Header:           1 month (2592000 seconds)
Apply to subdomains:      Off
Preload:                  Off
No-Sniff Header:          On
```

Enable Always Use HTTPS first. The current Caddy release sends a five-minute
HSTS pilot header on origin-served responses, but the live `www` hostname still
served application HTML for a first HTTP request during this review. The
Cloudflare edge HSTS setting is also required because direct requests to the
protected `origin` hostname are blocked at Cloudflare and do not reach Caddy.
After at least 30 days of HTTPS-only operation and a complete inventory of every
subdomain, max-age can be increased. Do not enable `includeSubDomains` or preload
merely to silence a scanner: mail, validation, retired, or future subdomains
without working HTTPS would become inaccessible to browsers.

### DMARC

Create exactly one TXT record at each name:

```text
Type: TXT
Name: _dmarc.send
Value: v=DMARC1; p=none;
TTL: Auto

Type: TXT
Name: _dmarc
Value: v=DMARC1; p=none;
TTL: Auto
```

`send.sutracmdb.com` is the Resend Return-Path domain and currently publishes
the expected Amazon SES SPF include. DMARC evaluates the RFC5322 From domain, so
the organizational-domain record is the important companion control. The
monitoring policy is deliberately non-enforcing while all legitimate senders
are inventoried. A `rua` address is omitted because no monitored aggregate-report
mailbox or analyzer endpoint is currently approved. Add `rua` only after that
destination exists and is owned, then observe passing mail before progressing
to `p=quarantine` and finally `p=reject`.

### Bot Fight Mode exception

Archive the insight with this rationale:

```text
Accepted through 2026-10-24. Cloudflare basic Bot Fight Mode is zone-wide,
may challenge non-browser API traffic, and cannot be skipped by WAF rules.
Sutra has authenticated API, webhook, collector, health-check, and automation
traffic. Existing endpoint throttles remain enforced. Reassess a granular bot
product after traffic baselining; do not enable the basic mode on production.
```

Archiving records an intentional design decision; it must not be described as a
fixed vulnerability.

## Read-only validation

Run after DNS propagation and the Cloudflare configuration changes:

```bash
dig +short TXT _dmarc.send.sutracmdb.com
dig +short TXT _dmarc.sutracmdb.com

curl -fsS -D- https://www.sutracmdb.com/.well-known/security.txt
curl -fsS -D- https://www.sutracmdb.com/security.txt
curl -fsS -o /dev/null -D- https://sutracmdb.com/
curl -sS -o /dev/null -D- https://origin.sutracmdb.com/
curl -sS -o /dev/null -D- http://www.sutracmdb.com/
curl -sS -o /dev/null -D- http://sutracmdb.com/
```

Expected invariants:

- the canonical security contact file remains reachable if the application is
  unavailable or Worker requests fail open;
- plaintext public requests redirect before returning any application body;
- apex remains a safe-method redirect to `www`;
- the protected origin remains `403`;
- all three HTTPS responses carry HSTS after the edge setting is enabled;
- each DMARC owner name has exactly one TXT policy;
- API/webhook/collector smoke tests are run after any bot-control change.

## Primary references

- [Cloudflare Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)
- [Cloudflare HSTS requirements and settings](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/http-strict-transport-security/)
- [Cloudflare Bot Fight Mode considerations and limitations](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)
- [Cloudflare Security Insights review and archive workflow](https://developers.cloudflare.com/security/security-insights/review-insights/)
- [Cloudflare two-factor authentication](https://developers.cloudflare.com/fundamentals/user-profiles/2fa/)
- [Cloudflare Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Resend DMARC rollout guidance](https://resend.com/docs/dashboard/domains/dmarc)
- [Resend DMARC policy discovery for subdomains](https://resend.com/blog/how-dmarc-applies-to-subdomains)
