# Google Search indexing for sutracmdb.com

Sutra exposes one deliberately small public search surface at
`https://www.sutracmdb.com`. The authenticated application, customer data,
invitation flows and APIs are not search content.

## Implemented search contract

| Surface | Search behavior |
| --- | --- |
| `/`, `/about`, `/contact`, `/security`, `/privacy`, `/terms`, `/status` | Indexable only on the canonical `www.sutracmdb.com` origin; each page has its own canonical URL, description, Open Graph and Twitter metadata |
| `/sitemap.xml` | Contains only the seven reviewed public URLs, all absolute canonical URLs |
| `/robots.txt` | Points to the canonical sitemap; suppresses machine APIs, MFA and token-bearing invitation paths while allowing framework CSS and JavaScript required to render public pages |
| Login, dashboards, onboarding, settings, docs and every other application page | Inherits `noindex, nofollow`; the edge also emits `X-Robots-Tag: noindex, nofollow` |
| API routes and customer data | Authenticated/authorized as before and additionally excluded from indexing at the response layer |
| Preview and alternate hostnames | Always receive the response-level `noindex, nofollow` directive |

The public home page includes claim-minimal JSON-LD for the Sutra organization,
website and web security application. It intentionally does not publish an
offer, price, rating, customer count, certification, address or other claim that
has not been substantiated. An `offers` object can be added later only after a
real public price is available.

The current private beta uses Sutra's `staging` identity contract even at the
public domain. The response policy therefore permits indexing in both `staging`
and `production`, but only for the reviewed paths and only when the request
origin is exactly `https://www.sutracmdb.com`. This does not make authenticated
staging pages indexable.

## Release validation

After deployment, run these checks from outside the origin:

```bash
curl -fsS https://www.sutracmdb.com/robots.txt
curl -fsS https://www.sutracmdb.com/sitemap.xml
curl -sSI https://www.sutracmdb.com/ | grep -i x-robots-tag
curl -sSI https://www.sutracmdb.com/login | grep -i x-robots-tag
curl -sSI https://www.sutracmdb.com/dashboard | grep -i x-robots-tag
```

The public home response should have no `X-Robots-Tag`; the login and dashboard
responses must return `X-Robots-Tag: noindex, nofollow`. Confirm that every
sitemap URL returns a successful public HTML response and a self-referencing
canonical tag. Validate the home page with Google's Rich Results Test. Valid
structured data does not guarantee a rich result or a ranking.

## One external action still required

Code cannot enroll a domain in Google Search. A domain owner must:

1. add the `sutracmdb.com` **Domain property** in Google Search Console;
2. copy Google's unique DNS verification value into a Cloudflare TXT record and
   complete verification;
3. submit `https://www.sutracmdb.com/sitemap.xml` in Search Console;
4. inspect `https://www.sutracmdb.com/` and request indexing after this release
   is live.

Do not commit the Google verification token. DNS verification is preferable for
the whole domain and must be completed in the Cloudflare account. Google decides
when and whether a page is indexed, so this work makes the site eligible and
discoverable but cannot promise immediate listing.
