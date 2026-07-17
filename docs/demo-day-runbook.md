# Sutra live AWS demo-day runbook

This runbook is for the local, one-account enterprise-pilot demonstration. It is
designed to preserve the last verified CMDB snapshot and to fail closed when a
required dependency is unavailable. It does not claim high availability or a
hosted production SLA.

## Thirty minutes before the meeting

1. Connect the laptop to power, disable sleep, and confirm Docker Desktop is ready.
2. Close unrelated applications that use ports `3000`, `8788`, or `54329`.
3. Confirm the AWS IAM Identity Center session. Never paste access keys or an MFA
   seed into Sutra, a terminal command, chat, or GitHub.
4. Start Sutra with the guarded command in [local-live-aws.md](local-live-aws.md).
   Wait for `Sutra live AWS demo is ready` before opening the browser.
5. In a second terminal, run the local dependency check:

   ```bash
   pnpm live:aws:status
   ```

   To include a short-lived AWS-session expiry check, supply only the already
   reviewed profile selector and source-role ARN:

   ```bash
   AWS_PROFILE=sutra-demo-collector \
   SUTRA_COLLECTOR_PRINCIPAL_ARN='arn:aws:iam::738663485493:role/sutra/SutraLocalCollectorRole' \
   pnpm live:aws:status
   ```

   `WARN` means refresh the SSO session before presenting. `FAIL` means stop and
   recover the failed dependency; do not begin a customer sync.
6. Open `http://127.0.0.1:3000/login`, sign in, complete MFA, and keep one tab on
   the dashboard. Do not display the bootstrap token or local runtime files.
7. Verify that the selected customer, AWS account, last successful collection,
   and evidence timestamps match the intended demonstration.

## Customer story

Use this order so every claim is backed by live or persisted evidence:

1. **Overview:** account coverage, resource totals, security posture and spend.
2. **Onboarding:** IAM trust role, unique External ID, validation and permission
   pack version. Explain that the customer owns and can delete the role stack.
3. **CMDB:** search resources, open one resource, follow relationships, then show
   change history.
4. **Security:** show CSPM findings and native Inspector, Security Hub and
   GuardDuty coverage. An unavailable native service is an honest coverage state,
   not a passing control.
5. **Compliance:** open a failed control, its evidence and remediation guidance.
6. **FinOps:** show real Cost Explorer data and clearly label unavailable forecast
   data when AWS does not return it.
7. **Operations:** show collection health, bounded/partial Regions, cases and the
   executive report.

Do not trigger a fresh full sync unless the customer specifically asks for it and
the AWS-session check is healthy. The persisted verified snapshot is the recovery
path for a transient AWS or network failure.

## Fast recovery

### Web page does not load

Run `pnpm live:aws:status`. If PostgreSQL is healthy but web or collector fails,
stop the launcher with `Ctrl-C`, confirm ports are free, then rerun the exact
guarded launch command. The database volume and encrypted connection registry are
retained.

### AWS session expires

Do not broaden IAM permissions and do not create a static access key. Refresh the
validated SSO terminal profile, rerun the guarded launcher, and confirm
`pnpm live:aws:status` passes with the AWS selector variables.

### Inventory sync becomes partial

Keep the last complete snapshot visible, show the explicit partial coverage
reason, and retry only after the dependency or permission issue is understood.
Never relabel partial evidence as complete.

### PostgreSQL is unavailable

Stop the launcher. Check Docker Desktop and the dedicated project without removing
its volume:

```bash
docker compose \
  --project-name sutra-live-aws \
  --env-file .sutra/docker.env \
  up --detach --wait postgres
```

Then restart the guarded launcher. Never run `docker compose down --volumes`,
`docker volume rm`, a database reset, or a destructive restore immediately before
the demo.

## Coordinated backup

The live database and host-only encrypted registry must be backed up together.
The backup command therefore refuses to run while the web or collector process can
mutate either side.

1. Stop the live launcher with `Ctrl-C`.
2. Run:

   ```bash
   pnpm live:aws:backup
   ```

3. Keep all generated files under `.sutra/live-aws-backups/` together. They are
   ignored sensitive customer data. Never upload them to GitHub, email, tickets or
   chat.
4. Restart the guarded launcher and rerun `pnpm live:aws:status`.

The backup includes a PostgreSQL custom dump, the matching encrypted host state,
and a checksum manifest. A restore is intentionally not a demo-day operation:
restore it only into a controlled copy after validating every manifest checksum,
the original `.sutra/docker.env`, and the original encryption-key fingerprints.
Until that isolated restore rehearsal is completed, describe this as a verified
backup artifact—not as production disaster recovery.

## Final go/no-go gate

Proceed only when:

- `pnpm live:aws:status` reports web, collector and PostgreSQL as `PASS`;
- the AWS session is `PASS`, or no live collection will be triggered;
- login and MFA complete successfully;
- the last verified CMDB snapshot and executive report open;
- no page displays fabricated, placeholder or unexplained partial data;
- no terminal, browser tab or recording exposes a secret or one-time External ID.

If any gate fails, demonstrate the last verified persisted snapshot and explain the
live dependency honestly instead of changing permissions during the meeting.
