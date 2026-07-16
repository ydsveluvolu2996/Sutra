# One-account live AWS demo on a laptop

This runbook starts PostgreSQL in Docker while the prebuilt Sutra web process and
AWS collector run directly on the Mac. A production-grade local demonstration uses
two accounts: a Sutra/MSP source account and a separate disposable customer account.
The collector uses an existing short-lived AWS SSO/profile session from the host.
Sutra never mounts `~/.aws` into Docker, copies the SSO cache, writes AWS access
keys or session tokens, or accepts static credential environment variables.

Use only disposable, non-production AWS accounts for this release. The current
collector reads the explicitly documented metadata APIs; it is not a hosted
multi-tenant production deployment and it does not enable GuardDuty, Security Hub,
Inspector, or any other billable AWS service.

## What you need before launch

- Docker Desktop running.
- Node.js 22.13 or newer, `pnpm`, the AWS CLI, and repository dependencies installed.
- An AWS IAM Identity Center/SSO operator profile for the Sutra/MSP source account.
- A trusted administrator-created customer managed policy named exactly
  `SutraCollectorBoundary` at the IAM root path, matching
  `infrastructure/sutra-collector-boundary-policy.json`. The Sutra operator may
  read and attach this boundary but must not edit, version, or delete it.
- Temporary administrator or equivalent IAM/CloudFormation permission in that
  source account, and customer-controlled permission to deploy the reviewed
  read-only role in a separate disposable client account.
- A publicly readable, reviewed copy of `public/sutra-customer-role-live-demo.yaml`
  in a commercial-AWS regional S3 HTTPS URL if you want the one-click customer
  quick-create flow. The URL must pin an immutable non-null `versionId`; never use
  a presigned or versionless URL.
- A short-lived role profile whose final identity is the dedicated Sutra source
  collector role. Do not use an IAM user, exported access keys, or an administrator
  profile as the collector identity.

The selected profile must be a role profile whose complete `source_profile` chain
terminates in an IAM Identity Center/SSO profile. Sutra parses the local AWS config
and shared credentials files before starting Docker or contacting AWS. It rejects
static shared-file access keys, `credential_process`, `credential_source`, web
identity files, missing profiles, source-profile cycles, and `endpoint_url` or
`services` overrides on every profile in the selected chain. Process-level
`AWS_ENDPOINT_URL` and `AWS_ENDPOINT_URL_<SERVICE>` values are also rejected, and
even empty inherited endpoint variables are removed from every AWS CLI child
environment. It never executes a credential process during this check.

By default the launcher reads `~/.aws/config` and `~/.aws/credentials`. Standard
absolute `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` overrides are honored
only when the selected files are regular, owned by the current user, not symlinks,
and not writable by group or other users. Relative paths and unsafe files fail
closed. The validated paths are passed only to the host collector; they are not
mounted into Docker or given to the web process.

Install and verify the local code before contacting AWS:

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` is fixture/local infrastructure verification; it does not use an AWS
profile.

## One-time source-role setup

The source role can assume only `/sutra/SutraReadOnlyRole` and has no direct AWS
resource permissions. Its fixed commercial-partition permissions boundary contains
an explicit deny for every non-`sts:AssumeRole` action, an explicit deny for
`sts:AssumeRole` outside that exact path/name, and the one matching allow. The deny
statements keep this an absolute ceiling even if another identity policy is later
attached. This local preparation flow rejects GovCloud and China partitions; use
separate reviewed roles and policies for those partitions. Before delegating setup,
a trusted administrator must create the
boundary outside the operator-controlled CloudFormation stack, using the IAM
console with the root path and exact policy document or the equivalent command:

```bash
aws iam create-policy \
  --policy-name SutraCollectorBoundary \
  --policy-document file://infrastructure/sutra-collector-boundary-policy.json
