# Sutra single-node EC2 private beta

This directory implements a cost-bounded, single-node deployment of Sutra on
Ubuntu 24.04 in `ap-south-1`.

```text
Browser/API
  -> Cloudflare Worker (maintenance fallback)
  -> Cloudflare named Tunnel (outbound connector)
  -> Caddy :8080 (private Compose network)
  -> Sutra app :3000
  -> PostgreSQL :5432 (internal Compose network)
```

No Compose service publishes a host port. The EC2 security group has no inbound
rules, no SSH rule, and no Elastic IP. SSM is the administration path.

## Files

| File | Purpose |
| --- | --- |
| `cloudformation-single-node.yaml` | `t3a.large`, 15 GiB encrypted gp3, IAM/SSM, no inbound, stop controls |
| `compose.prod.yaml` | Digest-pinned application, PostgreSQL, Caddy and cloudflared runtime |
| `bootstrap.sh` | Idempotent install, secret generation, immutable pulls and first launch |
| `redeploy.sh` | Reapply the already-selected digest, migrate and health-check; no build |
| `release-update.sh` | Stage a new immutable ECR digest, validate, deploy and roll back on failure |
| `Caddyfile` | Private HTTP origin, canonical public Host boundary and app-down `503` |
| `cloudflared-config.yml.example` | Named-tunnel ingress contract; copied to ignored `.sutra/` storage |
| `sutra.service` | Boot start; app-only stop for maintenance |
| `verify-runtime.sh` | Compose, networks, pinned images, Caddy and maintenance contracts |
| `validate-ops.sh` | CloudFormation and backup/restore static checks; optional AWS validation |
| `backup-prod.sh`, `restore-prod.sh` | Optional encrypted coordinated backup/restore; disabled by default |
| `sutra-backup.*` | Optional backup unit/timer; do not enable until configured and drilled |

## Fixed pilot defaults

| Setting | Value |
| --- | --- |
| Region | `ap-south-1` |
| Instance | `t3a.large` (2 vCPU, 8 GiB), standard CPU credits |
| Root disk | 15 GiB encrypted gp3, retained on stack deletion |
| Runtime limit | 6 hours after every boot |
| Daily stop | 23:30 `Asia/Kolkata` through EventBridge Scheduler |
| Public origin | `https://www.sutracmdb.com` through Cloudflare only |
| Edge Worker | `sutra-edge-fallback`; apex and `www` routes |
| AWS Budget | `SutraPrivateBeta-20USD`; $20 gross, credits excluded; not a hard cap |

The host receives an ephemeral public IPv4 only for outbound internet access.
There is no inbound route to it. This avoids the much larger fixed cost of a NAT
Gateway; the public IPv4 is released when the instance stops. EBS and ECR
storage continue to accrue small charges while stopped.

## Release and bootstrap sequence

Run these commands from the repository root on the operator workstation. They
are intentionally explicit so a future operator does not build on the 15 GiB
host.

```bash
export AWS_PROFILE=sutra-administrator AWS_REGION=ap-south-1 AWS_DEFAULT_REGION=ap-south-1
export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
test "$ACCOUNT_ID" = 738663485493
export ECR_REPOSITORY=sutra/app
export ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
export RELEASE_TAG="$(git rev-parse --short=12 HEAD)"

aws ecr describe-repositories --repository-names "$ECR_REPOSITORY" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "$ECR_REPOSITORY" \
    --image-tag-mutability IMMUTABLE \
    --image-scanning-configuration scanOnPush=false \
    --encryption-configuration encryptionType=AES256 >/dev/null
aws ecr put-lifecycle-policy --repository-name "$ECR_REPOSITORY" \
  --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"Keep three immutable private-beta releases","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":3},"action":{"type":"expire"}}]}' >/dev/null
aws ecr get-login-password | docker login --username AWS --password-stdin "$ECR_REGISTRY"
docker buildx build --platform linux/amd64 \
  -t "$ECR_REGISTRY/$ECR_REPOSITORY:$RELEASE_TAG" --push .
export IMAGE_DIGEST="$(aws ecr describe-images --repository-name "$ECR_REPOSITORY" \
  --image-ids imageTag="$RELEASE_TAG" \
  --query 'imageDetails[0].imageDigest' --output text)"
export SUTRA_APP_IMAGE="$ECR_REGISTRY/$ECR_REPOSITORY@$IMAGE_DIGEST"
```

