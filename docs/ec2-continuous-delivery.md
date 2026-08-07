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
  -> immutable ECR candidate + exact-digest Trivy gate
  -> promote the same OCI manifest to a retained sha-* tag
  -> SSM command to one exact EC2 instance
  -> transactional release-update.sh + automatic failure rollback
  -> public health, login and status checks
```

This removes laptop builds, source copies, SSH and server-side compilation from
normal releases. GitHub Actions uses a branch-scoped build cache; the EC2 host
only pulls the new digest and applies the already-implemented release
transaction.

If GitHub hosted runners are unavailable because the Actions allowance or
billing gate is exhausted, use the fail-closed
[manual exact-digest release path](ci-quota-and-manual-release.md#quota-independent-release-when-actions-is-unavailable).
It mirrors the immutable candidate, exact-digest scan, OCI manifest promotion,
constrained SSM and public-verification boundaries with a short-lived operator
SSO session. It never builds on EC2 and is not a reason to add static AWS keys.

## One-time AWS setup

The account-level GitHub OIDC provider in
`infrastructure/github-oidc-provider.yaml` is shared with the Kubernetes release
workflow and must be created only once. Deploy
`infrastructure/github-ec2-release-role.yaml` as a separate stack, passing:

- the existing OIDC provider ARN;
- existing ECR repository `sutra/app`; and
- the exact instance ID output by `sutra-private-beta`.

The template fixes the OIDC subject to
`repo:ydsveluvolu2996/Sutra:environment:ec2-live-release` and separately
requires the `repository_owner_id` (`229068958`) and `repository_id`
(`1301833628`) claims; none of the three is a deploy-time parameter that can
accidentally broaden the trust policy. The numeric IDs keep the trust boundary
pinned if an owner or repository display name is later reused, and the
environment carries the manual approval gate.

This previously described a single subject of the form
`ydsveluvolu2996@229068958/Sutra@1301833628:ref:refs/heads/main`. No GitHub
token ever carries that value: `sub` contains no numeric ids under any subject
customization, and a job that declares `environment:` is issued the
`...:environment:<name>` form rather than the ref form. The role was
consequently unassumable, which surfaced as
`Not authorized to perform sts:AssumeRoleWithWebIdentity` the first time a
release reached the OIDC step.

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
releasing. Apply the versioned
[`ecr-lifecycle-policy.json`](../deploy/ec2/ecr-lifecycle-policy.json) only after
reviewing an ECR lifecycle preview. Its priority-1 rule retains three validated
`sha-` releases. Its lower-priority rules expire unpromoted `candidate-` images
after one day and abandoned untagged artifacts after fourteen days. ECR's rule
priority protects an image carrying a validated `sha-` tag from the lower
candidate rule even though the immutable candidate tag remains attached.

The workflow first pushes a uniquely tagged candidate, then scans that exact
digest with Trivy. Only a passing digest is promoted: the workflow reads the
candidate's OCI index, verifies its SHA-256 and its linux/amd64 plus attestation
manifests, and attaches a new immutable `sha-` tag with ECR `PutImage`. The
returned and subsequently described digests must both equal the scanned digest
before SSM is allowed to run. This preserves provenance and SBOM evidence while
ensuring failed scans never consume the three-release retention window. It does
not require or silently enable ECR scan-on-push mode, and the GitHub role has no
image-deletion permission.

## One-time GitHub setup

The workflow runs in the `ec2-live-release` deployment environment, which must
exist and must list a required reviewer -- that reviewer's approval is what
holds every release until a human releases it. The workflow additionally uses
ordinary repository Actions variables, rejects every ref except exact `main`,
and runs its own bounded source/release gates. AWS independently rejects every
OIDC subject except `repo:ydsveluvolu2996/Sutra:environment:ec2-live-release`
carrying the immutable owner and repository ids, so a workflow created on
another branch, in a renamed lookalike repository, or outside that environment
cannot assume the release role.

An earlier revision of this document said not to create the environment, on
the grounds that GitHub Free withholds environments from private repositories.
That is no longer the arrangement in use: the environment exists, gates each
run, and is the subject AWS trusts.

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

ECR stores three retained validated releases; failed scan candidates age out
after one day, and GitHub hosts the build runner/cache. Normal releases add no
S3, CloudFront, load balancer, NAT Gateway, ECS or RDS resource. The single
EC2/EBS host remains the availability and data failure domain, so this is a
production-like private beta rather than an HA SaaS platform.

## Failure and rollback behavior

The workflow deploys only a full account-local `sutra/app@sha256:...` reference.
`release-update.sh` stages the new host bundle, quiesces writers, snapshots the
bounded application volume, runs additive migrations, waits for health and
automatically restores the prior bundle/image/application state if the release
fails. The workflow then checks `/api/healthz`, `/login` and `/status` through the
real Cloudflare public origin.

### The edge must not block the release verifier

Those public checks run **from the release host**, so they reach Cloudflare from an
AWS datacenter address with a non-browser client — the exact profile Bot Fight Mode
and the managed WAF rules are built to block. When the edge blocks them the
verification sees `403`, and because the check runs inside the release transaction
it **rolls back a release that had already deployed and gone healthy**. That is a
false negative, not a bad release, and it happened on 2026-07-28.

`release-update.sh` therefore sends a stable identity on every public check:

- `User-Agent: sutra-release-verifier/1 (+deploy/ec2/release-update.sh)`
- `X-Sutra-Release-Verifier: 1`

### Current decision: Bot Fight Mode is OFF, deliberately

**Do not re-enable Bot Fight Mode without reading this.** It is off by choice as of
2026-07-28, and turning it back on will fail the next release at verification with a
`403` — the failure this whole section describes.

The zone is on Cloudflare's **Free** plan, and Free cannot exempt a source IP from
Bot Fight Mode: it is applied independently of custom rules, and there are no managed
rulesets to skip. So on Free the only levers are "Bot Fight Mode off" or "releases
fail".

Off was chosen over the alternatives because it costs nothing and keeps the release
gate whole. The rejected options, for the record:

- **Cloudflare Pro (~$20/month)** would provide WAF custom rules with the Skip
  action, letting Bot Fight Mode stay on with an IP-scoped exemption. This is the
  right answer if the zone is ever upgraded — apply the rule below and re-enable.
- **Verifying through the local Caddy instead of the public origin** was rejected
  because it would silently remove a guarantee: the `security.txt` byte comparison
  below exists specifically to catch *a healthy app behind a stale edge*, and a
  local check structurally cannot see that. Trading a real safety property for a
  bot filter of marginal value is the wrong direction.

What actually protects mutations is Turnstile, the session layer and tenant
isolation — none of which depend on Bot Fight Mode.

### If the zone is ever upgraded to Pro or above

Add one WAF custom rule with action **Skip** (Bot Fight Mode, Super
Bot Fight Mode and the managed rulesets).

**The first such rule must NOT match on User-Agent.** The SSM command runs
`/usr/local/sbin/sutra-release-update`, and the copy at that path is whatever the
last *successful* release (or the original CloudFormation bootstrap) installed. A
release installs the new script at the bundle switch, but the already-executing
process keeps running the old code, and a failed release restores the previous
script from the rollback directory. So a host that has never completed a release
with this change still sends curl's default `curl/8.x`, and a UA-matched rule can
never fire — it would only become correct after the success it is needed to enable.

Start with the source IP and paths only:

```
(ip.src eq <release host egress IP>)
and (http.request.uri.path in {"/api/healthz" "/api/status" "/login" "/api/turnstile/config"})
```

After one release succeeds, `/usr/local/sbin/sutra-release-update` is the new
script and every subsequent verification carries the User-Agent above. At that
point tighten the rule by adding:

```
and (http.user_agent eq "sutra-release-verifier/1 (+deploy/ec2/release-update.sh)")
```

The alternative to the two-step is to install the new script on the host once by
hand, extracting it from the release image the same way the CloudFormation
UserData does (`docker create` the digest, `docker cp` the file, `install -m 0755
… /usr/local/sbin/sutra-release-update`). Either path breaks the deadlock; the
two-step rule needs no host access.

Get the host's egress IP from the host itself:

```bash
curl -s https://checkip.amazonaws.com
```

The rule deliberately requires the source IP as well as the User-Agent, and is
limited to those four public GET paths. A header-token bypass was rejected on
purpose: a token that skips the WAF is a credential to leak and rotate, whereas an
egress IP is not forgeable by a third party and needs nothing kept secret. Re-point
the rule if the host is replaced or its Elastic IP changes — a stale IP in this rule
fails the next release, with the reason named in the error message.

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
