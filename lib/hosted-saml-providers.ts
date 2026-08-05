export interface HostedSamlProviderConfig {
  readonly id: string;
  readonly label: string;
  /** Immutable Sutra tenant namespace expected in the signed assertion. */
  readonly tenantId: string;
  /** Exact SAML IdP EntityID / assertion Issuer. */
  readonly entityId: string;
  /** HTTP-Redirect SingleSignOnService location from IdP metadata. */
  readonly ssoUrl: string;
  /** Base64 DER X.509 certificates from IdP metadata, current first. */
  readonly signingCertificates: readonly string[];
  readonly tenantAttribute: string;
  readonly emailAttribute: string;
  readonly displayNameAttribute?: string;
  readonly nameIdFormat:
    | "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
    | "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"
    | "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified";
}

export interface HostedSamlProvidersResult {
  readonly providers: readonly HostedSamlProviderConfig[];
  readonly issues: readonly string[];
}

const PROVIDER_ID = /^[a-z][a-z0-9_-]{1,31}$/u;
const TENANT_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const BASE64_DER = /^[A-Za-z0-9+/]+={0,2}$/u;
const MAX_RAW_BYTES = 48 * 1024;
const MAX_PROVIDERS = 8;
const NAME_ID_FORMATS = new Set<HostedSamlProviderConfig["nameIdFormat"]>([
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
]);
const REQUIRED_KEYS = [
  "emailAttribute",
  "entityId",
  "id",
  "label",
  "nameIdFormat",
  "signingCertificates",
  "ssoUrl",
  "tenantAttribute",
  "tenantId",
] as const;
const OPTIONAL_KEYS = ["displayNameAttribute"] as const;

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function exactHttpsUrl(value: unknown, allowQuery: boolean): boolean {
  if (!boundedText(value, 2048)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && !parsed.username
      && !parsed.password
      && !parsed.hash
      && (allowQuery || !parsed.search)
      && !isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function exactEntityId(value: unknown): boolean {
  if (!boundedText(value, 2048) || /\s/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (!new Set(["https:", "http:", "urn:"]).has(parsed.protocol)) return false;
    return parsed.protocol === "urn:" || (!parsed.username && !parsed.password);
  } catch {
    return false;
  }
}

function certificateIsBoundedDer(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length < 256
    || value.length > 16 * 1024
    || value.length % 4 !== 0
    || !BASE64_DER.test(value)
  ) return false;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    if (btoa(binary) !== value) return false;
    const read = (start: number): { readonly tag: number; readonly content: number; readonly end: number } | null => {
      if (start + 2 > bytes.length) return null;
      const tag = bytes[start] ?? -1;
      const first = bytes[start + 1] ?? -1;
      let length = first;
      let content = start + 2;
      if ((first & 0x80) !== 0) {
        const count = first & 0x7f;
        if (count < 1 || count > 4 || content + count > bytes.length || bytes[content] === 0) return null;
        length = 0;
        for (let index = 0; index < count; index += 1) length = length * 256 + (bytes[content + index] ?? 0);
        content += count;
        if (length < 128) return null;
      }
      const end = content + length;
      return Number.isSafeInteger(end) && end <= bytes.length ? { tag, content, end } : null;
    };
    const children = (parent: { readonly content: number; readonly end: number }) => {
      const values: NonNullable<ReturnType<typeof read>>[] = [];
      let offset = parent.content;
      while (offset < parent.end) {
        const child = read(offset);
        if (child === null || child.end > parent.end) return null;
        values.push(child);
        offset = child.end;
      }
      return offset === parent.end ? values : null;
    };
    const outer = read(0);
    if (outer?.tag !== 0x30 || outer.end !== bytes.length) return false;
    const certificate = children(outer);
    const tbs = certificate?.[0];
    if (certificate?.length !== 3 || tbs?.tag !== 0x30) return false;
    const fields = children(tbs);
    if (fields === null) return false;
    const versionOffset = fields[0]?.tag === 0xa0 ? 1 : 0;
    return fields.length >= versionOffset + 6 && fields[versionOffset + 5]?.tag === 0x30;
  } catch {
    return false;
  }
}