The named Tunnel is `sutra-prod`, UUID
`c0766d48-bf0b-45d3-8a69-ffa167139e3d`. Its credential must already exist at
the encrypted SSM parameter
`/sutra/production/cloudflare-tunnel-credentials`; see
[`../cloudflare/README.md`](../cloudflare/README.md). Deploy the host:

```bash
export STACK_NAME=sutra-private-beta
export VPC_ID=vpc-55f7053e
export PUBLIC_SUBNET_ID=subnet-d74e55bf

aws cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file deploy/ec2/cloudformation-single-node.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId="$VPC_ID" PublicSubnetId="$PUBLIC_SUBNET_ID" \
    InstanceType=t3a.large RootVolumeGiB=15 MaximumRuntimeHours=6 \
    EnableDailyAutoStop=true 'DailyStopSchedule=cron(30 23 * * ? *)' \
    DailyStopTimezone=Asia/Kolkata \
    SutraAppImage="$SUTRA_APP_IMAGE" \
    SutraDomain=sutracmdb.com \
    CloudflareTunnelCredentialsParameterName=/sutra/production/cloudflare-tunnel-credentials
```

CloudFormation user data installs the runtime, pulls the approved image by
digest, extracts only its host deployment bundle, materializes the tunnel
credential from SSM, runs `bootstrap.sh`, and enables `sutra.service` plus the
six-hour runtime timer. It never clones GitHub and does not enable the optional
backup timer.

## Direct bootstrap and future deploys

CloudFormation normally performs bootstrap. For a repaired/replacement host
where `/opt/sutra` and the ignored tunnel credential files already exist:

```bash
cd /opt/sutra
sudo bash deploy/ec2/bootstrap.sh
```

`bootstrap.sh`:

1. installs Docker Engine/Compose if needed;
2. preserves or creates 256-bit database/job secrets in `.sutra/docker.env`;
3. requires an ECR image digest in ignored `deploy/ec2/.env.ec2`;
4. validates `.sutra/cloudflared/config.yml` and `credentials.json`;
5. authenticates to the scoped ECR registry;
6. pulls and starts the stack with `--no-build`.

For a normal future release, first publish the new image digest off-host, then
select it through SSM:

```bash
export NEW_SUTRA_APP_IMAGE='738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/app@sha256:<64-hex-digest>'
sudo /usr/local/sbin/sutra-release-update "$NEW_SUTRA_APP_IMAGE"
```

`release-update.sh` extracts and validates the new bundle, preserves operator
settings, runs migrations, waits for service health, and rolls back the bundle
and selected image on failure. Named PostgreSQL and application volumes remain
untouched. Mutable tags, GitHub tokens and host builds are deliberately
unsupported.

## Start, stop, and maintenance behavior

From the operator workstation:

```bash
INSTANCE_ID="$(aws cloudformation describe-stacks --stack-name sutra-private-beta \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' --output text)"
aws ec2 start-instances --instance-ids "$INSTANCE_ID"
aws ec2 stop-instances --instance-ids "$INSTANCE_ID"
aws ssm start-session --target "$INSTANCE_ID"
```

Inside SSM:

```bash
sudo systemctl start sutra    # starts/health-checks the whole Compose stack
sudo systemctl stop sutra     # stops only app; origin Caddy serves 503
sudo systemctl status sutra
```

When the entire EC2 instance is stopped, Caddy and cloudflared cannot answer.
The Cloudflare Worker remains running independently and converts the failed
origin request into the branded maintenance page, with `503`, `Retry-After`, and
`no-store`. Machine/API endpoints receive RFC problem JSON. It does not serve or
cache customer data. This behavior depends on all three DNS records remaining
proxied and both Worker routes remaining active.

The six-hour timer stops the host after every boot. The 23:30 IST Scheduler is a
second guardrail if the machine was started later. Neither deletes the EBS disk.

## Runtime verification

Before deployment:

```bash
node --test deploy/cloudflare/edge-fallback.test.mjs
bash deploy/ec2/validate-ops.sh
bash deploy/ec2/verify-runtime.sh
AWS_PROFILE=sutra-administrator AWS_REGION=ap-south-1 \
  bash deploy/ec2/validate-ops.sh --online
```

