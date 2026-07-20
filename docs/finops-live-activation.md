# Sutra FinOps live activation readiness

Sutra never substitutes sample spend for AWS billing evidence. The Cost workspace remains in an explicit unavailable state until the customer account can return Cost Explorer data through its trusted role.

## Upgrade the already-onboarded account

1. In the AWS billing or payer/management account, open **Billing and Cost Management → Cost Explorer** and choose **Launch Cost Explorer** if AWS shows the activation page. This is an AWS account setting; Sutra does not enable it automatically.
2. In **CloudFormation → Stacks**, open the stack that created `SutraReadOnlyRole`.
3. Choose **Update → Replace current template → Upload a template file**.
4. Upload the checked-in `public/sutra-customer-onboarding-role.yaml` file from this repository.
5. Keep the existing `VendorCollectorRoleArn`, `ExternalId`, `CustomerTenantId`, and optional boundary parameters unchanged. Review and submit the change set.
6. Confirm the updated inline policy contains `ce:GetCostAndUsage` and `ce:GetCostForecast` together with the current permission-pack `.2` metadata reads documented in `operations-wave-live-activation.md`. No billing writes, purchases, commitments, data-plane reads, or resource mutations are granted.
7. Return to **Sutra → Costs** and choose **Refresh from AWS**.

If Cost Explorer was only just activated, AWS may not have billing history ready immediately. Sutra will persist `BILLING_DATA_UNAVAILABLE` and can be retried later without re-onboarding or sharing credentials.

## Cost states

- **Complete:** service/account breakdown and AWS forecast succeeded.
- **Partial:** core AWS spend succeeded, but account breakdown or AWS forecast was unavailable. A labelled linear projection may be shown.
- **Unavailable:** Cost Explorer access, activation, partition support, or billing data is missing. Sutra shows no monetary values as facts.

Every successful or unavailable attempt is stored as an immutable tenant-scoped cost snapshot with a SHA-256 digest and an audit event.
