# Enterprise activation readiness

Sutra exposes an authenticated, connection-scoped activation assessment at:

```text
GET /api/v1/enterprise/readiness?connectionId=<connection-id>
```

The same assessment is rendered in **Settings → Enterprise activation
readiness**. It distinguishes production evidence from implemented code across:

- CUR/FOCUS ingestion, Cost Explorer collection, and forecasting;
- immutable compliance evidence and MFA-verified report sign-off;
- notification-worker and destination delivery health;
- Jira/ServiceNow credential posture plus connector-specific, current-version
  outbound and authenticated-inbound delivery evidence;
- vulnerability intelligence population and freshness; and
- recorded platform health probes.

`ready` is intentionally strict. Empty routes, dormant workers, missing provider
credentials, stale evidence, and absent probes never count as a pass.

## Operator dependencies

These dependencies cannot be completed by application code:

1. Enable AWS Cost Explorer and grant the documented read-only Cost Explorer
   permission set in the payer/management account.
2. Provide current CUR/FOCUS billing data for the selected connection.
3. Configure managed notification-provider secrets and worker workload IAM.
4. Provide Jira or ServiceNow endpoint credentials. The hosted runtime writes
   HMAC values directly to AWS Secrets Manager and persists only a scoped
   reference; see
   [`itsm-managed-credentials.md`](itsm-managed-credentials.md). Outbound
   dispatch and inbound signature verification resolve that managed value in
   source. A successful outbound response and an authenticated, valid inbound
   case callback are persisted per connector. Every enabled connector remains
   `attention` until both timestamps are later than that connector's latest
   configuration/secret update. The selected vendor endpoint must still prove
   retry/replay behavior and credential rotation in the deployed environment.
5. Schedule `pnpm vuln:feeds:refresh` and prove that its PostgreSQL upsert
   completes inside the 36-hour freshness target.
6. Keep the platform probe runner current for every component shown on the
   public status page.

The report is operational evidence, not a contractual SLA, certification, or
provider-delivery guarantee.
