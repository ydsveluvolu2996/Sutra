# Sutra — minimal EC2 private-beta deployment

This is the operator runbook for Sutra's current low-cost hosted pilot. It uses
one `t3a.large` in `ap-south-1`, a 15 GiB encrypted gp3 root volume, Docker
Compose, PostgreSQL on the same host, a named Cloudflare Tunnel, and a
Cloudflare Worker maintenance fallback. The EC2 security group has **no inbound
rules**; there is no Elastic IP, SSH, ALB, NAT Gateway, RDS, or public Docker
port. Administration is through AWS Systems Manager Session Manager.

The deeper design and recovery notes are in
[`deploy/ec2/README.md`](deploy/ec2/README.md). The edge Worker is documented in
[`deploy/cloudflare/README.md`](deploy/cloudflare/README.md).

## 1. Deployed shape and cost guardrails

| Component | Current setting |
| --- | --- |
| Region / compute | `ap-south-1`, `t3a.large`, standard CPU credits |
| Disk | 15 GiB encrypted gp3; retained if the CloudFormation stack is deleted |
| Ingress | Outbound-only Cloudflare named Tunnel; no public inbound or SSH |
| Edge fallback | Worker `sutra-edge-fallback` on the apex and `www` routes |
| Administration | SSM Session Manager |
| Application release | Immutable `sutra/app@sha256:…` digest from private ECR |
| Database | PostgreSQL container on the same encrypted EC2 disk |
| Start / stop | Starts with EC2; stops at 6 hours after each boot and again at 23:30 IST |
| Cost warning | AWS Budget alerts against **gross** monthly cost at a $20 budget |
| Backups / notifications | Implemented but disabled until explicitly configured |

The $20 AWS Budget is an alert, not a hard spending cap. The two stop controls
are the compute guardrails. EBS and small ECR storage remain billable while EC2
is stopped, and promotional-credit eligibility is determined by the credit's
AWS terms. Do not enable paid native security services, NAT Gateway, RDS, load
balancers, paid Cloudflare features, offsite S3 backup, or the notification
worker for this pilot without a separate cost review.

## 2. One-time prerequisites

From an administrator workstation with AWS CLI, Docker Buildx, Node.js,
`cloudflared`, Wrangler, and `jq`:

```bash
export AWS_PROFILE=sutra-administrator
export AWS_REGION=ap-south-1
export AWS_DEFAULT_REGION=ap-south-1
export STACK_NAME=sutra-private-beta
export DOMAIN=sutracmdb.com
export TUNNEL_NAME=sutra-prod
export TUNNEL_ID=c0766d48-bf0b-45d3-8a69-ffa167139e3d
export TUNNEL_PARAMETER=/sutra/production/cloudflare-tunnel-credentials

export ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
test "$ACCOUNT_ID" = 738663485493
```

Never put an AWS key, Cloudflare token, tunnel credential, application secret,
password, MFA code, or bootstrap token in Git, a command argument visible to
another user, or a support transcript.

### 2.1 Build once off-host and publish an immutable ECR release

The 15 GiB EC2 host never compiles the application. Build on the workstation,
push to ECR, then deploy the digest:

```bash
export ECR_REPOSITORY=sutra/app
export ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
export RELEASE_TAG="$(git rev-parse --short=12 HEAD)"

aws ecr describe-repositories --repository-names "$ECR_REPOSITORY" >/dev/null 2>&1 || \
  aws ecr create-repository \
    --repository-name "$ECR_REPOSITORY" \
    --image-scanning-configuration scanOnPush=false \
    --image-tag-mutability IMMUTABLE \
    --encryption-configuration encryptionType=AES256 >/dev/null
aws ecr put-lifecycle-policy --repository-name "$ECR_REPOSITORY" \
  --lifecycle-policy-text '{"rules":[{"rulePriority":1,"description":"Keep three immutable private-beta releases","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":3},"action":{"type":"expire"}}]}' >/dev/null
aws ecr get-login-password | \
  docker login --username AWS --password-stdin "$ECR_REGISTRY"
docker buildx build --platform linux/amd64 \
  --tag "$ECR_REGISTRY/$ECR_REPOSITORY:$RELEASE_TAG" --push .

export IMAGE_DIGEST="$(aws ecr describe-images \
  --repository-name "$ECR_REPOSITORY" \
  --image-ids imageTag="$RELEASE_TAG" \
  --query 'imageDetails[0].imageDigest' --output text)"
export SUTRA_APP_IMAGE="$ECR_REGISTRY/$ECR_REPOSITORY@$IMAGE_DIGEST"
printf 'Release: %s\n' "$SUTRA_APP_IMAGE"
```

The value must contain `@sha256:`. A mutable tag is rejected by the
CloudFormation template and bootstrap script.

### 2.2 Create the named Tunnel and Worker edge

Authenticate interactively to the correct Cloudflare account, then create or
select the named tunnel. The credential file is secret; the tunnel UUID is not.

