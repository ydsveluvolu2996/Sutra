# One-account live AWS demo on a laptop

This runbook starts PostgreSQL in Docker while the prebuilt Sutra web process and
AWS collector run directly on the Mac. The collector uses an existing short-lived
AWS SSO/profile session from the host. Sutra never mounts `~/.aws` into Docker,
copies the SSO cache, writes AWS access keys or session tokens, or accepts static
credential environment variables.

Use only a disposable, non-production AWS account for this release. The current
collector reads the explicitly documented metadata APIs; it is not a hosted
multi-tenant production deployment and it does not enable GuardDuty, Security Hub,
Inspector, or any other billable AWS service.

## What you need before launch

- Docker Desktop running.
- Node.js 22.13 or newer, `pnpm`, the AWS CLI, and repository dependencies installed.
- An AWS IAM Identity Center/SSO operator profile for a disposable account.
- Permission in that account to deploy the two reviewed CloudFormation templates.
- A short-lived role profile whose final identity is the dedicated Sutra source
  collector role. Do not use an IAM user, exported access keys, or an administrator
  profile as the collector identity.

The selected profile must be a role profile whose complete `source_profile` chain
terminates in an IAM Identity Center/SSO profile. Sutra parses the local AWS config
and shared credentials files before starting Docker or contacting AWS. It rejects
static shared-file access keys, `credential_process`, `credential_source`, web
identity files, missing profiles, and source-profile cycles. It never executes a
credential process during this check.

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
resource permissions. Deploy `infrastructure/local-collector-role.yaml` using the
operator profile. `OperatorRoleArn` must be the exact IAM role ARN behind that SSO
permission set, not an STS `assumed-role` session ARN and not account root.

```bash
aws sso login --profile sutra-operator

aws cloudformation deploy \
  --profile sutra-operator \
  --region us-east-1 \
  --stack-name sutra-local-collector \
  --template-file infrastructure/local-collector-role.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    OperatorRoleArn='arn:aws:iam::111122223333:role/aws-reserved/sso.amazonaws.com/AWSReservedSSO_Example_abcdef'

aws cloudformation describe-stacks \
  --profile sutra-operator \
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
source_profile = sutra-operator
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

## Start Sutra in live mode

First stop the fixture application container if it is running. This preserves all
PostgreSQL and Docker volumes:

```bash
pnpm docker:down
aws sso login --profile sutra-operator
```

Unset any credential exports from the shell. The launcher fails closed if any of
these are present:

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
unset AWS_WEB_IDENTITY_TOKEN_FILE AWS_ROLE_ARN AWS_ROLE_SESSION_NAME
unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI
unset AWS_CONTAINER_AUTHORIZATION_TOKEN AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE
```

Run the acknowledgement inline so it is explicit for this launch and is not saved
in the generated runtime file:

```bash
AWS_PROFILE=sutra-demo-collector \
SUTRA_COLLECTOR_PRINCIPAL_ARN='arn:aws:iam::111122223333:role/sutra/SutraLocalCollectorRole' \
SUTRA_LIVE_AWS_ACK='I_ACKNOWLEDGE_THIS_WILL_CONTACT_AWS' \
pnpm live:aws:host
```

The launcher performs the following guarded sequence:

1. Rejects static/token credential environment variables and malformed profile,
   role, Region, or port values, then locally proves the complete profile chain is
   SSO-backed before Docker or AWS work.
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
   name prefix shown by Sutra.
3. With the operator profile—not the restricted collector profile—deploy the
   downloaded `sutra-customer-role-live-demo.yaml` once in the account. Supply the
   displayed values and acknowledge `CAPABILITY_NAMED_IAM`.
4. Copy the stack's `CustomerReadRoleArn` output back into Sutra.
5. Run trust validation. Sutra requires successful identity attestation plus denial
   of missing and incorrect External IDs before the connection becomes active.
6. Run the first inventory sync and inspect CMDB resources, relationships, coverage,
   findings, and change history. Partial collection remains visible as partial and
   cannot replace the last complete snapshot.

For a same-account demo, both CloudFormation stacks can live in the disposable
account: the source role assumes the separate customer read role. Do not broaden
either policy to make onboarding easier.

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
the customer role stack with the operator profile. Finally delete the source role
stack if no other disposable demo connection uses it:

```bash
aws cloudformation delete-stack \
  --profile sutra-operator \
  --region us-east-1 \
  --stack-name sutra-demo-customer-role

aws cloudformation wait stack-delete-complete \
  --profile sutra-operator \
  --region us-east-1 \
  --stack-name sutra-demo-customer-role

aws cloudformation delete-stack \
  --profile sutra-operator \
  --region us-east-1 \
  --stack-name sutra-local-collector
```

Deleting containers does not revoke AWS trust; deleting the customer-owned stack
does. Conversely, deleting AWS roles does not erase local CMDB/audit data. Treat the
PostgreSQL volume, `.sutra/live-aws.env`, and
`.sutra/live-aws-collector-registry.enc` as sensitive customer data. They are
ignored by Git and must not be pushed to GitHub, attached to issues, or included in
a screen recording.

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
