# Data security posture evidence

Sutra's DSPM workspace stores normalized metadata about data stores. It never
stores object samples, matched values, credentials, policy documents, or scanner
payloads. Unknown request fields fail closed at the API boundary.

`POST /api/v1/dspm` accepts one immutable, idempotent publication for an AWS
connection. Organization scope comes from the authenticated session and customer
scope comes from Sutra's connection row; neither is accepted from the request
body. Publishing requires `connection:manage`. Reading requires
`connection:read`.

Supported sources are:

- `aws-macie` for a producer that normalizes Amazon Macie evidence;
- `agentless-classifier` for Sutra's scanner pipeline; and
- `normalized-import` for a controlled operator import.

Each asset supplies only its resource identity, store type, region,
classification, allowlisted category labels, data-owner reference, aggregate
size, and nullable control states. The deterministic risk engine explains every
point through factor codes and remediation text. A partial source must disclose
its coverage limitations; no scan is represented as `NEVER_SCANNED`, not as a
clean result.

## Production activation dependency

The persistence, risk engine and API are credential-free. Automatic discovery
still requires an approved AWS Macie collector or the agentless classifier to
publish this normalized contract. Until then the API truthfully reports
`automaticAwsMacieCollection: false`; it does not imply that an empty workspace
is clean.