```bash
cloudflared tunnel login
cloudflared tunnel list --name "$TUNNEL_NAME"

cloudflared tunnel route dns "$TUNNEL_ID" origin."$DOMAIN"
cloudflared tunnel route dns "$TUNNEL_ID" www."$DOMAIN"
cloudflared tunnel route dns "$TUNNEL_ID" "$DOMAIN"
```

The deployed named tunnel is `sutra-prod` (`c0766d48-bf0b-45d3-8a69-ffa167139e3d`).
All three records must be proxied CNAMEs to
`$TUNNEL_ID.cfargotunnel.com`. Never create an A record to the EC2 address.
Ensure `deploy/ec2/cloudflared-config.yml.example` uses this tunnel UUID before
creating the release commit.

Store the credential as an encrypted SSM parameter without printing it:

```bash
aws ssm put-parameter \
  --name "$TUNNEL_PARAMETER" \
  --type SecureString \
  --value "$(jq -c . "$HOME/.cloudflared/$TUNNEL_ID.json")" \
  --overwrite >/dev/null
```

Before deploying the Worker, create the Free-plan WAF custom rule documented in
[`deploy/cloudflare/README.md`](deploy/cloudflare/README.md). It blocks direct
requests to `origin.sutracmdb.com` while allowing only an internal subrequest
from this zone's Worker:

```text
(http.host eq "origin.sutracmdb.com" and cf.worker.upstream_zone ne "sutracmdb.com")
```

Deploy the tested Worker routes for the apex and `www` hostnames:

```bash
cp deploy/cloudflare/wrangler.example.toml deploy/cloudflare/wrangler.toml
(cd deploy/cloudflare && npx wrangler deploy --config wrangler.toml)
```

`wrangler.toml` and tunnel credentials stay uncommitted. The Worker forwards
healthy responses unchanged and returns a branded `503` (or RFC problem JSON
for APIs) when the EC2 origin is stopped or unreachable.

### 2.3 Create the $20 gross-cost alerts

Set a real operator email. These notifications do not stop resources:

```bash
export BUDGET_EMAIL='<operator-email>'
aws budgets create-budget --account-id "$ACCOUNT_ID" \
  --budget '{"BudgetName":"SutraPrivateBeta-20USD","BudgetLimit":{"Amount":"20","Unit":"USD"},"TimeUnit":"MONTHLY","BudgetType":"COST","CostTypes":{"IncludeTax":true,"IncludeSubscription":true,"UseBlended":false,"IncludeRefund":false,"IncludeCredit":false,"IncludeUpfront":true,"IncludeRecurring":true,"IncludeOtherSubscription":true,"IncludeSupport":true,"IncludeDiscount":true,"UseAmortized":false}}' \
  --notifications-with-subscribers "[{\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":50,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$BUDGET_EMAIL\"}]},{\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":75,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$BUDGET_EMAIL\"}]},{\"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$BUDGET_EMAIL\"}]},{\"Notification\":{\"NotificationType\":\"FORECASTED\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"$BUDGET_EMAIL\"}]}]"
```

If the named budget already exists, inspect it rather than creating a second:

```bash
aws budgets describe-budget --account-id "$ACCOUNT_ID" \
  --budget-name SutraPrivateBeta-20USD
```

## 3. Validate, deploy, and observe bootstrap

Validate before touching AWS:

```bash
node --test deploy/cloudflare/edge-fallback.test.mjs
bash deploy/ec2/validate-ops.sh
bash deploy/ec2/verify-runtime.sh
AWS_PROFILE="$AWS_PROFILE" AWS_REGION="$AWS_REGION" \
  bash deploy/ec2/validate-ops.sh --online
```

Select an existing VPC and public subnet with internet egress. The instance has
an ephemeral public IPv4 for outbound package/ECR/Tunnel access, but no inbound
security-group rules and no Elastic IP:

```bash
export VPC_ID=vpc-55f7053e
export PUBLIC_SUBNET_ID=subnet-d74e55bf

aws cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file deploy/ec2/cloudformation-single-node.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId="$VPC_ID" \
    PublicSubnetId="$PUBLIC_SUBNET_ID" \
    InstanceType=t3a.large \
    RootVolumeGiB=15 \
    MaximumRuntimeHours=6 \
    EnableDailyAutoStop=true \
    'DailyStopSchedule=cron(30 23 * * ? *)' \
    DailyStopTimezone=Asia/Kolkata \
    SutraAppImage="$SUTRA_APP_IMAGE" \
    SutraDomain="$DOMAIN" \
    CloudflareTunnelCredentialsParameterName="$TUNNEL_PARAMETER"

export INSTANCE_ID="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text)"
export COLLECTOR_PRINCIPAL_ARN="$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`CollectorPrincipalArn`].OutputValue' \
  --output text)"
aws ssm start-session --target "$INSTANCE_ID"
```

Each customer role must trust the exact `COLLECTOR_PRINCIPAL_ARN` and retain its
server-generated External ID condition. For the management account's existing
CloudFormation-managed onboarding role, update only the vendor principal and
reuse every other parameter; never paste or replace the External ID:

