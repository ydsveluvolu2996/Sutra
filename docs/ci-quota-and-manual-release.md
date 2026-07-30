# CI quota controls and the manual EC2 release path

**Scope:** legacy/private-beta single-host EC2 only. This is not the
managed-production HA release process. For the protected app/worker/broker release
contract, see
[`../deploy/production/README.md`](../deploy/production/README.md). There is no
quota-independent manual bypass for that managed-production workflow.

## What an exhausted quota changes

An exhausted GitHub Actions allowance stops new hosted-runner jobs. It does not
stop Git pushes, ECR images that already exist, the running EC2/Compose
application, PostgreSQL, Cloudflare DNS/Tunnel traffic, or the public site.
Automatic CI evidence and the GitHub-hosted release workflow remain unavailable
until billing is corrected or the allowance resets.

Do not respond by disabling image scanning, deploying mutable tags, building on
the 15-GiB EC2 host, adding static AWS keys to GitHub, or sending an arbitrary
shell command through SSM. Use the reviewed local release path below.

## Runner-consumption policy

Sutra keeps the existing required check name
`CI / Typecheck, lint, test, and build`, but reduces redundant hosted work:

| Event | Work performed |
| --- | --- |
| Pull request | One consolidated application/security/test/build job and one integration job run in parallel. Tests remain serial inside the application runner because several suites mutate process-level state. |
| Squash/merge push to `main` | A bounded resolver finds the one PR associated with the exact main commit and reuses verification only when that PR's exact head SHA, branch and repository have a successful CI run completed before merge. |
| Direct, ambiguous or unverified push to `main` | The complete application and integration gates run again. API errors also prevent reuse. |
| Manual dispatch | The complete gates run. |

The resolver cannot turn a failed or absent PR check into success. The final
aggregate job accepts either two successful fresh gates or an exact successful
reuse; skipped jobs are accepted only in the latter case.

The pipeline security gate is now part of the consolidated CI job. Its reusable
workflow remains available to customer pipelines and for manual dispatch, but
does not start a second hosted runner for every Sutra PR/push. CI still runs:

- the committed-secret/local-state check;
- production dependency audit;
- Trivy fixable `HIGH`/`CRITICAL` dependency scan;
- Trivy `HIGH`/`CRITICAL` Kubernetes/infrastructure configuration scan;
- the combined Sutra pipeline gate;
- typecheck, lint, every offline PR-gate test, production build and rendered
  route tests.

Kubernetes' additional SBOM/security workflow runs only for relevant pull
request paths or explicit manual dispatch. `deploy/ec2`, Cloudflare, prose and
unrelated infrastructure no longer trigger it. A Kubernetes release itself
still has its separate manual exact-image Trivy, SBOM, provenance and Cosign
gates.

CodeQL runs weekly and on manual dispatch. On the current private Free
repository the job remains skipped until GitHub Advanced Security is available
and `CODEQL_ENABLED=true`; creating a skipped run for every PR/push added noise
without analysis. The long-running endurance suite is weekly plus manual, rather
than daily.

## Preferred release when Actions is available

Use **Actions -> Release Sutra private beta to EC2 -> Run workflow**. That path
uses GitHub OIDC, an immutable ECR candidate, exact-digest Trivy, manifest
promotion, the constrained SSM document, rollback-capable host deployment and
public verification. A push does not deploy by itself.

## Quota-independent release when Actions is unavailable

The fallback is [`scripts/manual-ec2-release.sh`](../scripts/manual-ec2-release.sh).
It deliberately has no skip-test, skip-scan, mutable-tag, host-start or
arbitrary-command mode. It requires:

1. the exact clean `main` commit already pushed to the canonical GitHub
   repository;
2. a local Docker/Buildx runtime;
3. Node 22, pnpm 11.13.1, Trivy 0.72.0, cfn-lint 1.46.0, AWS CLI v2, `jq`.
   Run `pnpm lint:cloudformation`; its wrapper suppresses only the exact
   `bedrock:GetAccountDataRetention` W3037 catalog lag that AWS documents,
   while every other cfn-lint finding remains release-blocking.
   `curl` and OpenSSL;
4. an interactive IAM Identity Center session for the
   `sutra-administrator` profile; and
5. the retained EC2 host manually started and online in SSM.

Run:

```bash
aws sso login --profile sutra-administrator
SUTRA_RELEASE_REASON='Release reviewed security and customer access fixes' \
  bash scripts/manual-ec2-release.sh
```

The script:

1. rejects static/injected AWS credentials, a dirty tree, another branch,
   another repository, an unpushed commit and the wrong AWS account;
2. verifies immutable/encrypted ECR settings and the reviewed lifecycle policy;
3. creates a private detached worktree at the pushed commit, copies the
   permission-restricted local PostgreSQL secret into it only for the isolated
   database gate, removes that ephemeral copy, then runs the complete source,
   dependency, configuration, test, build, rendered-route and
   deployment-contract gates there; the PR-gate suite uses four separate
   duration-balanced Node processes that remain serial internally, and the same
   secret-free detached tree is the Docker build context;
4. pushes a unique `candidate-` OCI index with maximum provenance and SBOM
   attestations;
5. scans the exact digest with Trivy;
6. verifies the manifest hash, linux/amd64 image and attestation manifest before
   attaching a retained immutable `sha-` tag;
7. sends only that full digest to `Sutra-DeployImmutableRelease` on the exact
   retained instance;
8. waits for rollback-capable deployment to complete and verifies the public
   release identity, Turnstile runtime, login/status/indexing assets,
   `security.txt` and canonical apex redirect; and
9. writes non-secret local release evidence beneath ignored
   `.sutra/manual-releases/`.

If a source or vulnerability gate fails, there is no retained release tag and
no SSM deployment. The unpromoted candidate ages out under the one-day ECR
lifecycle rule. If the host transaction fails, `release-update.sh` performs its
existing rollback and the manual command exits non-zero.

The fallback authenticates directly with the operator's short-lived SSO
session, so it is appropriate only for the current controlled private beta.
For a team-operated production service, restore hosted CI/CD with protected
review, OIDC and durable release evidence rather than distributing broader
operator access.
