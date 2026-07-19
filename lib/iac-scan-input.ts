// Pure parsing of the two text inputs the IaC scan tool accepts — a Terraform
// plan JSON (`terraform show -json`) and/or a Kubernetes manifest JSON (a single
// object or an array) — into the normalizer's IacNormalizerInput. The engine
// deliberately consumes normalized JSON, not raw HCL/YAML, so this only does a
// bounded JSON.parse and reports a friendly error per input; it never guesses at
// malformed content. A blank input is simply omitted.
import type { IacNormalizerInput, KubernetesManifest, TerraformPlan } from "./iac-normalizer.ts";

export interface IacScanTextInput {
  readonly terraformText?: string;
  readonly manifestsText?: string;
}

export interface IacScanParseResult {
  readonly input: IacNormalizerInput;
  readonly errors: readonly string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseIacScanInput(text: IacScanTextInput): IacScanParseResult {
  const errors: string[] = [];
  let terraform: TerraformPlan | null = null;
  let manifests: readonly KubernetesManifest[] | null = null;

  const terraformText = text.terraformText?.trim() ?? "";
  if (terraformText.length > 0) {
    try {
      const parsed: unknown = JSON.parse(terraformText);
      if (isObject(parsed)) terraform = parsed as TerraformPlan;
      else errors.push("The Terraform plan must be a JSON object from `terraform show -json`.");
    } catch {
      errors.push("The Terraform plan is not valid JSON.");
    }
  }

  const manifestsText = text.manifestsText?.trim() ?? "";
  if (manifestsText.length > 0) {
    try {
      const parsed: unknown = JSON.parse(manifestsText);
      if (Array.isArray(parsed)) manifests = parsed as readonly KubernetesManifest[];
      else if (isObject(parsed)) manifests = [parsed as KubernetesManifest];
      else errors.push("The Kubernetes manifests must be a JSON object or an array of objects.");
    } catch {
      errors.push("The Kubernetes manifests are not valid JSON.");
    }
  }

  return { input: { terraform, manifests }, errors };
}
