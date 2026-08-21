# AWS onboarding and administration

## Trial and first-run journey

**Documented:** the CloudAware start flow allows Google sign-in or work-email registration, asks for trial goals and profile details, then leads to Connect infrastructure. A cloud provider is selected before its onboarding workflow. Registration is completed only after the cloud account validates.

## Signed-in AWS account form

**Observed:** `Admin → Amazon Web Services → Add AWS Account` showed:

1. Account Name.
2. Authentication Type:
   - IAM Role, selected and marked Recommended.
   - Access & Secret Keys.
3. For IAM Role:
   - Partition.
   - Trusted Account.
   - generated External ID with copy/regenerate controls.
   - IAM Role creation tabs: Quick launch and Manual creation.
   - Role ARN.
   - Check and go back actions.
4. For Access & Secret Keys:
   - Access Key.
   - Secret Key.
   - downloadable CloudAware IAM policies.
   - Check and go back actions.

**Observed:** Quick launch links to AWS CloudFormation with a pre-generated template URL. Manual creation downloads a template to upload in AWS. No credentials or account values were entered during this research.

## Recommended IAM-role sequence

**Documented:** the preferred flow is:

1. Name the AWS account and select its partition.
2. Generate a unique External ID.
3. Launch the provided CloudFormation stack or download/upload the template manually.
4. Acknowledge IAM resource creation and deploy the stack.
5. Copy the resulting IAM Role ARN.
6. Return to CloudAware, paste the ARN, and run Check.
7. Save only after validation succeeds.
8. Wait for the next discovery cycle and verify a healthy connection and populated CMDB.

CloudAware recommends cross-account roles because they reduce long-lived credential exposure and ease rotation. Its baseline collector policy is designed around read access. Optional tagging, backup, monitoring, billing, EKS, CloudTrail, and automation features require separately scoped permissions.

## Access-key fallback

**Documented:** access keys are an optional legacy/fallback path. It requires a dedicated IAM user, collector policies, securely handled access/secret keys, validation, and save. Broad administrator policies are discouraged.

**Sutra decision:** Sutra should retain IAM Role as the default and recommended choice. Access-key onboarding must stay feature-gated behind the reviewed Secrets Manager lifecycle and collector boundary. It must never be enabled merely for visual parity.

## AWS Organizations onboarding

**Documented:** CloudAware supports organization-level rollout after the management account is onboarded by role:

1. Deploy the same role with CloudFormation StackSets using service-managed permissions.
2. Target the whole organization or selected OUs.
3. Configure automatic deployment and account-removal behavior.
4. Add the organization in CloudAware with name, partition, IAM role name, External ID, and management account.
5. Run Check, save, and discover member accounts over time.

**Sutra source:** current onboarding remains single-account for general inventory and marks organization-wide scanning unavailable. Adding true Organizations onboarding is a major product epic, not a form-only change.

## API credentials and subscriptions

**Observed:** Admin → API Credentials separates:

- OAuth tokens for external API access, issued for a specific user and valid until revoked;
- MCP API keys, displayed once at creation and carrying an expiration date.

The token tables expose created time, last used time, use count, name, expiration, and revocation controls. No token or key was created.

**Observed:** Subscriptions is provider-tabbed (AWS, Azure, Google). The AWS view shows active subscription codes and an Add Subscription Code control. No subscription was added.

## Production-grade Sutra acceptance

Every onboarding method should prove:

- server-derived organization, customer, account, and connection scope;
- exact AWS partition/account validation;
- correct, missing, and wrong External ID behavior;
- least-privilege and permission-pack provenance;
- no secrets in browser persistence, logs, app database, audit metadata, or responses;
- idempotent retry, interrupted validation recovery, rotation, disable, and offboard;
- immutable connection health and collection evidence;
- two-tenant negative tests and real disposable-account acceptance.
