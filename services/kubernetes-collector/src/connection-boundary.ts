import { isIP } from "node:net";
import type {
  KubernetesKubeconfig,
  TrustedKubernetesConnection,
} from "./types.ts";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NAME = /^[^\u0000-\u001f\u007f]{1,180}$/u;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_CA_BYTES = 128 * 1024;

export type ResolvedKubernetesConnection = {
  readonly clusterId: string;
  readonly clusterName: string;
  readonly server: URL;
  readonly token: string;
  readonly certificateAuthorityPem?: string;
};

export class KubernetesConnectionError extends Error {
  public readonly code = "INVALID_KUBERNETES_CONNECTION";

  public constructor(message: string) {
    super(message);
    this.name = "KubernetesConnectionError";
  }
}

function invalid(message: string): never {
  throw new KubernetesConnectionError(message);
}

function exactObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function exactArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) invalid(`${label} is invalid`);
  return value;
}

function safeName(value: unknown, label: string): string {
  if (typeof value !== "string" || !NAME.test(value) || value !== value.trim()) invalid(`${label} is invalid`);
  return value;
}

function safeToken(value: unknown): string {
  if (
    typeof value !== "string" || value.length < 8 || value.length > MAX_TOKEN_BYTES ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) invalid("Kubernetes bearer credential is invalid");
  return value;
}

function safeCaPem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" || value.length > MAX_CA_BYTES ||
    !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/u.test(value)
  ) invalid("Kubernetes certificate authority is invalid");
  return value;
}

function certificateAuthorityData(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > Math.ceil(MAX_CA_BYTES * 1.5) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    invalid("Kubeconfig certificate authority data is invalid");
  }
  return safeCaPem(Buffer.from(value, "base64").toString("utf8"));
}

function serverUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 2_048) invalid("Kubernetes API URL is invalid");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid("Kubernetes API URL is invalid");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" || isIP(url.hostname) === 6 && url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    invalid("Kubernetes API must use HTTPS; HTTP is allowed only for an exact loopback host");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    invalid("Kubernetes API URL must contain only scheme, host, and optional port");
  }
  return new URL(url.origin);
}

function namedEntry(entries: unknown, name: string, valueKey: string): Record<string, unknown> {
  const matches = exactArray(entries, `Kubeconfig ${valueKey}`).map((value) => exactObject(value, `Kubeconfig ${valueKey} entry`))
    .filter((entry) => entry.name === name);
  if (matches.length !== 1) invalid(`Kubeconfig ${valueKey} selection is ambiguous`);
  const selected = matches[0];
  if (Object.keys(selected).some((key) => key !== "name" && key !== valueKey)) invalid(`Kubeconfig ${valueKey} entry contains unsupported fields`);
  return exactObject(selected[valueKey], `Kubeconfig ${valueKey}`);
}

function resolveKubeconfig(
  document: KubernetesKubeconfig,
  requestedContext: string | undefined,
): { readonly server: URL; readonly token: string; readonly certificateAuthorityPem?: string } {
  const contextName = safeName(requestedContext ?? document["current-context"], "Kubeconfig context");
  const context = namedEntry(document.contexts, contextName, "context");
  if (Object.keys(context).some((key) => key !== "cluster" && key !== "user" && key !== "namespace")) {
    invalid("Kubeconfig context contains unsupported authentication fields");
  }
  const clusterName = safeName(context.cluster, "Kubeconfig cluster name");
  const userName = safeName(context.user, "Kubeconfig user name");
  const cluster = namedEntry(document.clusters, clusterName, "cluster");
  if (cluster["insecure-skip-tls-verify"] === true || Object.keys(cluster).some((key) =>
    key !== "server" && key !== "certificate-authority-data")) {
    invalid("Kubeconfig cluster contains unsupported or insecure TLS fields");
  }
  const user = namedEntry(document.users, userName, "user");
  if (Object.keys(user).some((key) => key !== "token")) {
    invalid("Kubeconfig user must use an inline bearer token; exec, auth-provider, files, and client credentials are rejected");
  }
  return {
    server: serverUrl(cluster.server),
    token: safeToken(user.token),
    certificateAuthorityPem: certificateAuthorityData(cluster["certificate-authority-data"]),
  };
}

export function resolveTrustedKubernetesConnection(
  input: TrustedKubernetesConnection,
): ResolvedKubernetesConnection {
  if (input.trust !== "server-side" || !ID.test(input.clusterId)) invalid("Trusted Kubernetes connection metadata is invalid");
  const clusterName = safeName(input.clusterName, "Kubernetes cluster name");
  const resolved = input.auth.kind === "kubeconfig"
    ? resolveKubeconfig(input.auth.document, input.auth.contextName)
    : {
        server: serverUrl(input.serverUrl),
        token: safeToken(input.auth.token),
        certificateAuthorityPem: safeCaPem(input.auth.certificateAuthorityPem),
      };
  if (input.auth.kind === "kubeconfig" && input.serverUrl !== undefined) {
    invalid("A kubeconfig connection cannot override its selected API server");
  }
  return { clusterId: input.clusterId, clusterName, ...resolved };
}
