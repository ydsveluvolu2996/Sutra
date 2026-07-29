# Plan: driving an agentless scan from the collector

Status: **plan only, nothing implemented from it yet.** Written 2026-07-29 after
discovering that the Worker cannot execute a scan at all.

## Why the route cannot do this itself

The `POST /api/v1/agentless-scans/:runId/execute` route was written to build an
`Ec2AgentlessExecutor` and call `executeAgentlessScan`. It cannot:

| Fact | Evidence |
|---|---|
| The Worker holds no AWS SDK | No `@aws-sdk/*` import anywhere in `app/`, `lib/`, `db/` |
| It is not even a dependency | `@aws-sdk/*` absent from the root `package.json` |
| The Worker never builds a broker | `createWorkloadIdentityRoleBroker` appears only inside the collector |
| AWS is reached over localhost | `SUTRA_BROKER_URL=http://127.0.0.1:8788`, via `brokerFetch` in `lib/pilot-server.ts` |

This is deliberate. **workerd holds no AWS SDK and no AWS credentials.** The
collector sidecar owns the SDK, the role broker, external-id decryption and the EC2
workload credentials. Adding `@aws-sdk/client-ec2` to the Worker bundle would put
credential handling in the same runtime that serves public HTTP — inverting the
boundary the design rests on. So execution moves to the collector, where the SDK
already is.

## The endpoint

Follows the existing collector conventions exactly: `/v1/...` path, shared-secret
auth already applied by `dispatch`, loopback-only listener on `127.0.0.1:8788`.

```
POST /v1/agentless/scans/{runId}/execute
```

Request body — the Worker resolves configuration and passes it, so the
no-defaults contract and the operator-facing refusal stay in ONE place
(`resolveAgentlessExecutorConfig`) rather than being re-derived here:

```jsonc
{
  "scope": { "orgId": "...", "customerId": "..." },
  "connectionId": "conn_...",
  "plan": { /* the exact approved AgentlessScanPlan */ },
  "settings": { /* the 12 resolved SUTRA_AGENTLESS_* values */ }
}
```

Response: **`202 Accepted`**, not a result. See below.

## It MUST be asynchronous

A scan is minutes: snapshot copy, instance boot, Trivy DB download, scan, teardown.
The collector server sets `requestTimeout = 190_000`, so a synchronous execute would
time out mid-scan — with a snapshot and an instance already created and billing, and
no caller left to reap them. That is the worst available failure.

So the endpoint enqueues and returns immediately:

1. Validate body, then transition the run `planned -> running` (the repository
   already refuses any other source state, so a completed run is never re-opened).
2. Hand the work to the collector's existing local job worker — `localJobs.worker`
   is already started on `listening` and stopped on `close`, so there is a supervised
   place for this to live rather than a detached promise.
3. Return `202` with the run id.
4. The Worker polls the run, as the UI already does.

## Where each module belongs

Two modules I wrote are correct code on the wrong side of the process boundary:

| Module | Now | Should be |
|---|---|---|
| `services/agentless-scanner/src/ec2-scan-worker.ts` | scanner package | unchanged — the collector imports it |
| `services/agentless-scanner/src/scan-instance-operations.ts` | scanner package | unchanged — the collector imports it |
| `lib/aws-agentless-client-factory.ts` | Worker lib | **delete** |

The client factory becomes redundant, and I should say so plainly having just built
it: it exists to obtain a customer session and a scan-account session. Inside the
collector the broker is already in hand, so `broker.assumeAgentlessSession(...)` is a
direct call and the scan-account assume is one `AssumeRoleCommand`. An indirection
whose only job was to reach a component we now sit next to is not worth keeping. The
GUARANTEE it encoded must survive the move, though, and is restated below.

The scanner package will need to be a dependency of the collector package, or its two
modules moved into `services/aws-collector/src/`. Prefer the dependency: the scanner
package also builds the container image and should keep its own identity.

## Guarantees that must survive the move

These are the things the deleted factory and the current tests protect. Each needs an
equivalent test on the collector side, or the move is a regression:

1. **The customer session is ceilinged by `agentlessSnapshotSessionPolicy`** — via
   `broker.assumeAgentlessSession`, never `assumeValidatedSession`, whose read-only
   ceiling lacks the snapshot verbs.
2. **The scan-account session carries NO session policy.** That policy denies
   `ec2:Delete*`, which is exactly what teardown in Sutra's own account needs.
   Applying it there would not fail loudly — it would leave every scan volume and
   copied snapshot billing while each scan reported success.
3. **The orchestrator role must live in the configured scan account**, or a customer
   snapshot could be copied into an account nobody intended.
4. **Absence is never cleanliness.** Findings absent means still running; findings
   unparseable or not a list is a refusal, not an empty result; a refusal is raised
   rather than returned as `[]`.
5. **Teardown runs on every path** including timeout, and a teardown failure never
   masks the result.

## The plan-persistence gap

`StoredAgentlessRun` exposes only summary counters — no plan. But
`recordPlannedRun` already persists `planJson`, so the plan is in the row and simply
is not mapped by `toStoredRun`. Exposing it is the cheap, correct fix.

This matters for a reason beyond convenience: applying a run must execute **the exact
plan a human approved**, not a plan re-derived at apply time from inventory that may
have changed since. Re-deriving would silently widen scope.

## Test plan

* Collector route: rejects a missing/incorrect shared secret; rejects a run not in
  `planned`; rejects a scope/connection mismatch (a run id is not a capability);
  returns 202 and transitions to `running`.
* Session ceilings: assert `assumeAgentlessSession` is what gets called for the
  customer side, and that the scan-account assume is issued with no `Policy`.
* The five guarantees above, ported from the existing worker/factory suites.
* Worker route: on a 202 it does NOT mark the run complete, and on a collector error
  it surfaces the failure without claiming a clean scan.

## Open decisions for the operator

1. **`LIVE_VALIDATED` stays false until this exists.** Today it would attest to a
   path that cannot run.
2. **`ScanCluster` and the two ECS task roles are still deployed and unused.** They
   should be removed in their own reviewed change set; leaving them implies a Fargate
   path that AWS has proven impossible.
3. **First live scan needs a throwaway target volume**, not a customer's. The
   executor's assumptions were validated as admin on 2026-07-29; this path has never
   run end to end.

## Estimate

Not small. The endpoint, the job-worker integration, moving two modules behind a
package dependency, exposing the plan, and porting five guarantees as tests is a
focused session of its own — not glue on the end of another task.
