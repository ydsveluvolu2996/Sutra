// Pre-scan IaC normalizer: a bounded, deterministic mapper that converts
// already-parsed infrastructure-as-code documents into the exact resource shape
// the committed IaC misconfiguration scanner consumes. It accepts parsed JS
// objects only — a Terraform plan JSON object and/or an array of parsed
// Kubernetes manifest objects — and never reads files, raw HCL, or raw YAML,
// and never touches the network, the clock, or randomness. Two honesty rules
// set it apart from a lossy adapter that fills in provider defaults:
//   * It maps ONLY fields present in the source. A value absent from the source
//     is absent from the normalized config — never defaulted or synthesized — so
//     the downstream scanner records it as 'field-absent' (an explicit unknown)
//     rather than a manufactured pass or fail. A wrong-typed source field reads
//     as absent rather than being coerced.
//   * A resource whose kind the scanner does not model is passed through with
//     its kind and name (and raw values) so scanner coverage can report it,
//     never silently dropped.
// The output element shape is exactly IacResource ({ kind, name, config,
// sourceRef? }); feed it straight into scanIacResources.

import type { IacResource, IacSourceRef } from "./iac-misconfiguration.ts";

// ---- public input shapes (parsed JS objects; fields read defensively) ----

export interface TerraformSourceResource {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly address?: unknown;
  readonly values?: unknown;
  readonly change?: unknown;
  readonly sourceRef?: unknown;
}

export interface TerraformModule {
  readonly resources?: unknown;
  readonly child_modules?: unknown;
}

export interface TerraformPlannedValues {
  readonly root_module?: unknown;
}

export interface TerraformPlan {
  readonly planned_values?: unknown;
  readonly resource_changes?: unknown;
}

export interface KubernetesManifest {
  readonly apiVersion?: unknown;
  readonly kind?: unknown;
  readonly metadata?: unknown;
  readonly spec?: unknown;
  readonly sourceRef?: unknown;
}

export interface IacNormalizerInput {
  readonly terraform?: TerraformPlan | null;
  readonly manifests?: readonly KubernetesManifest[] | null;
}

export const IAC_NORMALIZER_DISCLAIMER =
  "Sutra normalizes already-parsed Terraform plan and Kubernetes manifest " +
  "objects into scanner resource evidence; it never reads files or parses raw " +
  "HCL or YAML. Only fields present in the source are mapped: a value absent " +
  "from the source is absent from the normalized config, never defaulted, so the " +
  "scanner records it as 'field-absent' rather than a synthesized pass or fail. " +
  "A wrong-typed source field reads as absent. Resource kinds the scanner does " +
  "not model are passed through with their kind and name so coverage can report " +
  "them, never dropped. Normalization is a faithful mapping, not a security " +
  "judgement, and the absence of a finding is not proof of a secure configuration.";

// ---- typed readers: a missing or wrong-typed field reads as absent ----

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readSourceRef(value: unknown): IacSourceRef | undefined {
  if (!isRecord(value)) return undefined;
  const file = readString(value.file);
  if (file === undefined) return undefined;
  const line = value.line;
  return typeof line === "number" && Number.isFinite(line) ? { file, line } : { file };
}

function iacResource(
  kind: string,
  name: string,
  config: Record<string, unknown>,
  sourceRef: IacSourceRef | undefined,
): IacResource {
  return { kind, name, config, ...(sourceRef !== undefined ? { sourceRef } : {}) };
}

// ---- Terraform: type -> kind, values -> config (faithful passthrough) ----

function terraformConfig(values: unknown): Record<string, unknown> {
  // Copy every present top-level field; absent fields stay absent. The scanner's
  // AWS rules read flat attribute names (acl, ingress, publicly_accessible,
  // storage_encrypted, encrypted, ...) that already match a Terraform resource's
  // planned values, so a faithful copy is exact — nothing is invented.
  return isRecord(values) ? { ...values } : {};
}

function resourceKey(entry: Record<string, unknown>): string {
  const address = readString(entry.address);
  if (address !== undefined) return `addr\0${address}`;
  return `tn\0${readString(entry.type) ?? ""}\0${readString(entry.name) ?? ""}`;
}

function collectModuleResources(module: unknown, out: Record<string, unknown>[]): void {
  if (!isRecord(module)) return;
  for (const entry of asArray(module.resources)) {
    if (isRecord(entry)) out.push(entry);
  }
  for (const child of asArray(module.child_modules)) collectModuleResources(child, out);
}

function terraformResource(entry: Record<string, unknown>, values: unknown): IacResource | undefined {
  const kind = readString(entry.type);
  if (kind === undefined) return undefined; // cannot classify without a resource type
  return iacResource(kind, readString(entry.name) ?? "", terraformConfig(values), readSourceRef(entry.sourceRef));
}

export function normalizeTerraformPlan(plan: TerraformPlan | null | undefined): readonly IacResource[] {
  if (!isRecord(plan)) return [];
  const resources: IacResource[] = [];
  const seen = new Set<string>();

  const planned: Record<string, unknown>[] = [];
  if (isRecord(plan.planned_values)) collectModuleResources(plan.planned_values.root_module, planned);
  for (const entry of planned) {
    const key = resourceKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    const resource = terraformResource(entry, entry.values);
    if (resource !== undefined) resources.push(resource);
  }

  // resource_changes describes the same addresses; add only ones not already
  // seen so a plan carrying both sections is not double-counted. Planned values
  // are preferred; a change without inline `values` falls back to change.after.
  for (const raw of asArray(plan.resource_changes)) {
    if (!isRecord(raw)) continue;
    const key = resourceKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    const values = isRecord(raw.values)
      ? raw.values
      : isRecord(raw.change) && isRecord(raw.change.after)
        ? raw.change.after
        : undefined;
    const resource = terraformResource(raw, values);
    if (resource !== undefined) resources.push(resource);
  }

  return resources;
}