function parseProvider(
  value: unknown,
  index: number,
): { readonly provider: HostedSamlProviderConfig | null; readonly issues: readonly string[] } {
  const label = `SAML provider #${index + 1}`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { provider: null, issues: [`${label} must be a JSON object`] };
  }
  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);
  if (
    REQUIRED_KEYS.some((key) => !(key in candidate))
    || Object.keys(candidate).some((key) => !allowedKeys.has(key))
  ) {
    return { provider: null, issues: [`${label} has an invalid configuration shape`] };
  }
  const issues: string[] = [];
  if (typeof candidate.id !== "string" || !PROVIDER_ID.test(candidate.id)) {
    issues.push(`${label} id must be a short lowercase slug`);
  }
  if (!boundedText(candidate.label, 80)) issues.push(`${label} label is invalid`);
  if (typeof candidate.tenantId !== "string" || !TENANT_ID.test(candidate.tenantId)) {
    issues.push(`${label} tenantId is invalid`);
  }
  if (!exactEntityId(candidate.entityId)) {
    issues.push(`${label} entityId must be an exact HTTP(S) or URN EntityID`);
  }
  if (!exactHttpsUrl(candidate.ssoUrl, true)) {
    issues.push(`${label} ssoUrl must be a non-loopback HTTPS endpoint`);
  }
  if (
    !Array.isArray(candidate.signingCertificates)
    || candidate.signingCertificates.length < 1
    || candidate.signingCertificates.length > 3
    || candidate.signingCertificates.some((certificate) => !certificateIsBoundedDer(certificate))
  ) {
    issues.push(`${label} must provide one to three base64 DER signing certificates`);
  }
  if (!boundedText(candidate.tenantAttribute, 512)) issues.push(`${label} tenantAttribute is invalid`);
  if (!boundedText(candidate.emailAttribute, 512)) issues.push(`${label} emailAttribute is invalid`);
  if (candidate.displayNameAttribute !== undefined && !boundedText(candidate.displayNameAttribute, 512)) {
    issues.push(`${label} displayNameAttribute is invalid`);
  }
  if (
    typeof candidate.nameIdFormat !== "string"
    || !NAME_ID_FORMATS.has(candidate.nameIdFormat as HostedSamlProviderConfig["nameIdFormat"])
  ) {
    issues.push(`${label} nameIdFormat is unsupported`);
  }
  if (issues.length > 0) return { provider: null, issues };
  return {
    provider: {
      id: candidate.id as string,
      label: candidate.label as string,
      tenantId: candidate.tenantId as string,
      entityId: candidate.entityId as string,
      ssoUrl: candidate.ssoUrl as string,
      signingCertificates: candidate.signingCertificates as string[],
      tenantAttribute: candidate.tenantAttribute as string,
      emailAttribute: candidate.emailAttribute as string,
      ...(candidate.displayNameAttribute === undefined
        ? {}
        : { displayNameAttribute: candidate.displayNameAttribute as string }),
      nameIdFormat: candidate.nameIdFormat as HostedSamlProviderConfig["nameIdFormat"],
    },
    issues: [],
  };
}

/** SAML is optional while OIDC-only mode remains active; a present list is exact and fail-closed. */
export function parseHostedSamlProviders(raw: string | undefined): HostedSamlProvidersResult {
  const source = raw?.trim();
  if (!source) return { providers: [], issues: [] };
  if (new TextEncoder().encode(source).length > MAX_RAW_BYTES) {
    return { providers: [], issues: ["SUTRA_SAML_PROVIDERS is too large"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { providers: [], issues: ["SUTRA_SAML_PROVIDERS must be valid JSON"] };
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_PROVIDERS) {
    return { providers: [], issues: [`SUTRA_SAML_PROVIDERS must contain one to ${MAX_PROVIDERS} providers`] };
  }
  const providers: HostedSamlProviderConfig[] = [];
  const issues: string[] = [];
  const ids = new Set<string>();
  const tenantBindings = new Set<string>();
  parsed.forEach((entry, index) => {
    const result = parseProvider(entry, index);
    issues.push(...result.issues);
    if (result.provider === null) return;
    const binding = `${result.provider.tenantId}\0${result.provider.entityId}`;
    if (ids.has(result.provider.id)) issues.push(`SAML provider id "${result.provider.id}" is duplicated`);
    if (tenantBindings.has(binding)) issues.push(`SAML tenant and EntityID binding "${result.provider.tenantId}" is duplicated`);
    ids.add(result.provider.id);
    tenantBindings.add(binding);
    providers.push(result.provider);
  });
  return { providers, issues };
}

export function hostedSamlProviderIssues(raw: string | undefined): readonly string[] {
  return parseHostedSamlProviders(raw).issues;
}