```

Do not grant the Sutra operator `iam:CreatePolicy`, `iam:CreatePolicyVersion`,
`iam:SetDefaultPolicyVersion`, or `iam:DeletePolicy`. The recommended preparation
command validates that the local boundary document matches the reviewed contract,
attests the existing IAM policy's default version, validates that the selected
profile is SSO-backed, and deploys the reviewed source-role stack. After every
deployment or reuse it reads live IAM state and requires the exact trust principal,
role path/name/description, 3,600-second maximum session, six reviewed role/stack tags,
boundary, single inline policy name and document, and zero attached managed
policies. CloudFormation's `NOT_CHECKED` drift marker is not treated as evidence.
Only then does it create the restricted collector role profile and verify its
resulting STS identity:

```bash
AWS_PROFILE=sutra-msp-operator \
AWS_REGION=us-east-1 \
SUTRA_LIVE_AWS_SETUP_ACK='I_ACKNOWLEDGE_THIS_CREATES_THE_SUTRA_SOURCE_ROLE' \
pnpm live:aws:prepare
```

It rejects exported/static credentials. The manual equivalent is retained below
for review and troubleshooting. `OperatorRoleArn` must be the exact IAM role ARN
behind that SSO permission set, not an STS `assumed-role` session ARN and not
account root.

The reviewed operator permission-set inline policy for this pilot is checked in as
`infrastructure/sutra-operator-permission-set-policy.json` (SHA-256
`093292b0f6733bdddbcdb5bc34b31a0562e6350c77d8d4d76b744a7892b9ba7e`). It is
deliberately fixed to account `738663485493`, Region `us-east-1`, stack
`sutra-local-collector`, the current Identity Center role suffix, the exact source
role and boundary, the deterministic template bucket, and both reviewed template
digests. It contains no placeholders and can be installed directly only in that
pilot permission set. If the permission set is deleted/recreated or either template
changes, review and update the artifact and its contract test before provisioning.
The live IAM attestation adds only `iam:ListRolePolicies`, `iam:GetRolePolicy`, and
`iam:ListAttachedRolePolicies` on the exact source role. Crash-safe publisher
recovery adds only `s3:ListBucket` and `s3:ListBucketVersions` on the exact template
bucket; `s3:ListBucket` also authorizes the owner-bound `HeadBucket` checks.
The operator policy intentionally omits `iam:DeleteRolePermissionsBoundary`; a
trusted administrator must perform any teardown that requires removing the cap.

```bash
aws sso login --profile sutra-msp-operator

aws cloudformation deploy \
  --profile sutra-msp-operator \
  --region us-east-1 \
  --stack-name sutra-local-collector \
  --template-file infrastructure/local-collector-role.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    OperatorRoleArn='arn:aws:iam::111122223333:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Example_abcdef'

aws cloudformation describe-stacks \
  --profile sutra-msp-operator \
  --region us-east-1 \
  --stack-name sutra-local-collector \
  --query 'Stacks[0].Outputs[?OutputKey==`CollectorRoleArn`].OutputValue' \
  --output text
```

Replace the example account and role ARN. If IAM Identity Center created the role
under a regional path, retain that complete path. The operator permission set also
needs permission to assume the new source role.

Create a role profile in `~/.aws/config`; this is AWS CLI configuration, not a Sutra
runtime file:

```ini
[profile sutra-demo-collector]
role_arn = arn:aws:iam::111122223333:role/sutra/SutraLocalCollectorRole
source_profile = sutra-msp-operator
role_session_name = sutra-local-demo
duration_seconds = 3600
region = us-east-1
```

Confirm that the profile resolves to the source role. Its returned ARN should be an
STS `assumed-role/SutraLocalCollectorRole/...` ARN in the expected account:

```bash
AWS_PROFILE=sutra-demo-collector aws sts get-caller-identity
```

Do not paste that command's credentials or SSO cache into Sutra. The profile name
is the only AWS selector supplied to the launcher. The launch preflight independently
requires expiring credentials with at least 15 minutes remaining and checks the
account and role against the exact IAM principal ARN.

## Publish the reviewed quick-create template

The following guarded command creates a dedicated provider-owned S3 bucket and
marks its exact Sutra publishing purpose before changing any bucket controls. A
later run reuses the bucket only when the AWS account owner and both purpose tags
match. If the first run stopped after creating the deterministic bucket but before
tagging it, one recovery path is allowed: `ExpectedBucketOwner` must prove the same
account, `GetBucketTagging` must return exactly `NoSuchTagSet`, and both current
objects and versions/delete markers must be empty. A custom, ambiguous, non-empty,
or otherwise unmarked bucket is rejected without mutation. The
publisher blocks public ACLs and public bucket listing, enables versioning and encryption,
publishes only the digest-named reviewed template object, and downloads its exact
version publicly to verify the SHA-256 before printing the version-pinned URL:

```bash
AWS_PROFILE=sutra-msp-operator \
AWS_REGION=us-east-1 \
SUTRA_LIVE_AWS_TEMPLATE_ACK='I_ACKNOWLEDGE_THIS_PUBLISHES_A_PUBLIC_READ_ONLY_TEMPLATE' \
pnpm live:aws:publish-template
```

The template is intentionally public because AWS CloudFormation must retrieve it
for quick create. It contains no customer ID, ExternalId, credentials, or customer
data. The output URL is non-secret configuration; retain it for the launch command.

## Start Sutra in live mode

First stop the fixture application container if it is running. This preserves all
PostgreSQL and Docker volumes:

```bash
pnpm docker:down
aws sso login --profile sutra-msp-operator
```

Unset any credential exports from the shell. The launcher fails closed if any of
these are present:

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
unset AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN AWS_ROLE_SESSION_NAME
unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI
unset AWS_CONTAINER_AUTHORIZATION_TOKEN AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
unset AWS_ENDPOINT_URL AWS_ENDPOINT_URL_STS AWS_ENDPOINT_URL_IAM
unset AWS_ENDPOINT_URL_CLOUDFORMATION AWS_ENDPOINT_URL_S3
```