After deployment, in SSM:

```bash
sudo cloud-init status --wait
sudo systemctl is-active sutra.service sutra-max-runtime.timer
sudo systemctl list-timers sutra-max-runtime.timer
cd /opt/sutra
CE='sudo docker compose -f deploy/ec2/compose.prod.yaml --env-file deploy/ec2/.env.ec2 --env-file .sutra/docker.env'
$CE ps
$CE logs --since 15m app cloudflared
$CE exec -T app node -e "fetch('http://127.0.0.1:3000/api/healthz').then(r=>{console.log(r.status);process.exit(r.ok?0:1)})"
df -h /
```

From the workstation:

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' https://www.sutracmdb.com/login
curl -fsS -o /dev/null -w '%{http_code}\n' https://www.sutracmdb.com/api/healthz
curl -sSI https://sutracmdb.com/ | sed -n '1,6p'
```

Perform two controlled outage tests: first `systemctl stop sutra`, then a full
EC2 stop. `www` must show the branded 503 in both cases. Start the instance and
confirm login, health, API responses, and `Set-Cookie` work again.

## Cookies and application boundary

Cloudflare terminates browser TLS. The Tunnel-to-Caddy hop is private HTTP, and
Caddy supplies `X-Forwarded-Proto: https`, so the app sets `sutra_session` as
`HttpOnly; Secure; SameSite=Strict` with a 12-hour maximum age. The Worker passes
healthy responses and `Set-Cookie` unchanged. It neither reads nor persists
application sessions. The marketing consent preference lasts one year and no
third-party tracker is loaded today.

The app runs an explicit staging-only password identity boundary with mandatory
MFA and the canonical `https://www.sutracmdb.com` origin. Caddy never disguises
public traffic as loopback. Tenant SQL scoping, lockout, rate limiting and
application security headers remain active. This is a private-beta self-hosted
boundary, not the final hosted OIDC or enterprise SSO release; the separate
production password-identity gate remains disabled. Search indexing remains
disabled.

## Database, disk, and optional backups

PostgreSQL data is in the `sutra-prod_sutra_postgres_data` Docker volume on the
encrypted root EBS volume. The volume survives restarts and Compose redeploys;
CloudFormation sets the EBS disk to survive accidental stack deletion. Neither
feature is an independent backup.

Stack deletion therefore does **not** end every charge: the detached EBS volume
continues billing. Before deleting it, identify it from the former instance,
take a snapshot if required, and verify that the database plus `.sutra` secret
material is recoverable. Deleting the retained volume is irreversible.

The encrypted `backup-prod.sh`, guarded `restore-prod.sh`, systemd service, and
timer are provided but **disabled**. Do not enable them on the 15 GiB host until
all of the following are ready: an age public recipient whose private identity
is off-host, a reviewed offsite target, sufficient free space, retention, IAM,
cost review, a restore drill, and monitoring. No S3 bucket is created by the
minimal stack.

Monitor the constrained disk:

```bash
df -h /
sudo docker system df
sudo journalctl --disk-usage
```

Only after a successful redeploy may an operator remove unused image layers;
never prune volumes:

```bash
sudo docker image prune -f
```

## Cost and security exclusions

The minimal stack intentionally excludes NAT Gateway, Elastic IP, ALB, RDS,
S3, custom CloudWatch log groups/alarms, paid Inspector/Security Hub/GuardDuty,
and the optional notification worker. AWS Budgets provides a $20 gross warning,
not enforcement. Promotional credits may offset eligible charges but must not
be treated as a spending control.

The security group has no inbound rules. Do not add `22`, `80`, `443`, app, or
database ports. Keep IMDSv2 required, EBS encryption enabled, standard CPU
credits selected, Cloudflare DNS proxied, tunnel credentials encrypted in SSM,
runtime environment secrets ignored with mode `0600`, and tunnel files owned by
the pinned cloudflared UID with read-only mode `0400`.

## Private-beta limitations

This design has a single compute node and a same-host database. It has no HA,
multi-AZ database, automatic failover, guaranteed RPO/RTO, SLA, penetration-test
attestation, or final hosted identity boundary. The 15 GiB disk is deliberately
small and needs monitoring. Treat this as a controlled private beta/demo; move
database, backups, telemetry, and identity to managed/HA services before a
production customer SLA.
