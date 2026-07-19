# Native runtime sensor — evaluation

**Status:** evaluation / decision doc. No implementation change. Frames whether
Sutra should build its own eBPF runtime sensor or keep managing an upstream one.

## Where we are today
Runtime threat detection is **BYO Falco** + a Sutra **managed rules pack**
(`deploy/policies/falco/sutra-runtime-rules.yaml`) delivered via the
falcosecurity chart, with a signed, metadata-only ingest gateway
(`services/falco-signing-gateway`) and a hardened boundary
(`lib/falco-runtime-boundary.ts`). Sutra does **not** ship its own kernel/eBPF
sensor. This is the largest capability gap vs. Sysdig/Aqua on runtime.

## Options

### Option A — Keep managing Falco (status quo, hardened)
- **Pros:** zero kernel code to own; Falco is CNCF-graduated and battle-tested;
  Sutra already adds value (managed rules, signed ingest, honest boundary). Fast.
- **Cons:** customer installs/operates the DaemonSet; Sutra can't guarantee the
  sensor's health or version; "managed" is rules-only, not the sensor.
- **Effort:** none beyond current. **Risk:** low.

### Option B — Ship Falco *as a managed dependency* (like the Trivy Operator)
- Bundle + pin Falco in the Sutra chart (as done for Trivy), so the sensor is
  turnkey and version-controlled by Sutra, still upstream Falco under the hood.
- **Pros:** turnkey runtime with no BYO step; reuses the proven Trivy-bundling
  pattern; keeps the honest ingest boundary. **Cons:** Sutra now owns the
  DaemonSet's privileged footprint + upgrades. **Effort:** small–medium (chart +
  values + health wiring). **Risk:** low–medium. **This is the recommended next
  step** — highest value per unit effort, no kernel code.

### Option C — Adopt Tetragon (eBPF, Cilium ecosystem)
- Tetragon gives eBPF-based process/network/file observability with in-kernel
  enforcement (kill/override) and pairs naturally with the Cilium/Hubble stack
  Sutra already ingests.
- **Pros:** true eBPF depth; enforcement primitives; aligns with the Cilium
  investment. **Cons:** a second runtime stack to normalize; policy authoring +
  a new ingest boundary; enforcement is powerful and dangerous (needs the same
  human-gated model as containment). **Effort:** medium–large. **Risk:** medium.

### Option D — Build a first-party eBPF sensor (libbpf/CO-RE)
- **Pros:** full control, differentiation. **Cons:** owning kernel-version
  compatibility (CO-RE/BTF), a huge maintenance and security surface, and
  re-deriving detections the community already maintains. **Effort:** very large.
  **Risk:** high. **Not recommended** — reinvents Falco/Tetragon with a small team.

## Recommendation
1. **Now (code, low risk):** Option B — bundle + manage Falco as a chart
   dependency so runtime detection is turnkey and Sutra-versioned, mirroring the
   managed-Trivy pattern. Keep the managed rules pack and signed ingest.
2. **Next (evaluate on a cluster):** pilot Option C (Tetragon) for eBPF-native
   enforcement, reusing the human-gated containment-plan model already built
   (`lib/kubernetes-containment.ts`) so any kill/override stays operator-approved.
3. **Do not** pursue Option D unless a first-party sensor becomes a core
   differentiator with a team to sustain it.

## Honest limits
Whichever option, "the sensor fires on real syscalls" and "enforcement actually
blocks" remain **live-cluster-validated**, never asserted from code. The ingest
boundary (metadata-only, drop raw args/env/cmdline) is preserved regardless of
sensor.
