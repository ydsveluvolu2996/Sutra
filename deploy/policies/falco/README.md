# Sutra managed Falco rules pack

`sutra-runtime-rules.yaml` is a curated runtime-threat ruleset that Sutra ships
and manages, layered **on top of** the upstream Falco default ruleset. It closes
the "no managed rules" gap: without it, a cluster runs only Falco's community
defaults with no Sutra-authored detections.

## What it detects

| Rule | Priority | Sutra severity | Intent |
|---|---|---|---|
| Reverse Shell In Container | CRITICAL | critical | Shell with stdio on a socket (T1059) |
| Crypto Mining Network Activity | CRITICAL | critical | Outbound to a mining-pool port (T1496) |
| Write Below System Binary Directory | ERROR | high | Binary planting/tampering (T1554) |
| Sensitive File Read | ERROR | high | shadow/private-key/credential read (T1552) |
| Privilege Escalation Via Setuid | ERROR | high | setuid to root in a container (T1548) |
| Package Management In Container | WARNING | medium | apt/yum/apk/pip/npm at runtime (T1072) |
| Shell Spawned In Container | NOTICE | low | Interactive shell in an app container (T1059) |
| Contact Kubernetes API Server | NOTICE | low | Container reaching the API server (T1613) |

Priority → Sutra severity mapping is enforced in `lib/falco-runtime-types.ts`
(`emergency/alert/critical → critical`, `error → high`, `warning → medium`,
else `low`).

## Two hard constraints (validated by `tests/falco-rules-pack.test.ts`)

1. **Priority** must be one of the syslog levels Sutra recognizes
   (`FALCO_PRIORITIES`). An unrecognized priority is rejected at ingestion.
2. **`output`** references only fields Sutra's ingestion boundary retains
   (`k8s.ns.name`, `k8s.pod.name`, `container.name`, `container.image.repository`,
   `proc.name`, `evt.type`, plus a few numeric/name fields used purely inside the
   output string). Raw command lines, environment values and file contents are
   dropped at the boundary, so detection intent lives in the **rule name**, which
   flows through verbatim to the Sutra finding title.

## How it is delivered

Shipped as a ConfigMap and referenced via the falcosecurity Helm chart's
`customRules` key (see `deploy/kubernetes/security-stack/falco-values.yaml`).
The security-stack plan (`scripts/kubernetes-security-stack.mjs`) requires this
file to be present and reports it in the applied plan. These rules **layer on
top of** the upstream defaults — `falcoctl.artifact.install` stays enabled.

## What still needs a live cluster

This pack's *structure* and *ingestion compatibility* are unit-tested. That the
rules actually **fire** on real syscalls, and that Falco loads the ConfigMap
without a validation error, can only be confirmed on a running cluster with the
Falco DaemonSet installed.
