# Foundational FinOps broker activation contract

Status: source contract implemented; production activation intentionally gated.

The FinOps S3 object broker accepts only this exact composition:

1. Base collector role permission pack `standard-2026-08.1`.
2. One or both separately published immutable add-ons:
   - `foundational-cur2-export-v1` / `SutraFoundationalCur2ReadV1`
   - `foundational-focus12-export-v1` / `SutraFoundationalFocus12ReadV1`
3. A server-owned `foundationalFinopsContracts` binding in the encrypted broker
   connection record. Each entry binds the tenant, connection, AWS account,
   partition, Region, bucket, export prefix, export name, export ARN, table,
   contract ID and inline policy name.

The binding is deliberately absent from the public registration and signed
object-read request schemas. A customer request can select only an already
recorded exact binding; it cannot supply an ARN, change the persisted prefix or
widen the STS session. Before any S3 request the broker:

- rejects `.4`, missing bindings, malformed bindings and cross-tenant bindings;
- matches contract ID, export name, Region, bucket and prefix exactly;
- assumes a session whose S3 resource is only the recorded prefix;
- re-attests the exact `.8.1` base policy, exact inline-policy-name set, no
  managed policies, and every statement/resource in each recorded add-on.

Any missing, changed or additional policy fails closed.

## External production gate

The hosted PostgreSQL registry already encrypts the full connection JSON, so no
SQL migration is required for this optional nested contract. There is currently
no public or automatic writer for the field. Production remains fail-closed
until a separately reviewed operator workflow:

1. deploys the published `.8.1` base template and immutable add-on template;
2. reads their CloudFormation outputs from the customer account;
3. verifies stack/template identity and the exact output tuple;
4. writes the tuple through a server-only audited registry operation; and
5. executes the live role/policy attestation and object-read acceptance test.

Do not activate the successor pack by editing a connection row manually or by
adding these fields to the client registration API.
