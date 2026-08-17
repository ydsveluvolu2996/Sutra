# AWS static-credential onboarding runbook

This runbook covers Sutra's alternative AWS onboarding method: connecting an
account with a customer-supplied access key ID and secret access key instead of
deploying the customer-owned IAM trust role. It is written for the customer
administrator performing the connection. It contains no account-specific
secrets; replace every `<placeholder>` with your own values at run time.

**The IAM role method remains the recommended default.** It is least-privilege
by construction (every session is intersected with Sutra's fixed read-only STS
session policy), uses auto-rotating temporary credentials, and never leaves a
long-lived customer secret in Sutra's custody. Choose the access-key method
only when your organization cannot deploy the CloudFormation or Terraform role
contract. See `docs/aws-integration.md` §2.4 for the full trust-model
comparison.

## Prerequisites

1. A **dedicated read-only IAM user** created only for this Sutra connection.
   Never submit root credentials, administrator keys, a shared operations
   user's keys, or keys reused by any other tool. Attach only reviewed
   read-only metadata policies (the same read-only intent as the role method's
   permission pack); Sutra cannot narrow static keys with a session policy, so
   the user's own policy is the effective ceiling.
2. One long-lived access key on that user (ID starting `AKIA`). Temporary
   `ASIA` session credentials are not accepted for this persistent connection.
3. An approved Sutra customer-administrator profile with `customer:create` and
   `connection:manage` capabilities, and a live (non-fixture) collector.

## Onboarding flow

1. Open `/onboard` and complete step 1 (Create the connection contract):
   customer workspace, 12-digit AWS account ID, partition, and Region
   coverage. Set **Connection method** to **Access keys**. The
   role-provisioning fields disappear; no CloudFormation handoff, ExternalId,
   or template download is involved.
2. Submit the form. Sutra creates the pending connection contract. No
   credentials accompany this create call and no browser draft stores them.
3. In step 2 (Enter and register the customer access keys), enter:
   - **Access key ID** — must match `AKIA` followed by exactly 16 uppercase
     letters or digits.
   - **Secret access key** — exactly 40 characters.
   All inputs are masked (password fields) with browser autofill disabled, and
   the form clears itself on every submit, success or failure.
4. Submit. The browser posts the keys once to
   `POST /api/pilot/connections/credentials`. The collector calls
   `sts:GetCallerIdentity`, requires the returned account to equal the
   onboarding account and the principal to be a dedicated IAM user, then
   promotes the exact staged AWS Secrets Manager version and queues the first
   collection job. The UI then shows the connection as validating/active with
   `Access key ····<last4>` — the only fragment ever displayed again.
5. Step 3/4 behave as in the role flow: validate the account binding, run the
   first inventory sync, and review the published CMDB snapshot.

If the browser loses the create response, simply reload `/onboard`: the pending
connection reappears and the credentials step is still available. There is no
ExternalId handoff to recover with this method.

## Security properties

- Keys are sent once over the authenticated onboarding session and written to
  a per-connection, versioned **AWS Secrets Manager** secret. The submitted
  value is `SUTRAPENDING` until identity verification succeeds; only then does
  the collector move `AWSCURRENT`. PostgreSQL and the encrypted collector
  registry retain only the full secret ARN, exact VersionId and access-key
  last four. Values are never logged, put in browser persistence, echoed by an
  API, or rendered after submit.
- **Account binding is proven on every session**: `GetCallerIdentity` must
  resolve the stored keys to the registered account before any collection
  starts; a mismatch fails closed.
- The collector retrieves both the exact VersionId and the required
  `AWSCURRENT`/`SUTRAPENDING` stage immediately before use. Older,
  `AWSPREVIOUS`, unlabeled, missing, malformed, cross-tenant, or wrong-account
  values fail closed.
- Sutra uses these credentials only for metadata collection, but unlike the
  role method it cannot impose an STS session-policy ceiling. The customer IAM
  user policy is the effective permission boundary.

## Limitations

- **No STS session policy ceiling.** Unlike AssumeRole sessions, static keys
  cannot be intersected with Sutra's fixed read-only session policy. The IAM
  user's own policies are the effective permission ceiling — keep them
  read-only and dedicated.
- **No trust-policy attestation.** There is no ExternalId condition,
  session-name binding, or trust/permission drift attestation. Account binding
  via GetCallerIdentity is the only server-side identity proof.
- **Customer-owned rotation.** Sutra cannot rotate customer access keys.
- **FinOps per-source verticals currently require the role method.** The
  FinOps CID dashboards attest per-source role policies and are not available
  to access-key connections.
- Temporary `ASIA` session credentials are rejected because their expiry
  cannot form a durable customer connection.

## Rotation

1. Create a **new** access key on the same dedicated IAM user (an IAM user can
   hold two keys at once).
2. Re-submit the new AKIA key ID and secret
   through the same step-2 form (**Verify & rotate access keys**). Sutra
   stages a new Secrets Manager version and verifies it without replacing the
   working `AWSCURRENT` version. Only a successful proof promotes the new
   version; a failed proof discards only the candidate.
3. After the next successful validation or sync, **deactivate, then delete**
   the old key in the AWS IAM console.

Rotate long-lived keys on your organization's schedule (90 days or less is a
common baseline) and immediately after any suspected exposure.

## Offboarding

1. In `/onboard`, use **Offboard access keys** under Trust lifecycle. Confirm
   with the AWS account ID and a fresh authenticator code.
2. Sutra removes its control-plane reference and asks the collector to schedule
   the exact Secrets Manager secret for deletion with a seven-day recovery
   window; it is blocked from live use immediately. CMDB snapshots and audit
   history remain. If the collector is temporarily offline, restore it and use
   the reconcile action to finish the idempotent cleanup.
3. Sutra cannot deactivate the keys in AWS. **Deactivate and delete the access
   key, and delete the dedicated IAM user**, in the AWS IAM console.
4. Confirm in AWS CloudTrail that no further Sutra activity occurs from that
   key after offboarding.
