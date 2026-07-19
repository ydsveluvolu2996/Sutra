import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import type { KubernetesSnapshot } from "./types.ts";

export type KubernetesModuleName = "trivy" | "kyverno" | "falco" | "cilium";
export type KubernetesModuleState = "AVAILABLE" | "DEGRADED" | "NOT_CONFIGURED" | "UNKNOWN";
export type KubernetesModuleHealth = Readonly<Record<KubernetesModuleName, KubernetesModuleState>>;

export interface KubernetesModuleHealthProbe {
  inspect(input: {
    readonly server: URL;
    readonly bearerToken: string;
    readonly certificateAuthorityPem?: string;
    readonly signal: AbortSignal;
  }): Promise<KubernetesModuleHealth>;
}

const MODULE_DISCOVERY_PATHS: Readonly<Record<KubernetesModuleName, string>> = {
  trivy: "/apis/aquasecurity.github.io/v1alpha1",
  kyverno: "/apis/kyverno.io/v1",
  falco: "/apis/falcosecurity.dev/v1alpha1",
  cilium: "/apis/cilium.io/v2",
};

export type KubernetesModuleDiscoveryTransport = (input: {
  readonly url: URL;
  readonly bearerToken: string;
  readonly certificateAuthorityPem?: string;
  readonly signal: AbortSignal;
}) => Promise<number>;

export const nodeKubernetesModuleDiscoveryTransport: KubernetesModuleDiscoveryTransport =
  async (input) => await new Promise<number>((resolve, reject) => {
    const request = (input.url.protocol === "https:" ? httpsRequest : httpRequest)(input.url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.bearerToken}`,
        "user-agent": "sutra-kubernetes-agent-health/1",
      },
      signal: input.signal,
      ...(input.url.protocol === "https:"
        ? { ca: input.certificateAuthorityPem, rejectUnauthorized: true }
        : {}),
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      resolve(status);
    });
    request.setTimeout(10_000, () => request.destroy(new Error("module discovery timed out")));
    request.once("error", reject);
    request.end();
  });

export class KubernetesDiscoveryModuleHealthProbe implements KubernetesModuleHealthProbe {
  private readonly request: KubernetesModuleDiscoveryTransport;

  public constructor(request: KubernetesModuleDiscoveryTransport = nodeKubernetesModuleDiscoveryTransport) {
    this.request = request;
  }

  public async inspect(input: {
    readonly server: URL;
    readonly bearerToken: string;
    readonly certificateAuthorityPem?: string;
    readonly signal: AbortSignal;
  }): Promise<KubernetesModuleHealth> {
    const entries = await Promise.all(
      Object.entries(MODULE_DISCOVERY_PATHS).map(async ([name, path]) => {
        try {
          const status = await this.request({
            url: new URL(path, input.server),
            bearerToken: input.bearerToken,
            certificateAuthorityPem: input.certificateAuthorityPem,
            signal: input.signal,
          });
          const state: KubernetesModuleState = status === 404
            ? "NOT_CONFIGURED"
            : status >= 200 && status < 300
              ? "AVAILABLE"
              : status === 401 || status === 403
                ? "DEGRADED"
                : "UNKNOWN";
          return [name, state] as const;
        } catch {
          return [name, "UNKNOWN"] as const;
        }
      }),
    );
    return Object.fromEntries(entries) as KubernetesModuleHealth;
  }
}

export interface FalcoGatewayHealthProbe {
  inspect(input: { readonly url: URL; readonly signal: AbortSignal }): Promise<KubernetesModuleState>;
}

export type FalcoGatewayStatusTransport = (input: {
  readonly url: URL;
  readonly signal: AbortSignal;
}) => Promise<number>;

export const nodeFalcoGatewayStatusTransport: FalcoGatewayStatusTransport =
  async (input) => await new Promise<number>((resolve, reject) => {
    const request = (input.url.protocol === "https:" ? httpsRequest : httpRequest)(input.url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "sutra-kubernetes-agent-health/1",
      },
      signal: input.signal,
    }, (response) => {
      const status = response.statusCode ?? 0;
      response.destroy();
      resolve(status);
    });
    request.setTimeout(10_000, () => request.destroy(new Error("falco gateway probe timed out")));
    request.once("error", reject);
    request.end();
  });

/**
 * Probes the in-cluster Falco signing gateway readiness endpoint so the
 * heartbeat reports runtime-delivery liveness instead of silently losing
 * events when the gateway stops. The probe sends no credentials and reads
 * only the response status.
 */
export class HttpFalcoGatewayHealthProbe implements FalcoGatewayHealthProbe {
  private readonly request: FalcoGatewayStatusTransport;

  public constructor(request: FalcoGatewayStatusTransport = nodeFalcoGatewayStatusTransport) {
    this.request = request;
  }

  public async inspect(input: {
    readonly url: URL;
    readonly signal: AbortSignal;
  }): Promise<KubernetesModuleState> {
    try {
      const status = await this.request({
        url: new URL("/readyz", input.url),
        signal: input.signal,
      });
      return status >= 200 && status < 300 ? "AVAILABLE" : "DEGRADED";
    } catch {
      return "UNKNOWN";
    }
  }
}

export function mergeKubernetesModuleHealth(
  discovery: KubernetesModuleHealth,
  snapshot: KubernetesSnapshot,
): KubernetesModuleHealth {
  const trivyCoverage = snapshot.coverage.filter((entry) => entry.collectorKey.startsWith("trivy-operator."));
  const trivy = trivyCoverage.some((entry) => entry.status === "succeeded")
    ? "AVAILABLE"
    : trivyCoverage.some((entry) => entry.status === "failed")
      ? discovery.trivy === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "DEGRADED"
      : discovery.trivy;
  return { ...discovery, trivy };
}
