# Sutra CNAPP competitive roadmap (Phases 1 & 2)

Status as of 2026-07-18. Constraint: build locally, verify with tests, **no AWS resources launched**.
Competitors referenced: Wiz, Orca, Prisma Cloud, Sysdig, Datadog (Trivy Operator and Falco are ingested, not competitors).

## Where we are

**Phase 1/2 ENGINE layer is built and verified** — 13 pure, deterministic, evidence-honest engines with 239 passing tests (`pnpm test:phase2`), added to the `verify` chain. Every engine returns explicit `unknown`/`unresolved`/`not-evaluated` states instead of synthesizing, and carries a limitations/disclaimer field. Commits: `c864854` (Wave 1, 8 engines), `ee3ebbb` (Wave 2, 5 engines).

The remaining work to make these *shipping features* is INGEST (feed the engines real evidence) → WIRING (pages/nav/API) → then the code-shaped Phase 1 items → then ops-gated items.

## Capability status

| Dimension | Engine(s) built | Tested | Ingest to feed it | Wired in UI |
|---|---|---|---|---|
| Vuln exploitability (EPSS/KEV) | `vulnerability-exploitability` | ✅ | ⬜ bundle KEV/EPSS feed + loader | ⬜ |
| Reachable / in-use vuln | `kubernetes-reachable-vulnerability` | ✅ | ◐ uses existing K8s evidence + exposure | ⬜ |
| Internet-exposure paths | `aws-network-exposure` | ✅ | ⬜ collect SG/NACL/route/ELB into input | ⬜ |
| NetworkPolicy generation | `kubernetes-networkpolicy-generator` | ✅ | ◐ uses observed Hubble flows | ⬜ |
| AWS IAM CIEM + right-size | `aws-iam-ciem` | ✅ | ⬜ collect IAM policies + last-used | ⬜ |
| Multi-framework compliance | `compliance-frameworks` | ✅ | ◐ uses collected control results | ⬜ |
| IaC misconfig scan | `iac-misconfiguration` + `iac-normalizer` | ✅ | ⬜ accept TF plan / manifests on upload | ⬜ |
| Cloud detection (CDR) | `cloud-detection` | ✅ | ⬜ ingest CloudTrail/GuardDuty/K8s-audit | ⬜ |
| Supply-chain verify + VEX | `supply-chain-verification` | ✅ | ◐ extends existing supply-chain ingest | ⬜ |
| Registry inventory + tag/digest policy | `registry-inventory` | ✅ | ✅ live local `registry:2` validation | ⬜ |
| Finding exceptions/suppression | `finding-exceptions` | ✅ | ◐ applies to existing findings | ⬜ repo + API |
| Collection scheduling | `collection-schedule` | ✅ | n/a (pure) | ⬜ repo + API |
| Case routing | `case-routing` | ✅ | n/a (pure) | ⬜ repo + API |

Legend: ✅ done · ◐ can run over already-collected evidence · ⬜ not yet.

Registry row 9 is closed only for catalog/tag/manifest inventory and deterministic
latest/unpinned/stale policy. Image CVE scanning is not claimed by this validation and
remains gated on a verified Trivy runtime.

## Remaining sequence

1. **Ingest / adapters** (unblocks wiring; several engines show "not configured" until this lands)
   - Bundle a CISA KEV + FIRST EPSS snapshot with a loader (honest about feed freshness).
   - Collector: gather SG/NACL/route-table/ELB, IAM policy statements + last-accessed, and (optional) CloudTrail/GuardDuty/K8s-audit events; adapters `derive*Input()` mapping CMDB → each engine input (model: `lib/kubernetes-ciem-evidence.ts`).
2. **Wiring** — new pages + nav keys + API endpoints + repository reads for: cloud exposure, IAM CIEM, exploitability-ranked vulns, NetworkPolicy suggestions, compliance frameworks + audit export, IaC scan upload, cloud detections; plus exceptions/scheduling/routing management screens.
3. **Phase 1 code** — multi-node **DaemonSet** agent (the one known architectural gap: bootstrap can't authenticate multiple pods today).
4. **Ops-gated (NOT code — deployment-time / external parties):** live-cluster scale/soak/chaos validation, independent pen-test, SOC 2 Type II, production HA/DR. Build enablers only.

## Not being built (strategic — protects the moat)

Agentless snapshot scanning, DSPM, own proprietary scan engines, full multicloud (Azure/GCP), and default auto-response/enforcement pull toward a vendor data-plane or cut against Sutra's data-minimization + human-confirmed posture. Deferred to Phase 3/4 and, if built, only in moat-preserving (customer-side / opt-in) form.
