# Login and AWS onboarding visual QA

Captured on 2026-08-14 with Playwright and desktop Chrome against the local
Sutra development server. Authentication used a disposable local account. AWS
API responses were deterministic browser-route fixtures; no AWS credentials or
customer data were used.

- `login-desktop.png` — hosted multi-provider sign-in at 1512×758.
- `login-mobile.png` — hosted multi-provider sign-in at 390×844.
- `aws-provider-selection.png` — searchable AWS-only provider catalog.
- `iam-role-quick-launch.png` — one-time External ID and CloudFormation quick launch.
- `iam-role-manual-creation.png` — pinned template download and manual steps.
- `access-keys-disabled.png` — fail-closed access-key alternative while the
  reviewed Secrets Manager backend is unavailable.
- `required-field-errors.png` — inline required-field errors.
- `successful-validation-discovery.png` — verified role saved with asynchronous
  discovery queued, refresh/retry affordance, and dashboard return.
