## Change summary

<!-- What problem does this change solve? Keep the scope narrow. -->

## Release boundary

- [ ] Local demo only
- [ ] Disposable AWS sandbox
- [ ] Staging
- [ ] Production candidate

## Security and data impact

- [ ] No customer data, credentials, MFA material, ExternalIds, tokens or webhook URLs are included.
- [ ] Tenant/customer scope is derived server-side and has positive and negative tests.
- [ ] AWS permissions are unchanged.
- [ ] If permissions changed, the PR explains every action and why narrower access is insufficient.
- [ ] Secrets, logs, exports and retention behavior were reviewed.

## Verification

- [ ] Focused tests passed.
- [ ] `pnpm security:secrets` passed.
- [ ] `pnpm typecheck` and `pnpm lint` passed.
- [ ] Relevant Kubernetes, collector, PostgreSQL or rendered-route tests passed.
- [ ] Rollout, migration and rollback behavior is documented.

## Evidence and rollout

- Test or validation evidence:
- Known limitations:
- Rollout steps:
- Rollback or forward-fix steps:
- Related issue or P0 gate:
