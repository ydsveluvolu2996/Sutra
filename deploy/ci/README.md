# Sutra CI/CD security gate — Jenkins & Kubernetes

Gate a build or deploy on the same security scanners Sutra runs in GitHub
Actions (`.github/workflows/pipeline-scan.yml`), from Jenkins or in-cluster.

## Components

| File | Purpose |
| --- | --- |
| `scripts/pipeline-scan.mjs` | Runs the scanners (repo secret scan + IaC misconfiguration + Trivy image/dependency) and aggregates them into one pass/fail. `--json <file>` writes the stage results for the reporter. Exit `2` = breached. |
| `scripts/ci-gate.mjs` | Reads stage results, applies a severity threshold (`--fail-on`), writes a JUnit report (`--junit <file>`), and exits `2` when breached. Backed by the tested `lib/ci-scan-gate.ts` engine. |
| `deploy/ci/Jenkinsfile` | Declarative Jenkins pipeline that runs on a Kubernetes agent and publishes the JUnit report. |
| `deploy/ci/jenkins-pod.yaml` | Hardened pod template (Node + Trivy containers) for the Jenkins `kubernetes` agent. |
| `deploy/ci/kubernetes-gate-job.yaml` | In-cluster `Job` for a GitOps / Argo / Tekton path. |

## The gate contract

- **Severity threshold** — a stage that *failed* breaches the gate only when its
  worst finding is at or above `--fail-on` (`critical | high | medium | low`,
  default `high`). A failed stage with an **unknown** severity is treated as a
  breach: an unmeasured failure is never a pass.
- **Honest skips** — a stage is `skipped` only when its input or tool was
  genuinely absent (no IaC plan, Trivy not installed). Skips are reported, never
  silently counted as passes.
- **Exit codes** — `0` pass, `2` breached, `1` runtime error. JUnit `<failure>`
  marks breaching stages, `<skipped>` marks skips.

## Jenkins

1. Create a Pipeline (or Multibranch) job pointing at `deploy/ci/Jenkinsfile`.
2. Ensure the Jenkins Kubernetes cloud is configured; the pipeline provisions an
   ephemeral pod from `jenkins-pod.yaml` (no tools on the controller).
3. Set the `FAIL_ON` parameter (default `high`) and optionally `IMAGE` to scan a
   built image. The build fails and the JUnit report renders when breached.

## Kubernetes (in-cluster)

```sh
# Edit SUTRA_REPO / SUTRA_REF / FAIL_ON in the manifest first.
kubectl create -f deploy/ci/kubernetes-gate-job.yaml
kubectl wait --for=condition=complete job/sutra-security-gate --timeout=15m \
  || kubectl logs job/sutra-security-gate
```

A **failed Job** is the breach signal an Argo/Tekton step or a GitOps controller
gates on. The pod runs non-root, drops all capabilities, and mounts no
service-account token — the gate only reads the checked-out workspace.

## Local dry-run

```sh
node scripts/pipeline-scan.mjs --fail-on high --json gate-stages.json
node scripts/ci-gate.mjs --stages gate-stages.json --fail-on high --junit gate-report.xml
echo "exit=$?"
```