// ---- Kubernetes: manifest -> kubernetes_pod evidence or unknown passthrough ----

const POD_TEMPLATE_KINDS = new Set([
  "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "ReplicationController", "Job",
]);

function extractPodSpec(kind: string, spec: Record<string, unknown>): Record<string, unknown> | undefined {
  if (kind === "Pod") return spec;
  if (kind === "CronJob") {
    const jobTemplate = isRecord(spec.jobTemplate) ? spec.jobTemplate : undefined;
    const jobSpec = jobTemplate !== undefined && isRecord(jobTemplate.spec) ? jobTemplate.spec : undefined;
    const template = jobSpec !== undefined && isRecord(jobSpec.template) ? jobSpec.template : undefined;
    return template !== undefined && isRecord(template.spec) ? template.spec : undefined;
  }
  if (POD_TEMPLATE_KINDS.has(kind)) {
    const template = isRecord(spec.template) ? spec.template : undefined;
    return template !== undefined && isRecord(template.spec) ? template.spec : undefined;
  }
  return undefined;
}

function securityContextOf(container: unknown): Record<string, unknown> | undefined {
  if (!isRecord(container)) return undefined;
  return isRecord(container.securityContext) ? container.securityContext : undefined;
}

function hasNonEmptyLimits(container: unknown): boolean {
  if (!isRecord(container)) return false;
  const resources = isRecord(container.resources) ? container.resources : undefined;
  const limits = resources !== undefined && isRecord(resources.limits) ? resources.limits : undefined;
  return limits !== undefined && Object.keys(limits).length > 0;
}

// Positive-risk aggregation (privileged): true needs at least one explicit true;
// false needs every container to declare false; otherwise absent (unknown).
function aggregateRisk(values: readonly (boolean | undefined)[]): boolean | undefined {
  if (values.some((value) => value === true)) return true;
  if (values.length > 0 && values.every((value) => value === false)) return false;
  return undefined;
}

// Positive-requirement aggregation (run_as_non_root): false needs at least one
// explicit false; true needs every container to satisfy it; otherwise absent.
function aggregateRequirement(values: readonly (boolean | undefined)[]): boolean | undefined {
  if (values.some((value) => value === false)) return false;
  if (values.length > 0 && values.every((value) => value === true)) return true;
  return undefined;
}

function podConfig(podSpec: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const containers = asArray(podSpec.containers);
  const podSecurity = isRecord(podSpec.securityContext) ? podSpec.securityContext : undefined;

  const hostNetwork = readBoolean(podSpec.hostNetwork);
  if (hostNetwork !== undefined) config.host_network = hostNetwork;

  const privileged = aggregateRisk(
    containers.map((container) => readBoolean(securityContextOf(container)?.privileged)),
  );
  if (privileged !== undefined) config.privileged = privileged;

  const podRunAsNonRoot = readBoolean(podSecurity?.runAsNonRoot);
  const runAsNonRoot = containers.length > 0
    ? aggregateRequirement(containers.map((container) => {
        const own = readBoolean(securityContextOf(container)?.runAsNonRoot);
        return own !== undefined ? own : podRunAsNonRoot;
      }))
    : podRunAsNonRoot;
  if (runAsNonRoot !== undefined) config.run_as_non_root = runAsNonRoot;

  // A workload declares resource limits only when every container carries a
  // non-empty resources.limits; a manifest is the complete desired state, so a
  // container that omits limits is observed as lacking them. With no containers
  // there is no evidence, so the flag stays absent.
  if (containers.length > 0) {
    config.has_resource_limits = containers.every((container) => hasNonEmptyLimits(container));
  }

  return config;
}

function normalizeManifest(manifest: unknown): IacResource | undefined {
  if (!isRecord(manifest)) return undefined;
  const kind = readString(manifest.kind);
  if (kind === undefined) return undefined; // cannot classify without a manifest kind
  const metadata = isRecord(manifest.metadata) ? manifest.metadata : undefined;
  const name = readString(metadata?.name) ?? "";
  const spec = isRecord(manifest.spec) ? manifest.spec : {};
  const sourceRef = readSourceRef(manifest.sourceRef);

  const podSpec = extractPodSpec(kind, spec);
  if (podSpec !== undefined) {
    return iacResource("kubernetes_pod", name, podConfig(podSpec), sourceRef);
  }
  // Unknown kind: surface it for coverage. The spec is passed through as raw
  // values; non-spec payloads (e.g. Secret data) are deliberately not copied.
  return iacResource(`kubernetes_${kind.toLowerCase()}`, name, { ...spec }, sourceRef);
}

export function normalizeKubernetesManifests(
  manifests: readonly KubernetesManifest[] | null | undefined,
): readonly IacResource[] {
  if (!Array.isArray(manifests)) return [];
  const resources: IacResource[] = [];
  for (const manifest of manifests) {
    const resource = normalizeManifest(manifest);
    if (resource !== undefined) resources.push(resource);
  }
  return resources;
}

export function normalizeIac(input: IacNormalizerInput | null | undefined): readonly IacResource[] {
  if (!isRecord(input)) return [];
  return [
    ...normalizeTerraformPlan(input.terraform as TerraformPlan | null | undefined),
    ...normalizeKubernetesManifests(input.manifests as readonly KubernetesManifest[] | null | undefined),
  ];
}