Run the acknowledgement inline so it is explicit for this launch and is not saved
in the generated runtime file:

```bash
AWS_PROFILE=sutra-demo-collector \
SUTRA_COLLECTOR_PRINCIPAL_ARN='arn:aws:iam::111122223333:role/sutra/SutraLocalCollectorRole' \
SUTRA_CUSTOMER_ROLE_TEMPLATE_URL='https://your-reviewed-artifacts.s3.us-east-1.amazonaws.com/templates/live-demo-2026-07.1/9e1388f98d55bc54254b8def9844a41ea916acacfa37144cd67a8a4dce4f1d42.yaml?versionId=publisher-output' \
SUTRA_LIVE_AWS_ACK='I_ACKNOWLEDGE_THIS_WILL_CONTACT_AWS' \
pnpm live:aws:host
```

`SUTRA_CUSTOMER_ROLE_TEMPLATE_URL` is non-secret configuration. Sutra accepts
only a regional commercial-AWS S3 HTTPS URL whose path names the exact reviewed
template version and SHA-256, with exactly one non-null `versionId` query.
If it is omitted or incompatible with the selected partition, onboarding keeps
the reviewed template-download and manual-upload path and does not present a
quick-launch button. Malformed, non-S3, or signed configuration is rejected before
a handoff is created; remove or correct it before retrying.

The launcher performs the following guarded sequence:

1. Rejects static/token credentials, AWS endpoint overrides, and malformed profile,
   role, Region, or port values, then locally proves the complete profile chain is
   SSO-backed and contains no endpoint/service override before Docker or AWS work.
2. Refuses to run beside the fixture app container and verifies the loopback web
   and collector ports are free.
3. Starts only the PostgreSQL service on loopback under the dedicated
   `sutra-live-aws` Compose project and applies migrations with the owner role;
   runtime queries use the restricted `sutra_app` role. The live database volume
   is separate from the fixture database so their independent encryption keyrings
   can never read or overwrite each other's ciphertext.
4. Creates or updates ignored `.sutra/live-aws.env` atomically with mode `0600`.
   It contains local application secrets and the local database URL, but never an
   AWS profile, access key, session token, SSO cache, or launch acknowledgement.
   If the live PostgreSQL volume already exists but this file is missing, launch
   fails closed instead of generating a different encryption keyring over existing
   ciphertext.
5. Builds the web artifact and collector, then contacts STS for the source-identity
   preflight. The web process receives no `AWS_*` variables.
6. Starts the host collector and built web artifact and waits for the combined
   health endpoint before announcing readiness.

Open `http://127.0.0.1:3000/login`. Retrieve only the one-time local setup token:

```bash
SUTRA_LOCAL_CONFIG_PATH=.sutra/live-aws.env pnpm local:bootstrap-token
```

Never print or share the rest of `.sutra/live-aws.env`.

## Onboard the disposable account

1. Sign in, enable MFA, open **AWS onboarding**, and create the account connection.
2. Copy the one-time External ID, tenant ID, exact collector principal, and session
   name prefix shown by Sutra. Keep this handoff page open.
