# sutracmdb.com rollout

Public registry and Cloudflare dashboard checks on 17 July 2026 confirmed:

- `sutracmdb.com` is registered through Cloudflare Registrar until 17 July 2027;
- registrar transfer protection is active;
- the authoritative nameservers are `ines.ns.cloudflare.com` and
  `javon.ns.cloudflare.com`;
- the Cloudflare zone is active in full-DNS mode;
- no DNS records currently publish a website, API or customer portal.

The production hostname contract is:

| Hostname | Purpose | Release condition |
| --- | --- | --- |
| `sutracmdb.com` | Public product and trust site | Public marketing build, security headers, HTTPS and monitoring |
| `www.sutracmdb.com` | Redirect to the apex | Apex site healthy |
| `app.sutracmdb.com` | Authenticated customer/MSP control plane | Hosted identity, tenant-isolation and broker P0 gates complete |
| `api.sutracmdb.com` | Optional future API/broker edge | Asymmetric service authentication, replay controls and rate limits complete |
| `docs.sutracmdb.com` | Customer documentation | Reviewed documentation release |

Do not create placeholder A records, expose the laptop through a tunnel, or point
`app.sutracmdb.com` at the current private beta. DNS activation is the final
release step after the corresponding service is deployed and healthy. Email
records must be added only when a mail provider is selected; publish SPF, DKIM
and DMARC together rather than guessing placeholder values.

The public crawl/indexing contract and the post-deployment Search Console steps
are documented in [Google Search indexing](./google-search-indexing.md). Search
Console ownership verification is an external domain-owner action; never commit
its one-time DNS token to this repository.
