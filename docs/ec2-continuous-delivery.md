# Sutra EC2 continuous delivery

## Decision

Keep the private-beta application and PostgreSQL on the existing single EC2
host for now. Do not move the Sutra application to S3: this repository uses a
Next.js Node server, request-aware route handlers, cookies, MFA, authenticated
APIs, background jobs and live AWS collectors. S3 can serve only static files,
so an S3 move would require splitting and redesigning the application without
removing the need for an application runtime.

The fast release path is instead:

```text
reviewed main commit
  -> manual GitHub Actions release
  -> short-lived GitHub OIDC session (no AWS keys)
  -> build + Trivy gate + immutable ECR digest
  -> SSM command to one exact EC2 instance
  -> transactional release-update.sh + automatic failure rollback
  -> public health, login and status checks
```

This removes laptop builds, source copies, SSH and server-side compilation from
normal releases. GitHub Actions uses a branch-scoped build cache; the EC2 host
only pulls the new digest and applies the already-implemented release
transaction.

## One-time AWS setup

The account-level GitHub OIDC provider in
`infrastructure/github-oidc-provider.yaml` is shared with the Kubernetes release
workflow and must be created only once. Deploy
`infrastructure/github-ec2-release-role.yaml` as a separate stack, passing:

- the existing OIDC provider ARN;
- existing ECR repository `sutra/app`; and
- the exact instance ID output by `sutra-private-beta`.

The template itself fixes the OIDC subject to exact repository
`ydsveluvolu2996/Sutra` and exact ref `refs/heads/main`; neither value is a
deploy-time parameter that can accidentally broaden the trust policy.

The role cannot create or delete repositories, mutate general infrastructure,
start or stop EC2, deploy to another instance, read SSM parameters, or open an
interactive session. It can push to `sutra/app`, send only the stack-owned
`Sutra-DeployImmutableRelease` document to that exact
managed node, and read only the resulting command status. The custom document
accepts one validated digest parameter through SSM environment-variable
interpolation; arbitrary shell commands never cross the GitHub/AWS boundary.
`GetCommandInvocation` requires an unscoped IAM resource because that API does
not expose a useful resource-level authorization boundary; the workflow already
needs the command ID it just created and the exact instance ID.

Before the first run, confirm that the existing repository satisfies the
fail-closed release checks:

```bash
aws ecr describe-repositories \
  --region ap-south-1 \
  --repository-names sutra/app \
  --query 'repositories[0].{Mutability:imageTagMutability,Encryption:encryptionConfiguration.encryptionType}'
```

The current repository is already `IMMUTABLE`. If a future inspection differs,
stop and restore that setting through a reviewed infrastructure change before
releasing. Keep the existing lifecycle policy that retains three tagged `sha-`
releases and expires abandoned untagged layers. The workflow scans the exact
pushed digest with Trivy; it does not require or silently enable an ECR
scan-on-push mode.

## One-time GitHub setup

Do not create a deployment environment for this workflow. GitHub Free does not
make environments or environment variables available to a private repository.
The workflow instead uses ordinary repository Actions variables, is
manual-only, rejects every ref except exact `main`, and runs its own bounded
source/release gates. AWS independently rejects every OIDC subject except the
exact `main` branch of `ydsveluvolu2996/Sutra`, so a workflow created on another
branch cannot assume the release role.

Under **Settings -> Secrets and variables -> Actions -> Variables**, set these
repository variables (not secrets):

| Variable | Value |
| --- | --- |
| `AWS_ACCOUNT_ID` | `738663485493` |
| `AWS_REGION` | `ap-south-1` |
| `AWS_ROLE_ARN` | `GitHubEc2ReleaseRoleArn` stack output |
| `EC2_INSTANCE_ID` | exact `sutra-private-beta` instance ID |

No `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, GitHub personal access token,
SSH key, database password or Cloudflare credential belongs in GitHub.

Run the existing CI and security jobs for `main` before release. The release
workflow also reruns its bounded source gates and is deliberately manual and
serialized: GitHub Actions -> **Release Sutra private beta to EC2** -> **Run
workflow**, then enter a release reason. The reason must be 10-100 characters
because it is also recorded as the SSM command comment. A push alone does not
spend AWS compute or deploy.

The exact-branch cloud trust is not a replacement for pull-request review or
branch protection: a repository writer who can change `main` can change released
code. If the repository later moves to GitHub Pro or a plan with private-repo
environment controls, add protected-branch review and migrate the workflow,
OIDC subject and IAM template together to a protected deployment environment.

## Runtime and cost behavior

A manually dispatched release never starts or stops EC2. Start the exact Sutra
host first, wait until it is connected to SSM, and then dispatch the release.
The workflow fails with a clear instruction when the host is offline. Stop the
host manually after validation or the demo. Automatic daily and maximum-runtime
stops are disabled during this manual-control phase and can be reintroduced later
as explicit, separately reviewed opt-in settings.

From the checked-out repository, the operator controls only the exact retained
host with these explicit commands:

```bash
aws sso login --profile sutra-administrator
pnpm cloud:status
pnpm cloud:start
pnpm cloud:stop
```

The control script rejects static AWS credentials, the wrong account, malformed
profile names, unknown actions and unsafe transitional EC2 states. It contains no
timer or scheduled action. Starting EC2 begins instance billing; stopping ends
instance-usage billing after the state transition, while retained EBS and small
registry/object storage remain billable.

ECR stores only a bounded number of tagged releases, and GitHub hosts the build
runner/cache. Normal releases add no S3, CloudFront, load balancer, NAT Gateway,
ECS or RDS resource. The single EC2/EBS host remains the availability and data
failure domain, so this is a production-like private beta rather than an HA SaaS
platform.

## Failure and rollback behavior

The workflow deploys only a full account-local `sutra/app@sha256:...` reference.
`release-update.sh` stages the new host bundle, quiesces writers, snapshots the
bounded application volume, runs additive migrations, waits for health and
automatically restores the prior bundle/image/application state if the release
fails. The workflow then checks `/api/healthz`, `/login` and `/status` through the
real Cloudflare public origin.

If a healthy release has a later functional regression, select one of the three
retained ECR digests and run the existing SSM rollback command documented in
`deploy/ec2/README.md`. An older application image must be compatible with the
current additive PostgreSQL schema; never restore an old customer-data snapshot
just to match an old image.

## Architecture progression

| Stage | Application | Database | Use when | Trade-off |
| --- | --- | --- | --- | --- |
| Current private beta | Docker on one EC2 host | PostgreSQL on the same encrypted EBS host | Demos and a small controlled pilot | Lowest service count and cost, but one host/AZ and maintenance downtime |
| Optional public-site split | Static marketing/status site on Cloudflare Pages or private S3 + CDN; authenticated Sutra remains a container | unchanged | `www` must stay online while the pilot app is stopped | Better SEO/maintenance availability, but two deployables and domains |
| First managed production step | Two ECS/Fargate app tasks across AZs, separate worker service | private RDS PostgreSQL with automated backups; Multi-AZ when SLA requires it | Paying customers require independent scaling, backups and failover | Higher baseline cost and more networking/observability work |
| Mature SaaS | Multi-AZ ECS services with autoscaling and controlled blue/green releases | Multi-AZ RDS/Aurora, tested PITR and DR | Contracted availability, RPO/RTO and larger tenant load | Highest reliability and operating cost |

Do not put PostgreSQL on a second unmanaged EC2 instance merely to separate it:
that doubles host operations and cost while still lacking managed backups and
failover. When the database must leave the application host, move directly to a
private RDS PostgreSQL deployment after measuring the required size and budget.