3. In a private browser window signed in to the exact customer account, choose
   **Open AWS CloudFormation**. Review the prefilled template and trust values,
   acknowledge `CAPABILITY_NAMED_IAM`, create the stack, and wait for
   `CREATE_COMPLETE`. If quick launch is unavailable, download the reviewed
   template, upload it in the customer's CloudFormation console, and paste the
   displayed parameters manually.
4. Copy the stack's `CustomerReadRoleArn` output back into Sutra.
5. Run trust validation. Sutra requires successful identity attestation plus denial
   of missing and incorrect External IDs before the connection becomes active.
6. Run the first inventory sync and inspect CMDB resources, relationships, coverage,
   findings, and change history. Partial collection remains visible as partial and
   cannot replace the last complete snapshot.

The quick-create link exists only while Sutra displays the one-time External ID.
Its prefilled parameters are encoded after the AWS Console URL fragment marker, so
they are not sent to Sutra or an HTTP endpoint. Browsers can retain a visited URL
in local history: close the private window after role registration and never paste
the quick-create URL into chat, tickets, recordings, or logs.

A same-account rehearsal is possible, but it does not prove real MSP-to-customer
cross-account onboarding. Use separate accounts before presenting the result as a
client-ready live demonstration. Do not broaden either role to make onboarding
easier.

## Stop and rollback

Press `Ctrl-C` in the launcher Terminal. It terminates both host processes. If the
launcher started PostgreSQL, it also stops that container; if PostgreSQL was already
running, it leaves it running. The named database volume and ignored live runtime
files remain for the next demo.

After an interrupted Terminal session, this command safely stops the dedicated
live Compose project without deleting its named database volume:

```bash
docker compose \
  --project-name sutra-live-aws \
  --env-file .sutra/docker.env \
  down
```

If only PostgreSQL must be stopped:

```bash
docker compose \
  --project-name sutra-live-aws \
  --env-file .sutra/docker.env \
  stop postgres
```

To revoke AWS access, first disable/offboard the connection in Sutra, then delete
the customer role stack with the customer-account operator profile. Finally delete
the source role stack with the MSP operator profile if no other disposable demo
connection uses it:

```bash
aws cloudformation delete-stack \
  --profile sutra-client-operator \
  --region us-east-1 \
  --stack-name sutra-demo-customer-role

aws cloudformation wait stack-delete-complete \
  --profile sutra-client-operator \
  --region us-east-1 \
  --stack-name sutra-demo-customer-role

aws cloudformation delete-stack \
  --profile sutra-msp-operator \
  --region us-east-1 \
  --stack-name sutra-local-collector
```

Deleting containers does not revoke AWS trust; deleting the customer-owned stack
does. Conversely, deleting AWS roles does not erase local CMDB/audit data. Treat the
PostgreSQL volume, `.sutra/live-aws.env`, and
`.sutra/live-aws-collector-registry.enc` as sensitive customer data. They are
ignored by Git and must not be pushed to GitHub, attached to issues, or included in
a screen recording.

The external `SutraCollectorBoundary` policy is intentionally not deleted with the
source-role stack. Only a trusted administrator should remove it, after confirming
that no collector role still uses it; the Sutra operator must not receive boundary
policy mutation or deletion permission for cleanup.

The `pnpm docker:*` and `pnpm db:postgres:*` maintenance commands target the
separate fixture project. The coordinated Docker fixture backup does not include
the live Compose database or host-only live collector registry. Do not claim a host
live-demo backup until a separate encrypted, tested backup procedure for the live
database and host files has been completed.

If `.sutra/live-aws.env` is lost while the live volume remains, restore the exact
original permission-restricted file before starting. Do not manufacture replacement
keys. If the demo data is intentionally disposable and no recovery is required,
stop the live project and remove all mutually dependent live state before a fresh
launch:

```bash
docker compose \
  --project-name sutra-live-aws \
  --env-file .sutra/docker.env \
  down
docker volume rm sutra-live-aws_sutra_postgres_data
rm -f .sutra/live-aws-collector-registry.enc .sutra/live-aws-jobs.json
```

That reset permanently deletes the live CMDB, users, audit history, encrypted
connection registry, and job state. It does not delete either AWS CloudFormation
stack; revoke those separately as described above.