```bash
aws cloudformation update-stack \
  --region us-east-1 \
  --stack-name sutra-customer-role-738663485493 \
  --use-previous-template \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=RoleName,UsePreviousValue=true \
    ParameterKey=VendorCollectorRoleArn,ParameterValue="$COLLECTOR_PRINCIPAL_ARN" \
    ParameterKey=CustomerTenantId,UsePreviousValue=true \
    ParameterKey=ExternalId,UsePreviousValue=true \
    ParameterKey=PermissionsBoundaryArn,UsePreviousValue=true \
    ParameterKey=SessionNamePrefix,UsePreviousValue=true
aws cloudformation wait stack-update-complete \
  --region us-east-1 --stack-name sutra-customer-role-738663485493
```

In the SSM session:

```bash
sudo cloud-init status --wait
sudo systemctl is-enabled sutra.service sutra-max-runtime.timer
sudo systemctl is-active sutra.service sutra-max-runtime.timer
sudo journalctl -u sutra.service --no-pager -n 100
cd /opt/sutra
CE='sudo docker compose -f deploy/ec2/compose.prod.yaml --env-file deploy/ec2/.env.ec2 --env-file .sutra/docker.env'
$CE ps
$CE exec -T app node -e "fetch('http://127.0.0.1:3000/api/healthz').then(r=>{console.log(r.status);process.exit(r.ok?0:1)})"
df -h /
```

From the workstation:

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' https://www.sutracmdb.com/login
curl -fsS -o /dev/null -w '%{http_code}\n' https://www.sutracmdb.com/api/healthz
curl -sSI https://sutracmdb.com/ | sed -n '1,6p'
```

## 4. Operator setup and cookies

The agent may prepare the deployment and display the one-time bootstrap token,
but a human must enter the token, password, and TOTP code in the browser:

```bash
$CE exec -T app node scripts/show-local-bootstrap-token.mjs
```

Open `https://www.sutracmdb.com/login`, bootstrap the owner, and enroll MFA.
Sutra's authentication cookie is `HttpOnly`, `Secure`, `SameSite=Strict`, and
expires after 12 hours. Cloudflare Worker passes healthy `Set-Cookie` headers
unchanged and does not store application sessions. The public cookie-consent
choice lasts one year; no third-party tracker is currently loaded. Do not copy
session cookies between users or expose them to support tooling.

## 5. Start, stop, maintenance, and redeploy

```bash
# Start or stop the EC2 compute from the workstation.
aws ec2 start-instances --instance-ids "$INSTANCE_ID"
aws ec2 stop-instances --instance-ids "$INSTANCE_ID"

# App-only maintenance while EC2 remains running (inside SSM).
sudo systemctl stop sutra
sudo systemctl start sutra

# Future release after publishing a new immutable ECR digest.
export NEW_SUTRA_APP_IMAGE='738663485493.dkr.ecr.ap-south-1.amazonaws.com/sutra/app@sha256:<64-hex-digest>'
aws ssm send-command --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters "commands=['sudo /usr/local/sbin/sutra-release-update $NEW_SUTRA_APP_IMAGE']"
```

`systemctl stop sutra` stops only the app; Caddy and the Tunnel stay up. A full
EC2 stop disconnects the Tunnel. In both cases the Cloudflare Worker remains at
the edge and returns the maintenance page. Starting EC2 causes cloud-init/
systemd and Docker restart policies to restore the stack; allow several minutes
before testing.

For each future release: test locally, build and push on the workstation, obtain
the new ECR digest, then select it through `sutra-release-update` over SSM. That
command stages and validates the host bundle, runs migrations, waits for health,
and restores the prior release if deployment fails. Never build on the 15 GiB
host and never deploy a mutable tag.

## 6. Honest private-beta boundary

This is suitable for a controlled private beta and customer demo, not an
SLA-backed production SaaS. It has one EC2 host and one database disk, so there
is no high availability, automatic failover, managed database, multi-AZ
durability, penetration-test attestation, or guaranteed recovery time. Hosted
OIDC/enterprise SSO and the full hosted multi-tenant release boundary remain
release work. This deployment uses an explicit staging-only password identity
boundary with mandatory MFA, a canonical public origin, and search indexing
disabled. The separate production password-identity release gate remains off.

Encrypted backup and restore scripts exist, but their timer is **not enabled**
and no S3 bucket is created. Configure an age recipient, reviewed offsite target,
restore drill, retention, and associated cost before enabling them. Until then,
the retained EBS volume is persistence, not a backup. A 15 GiB root disk also
needs active free-space monitoring and is a temporary pilot constraint.

CloudFormation intentionally retains the root EBS volume if the stack is
deleted. That protects against accidental data loss, but the detached disk keeps
billing until an operator explicitly snapshots (if required) and deletes it.
Never delete that retained volume until the database and ignored secret files
have been recovered or the data has been deliberately abandoned.
