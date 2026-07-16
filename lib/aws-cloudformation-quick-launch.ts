import {
  AWS_CUSTOMER_ROLE_TEMPLATE_SHA256,
  AWS_CUSTOMER_ROLE_TEMPLATE_VERSION,
} from "./aws-template-contract.ts";

const AWS_CONSOLE_ORIGIN = "https://console.aws.amazon.com";
const MAX_TEMPLATE_URL_LENGTH = 1_024;
const PUBLIC_TEMPLATE_FETCH_TIMEOUT_MS = 5_000;
export const AWS_CUSTOMER_ROLE_TEMPLATE_MAX_BYTES = 64 * 1_024;
const DECIMAL_CONTENT_LENGTH = /^(?:0|[1-9][0-9]*)$/u;
const PUBLIC_TEMPLATE_VERIFICATION_MESSAGE =
  "The reviewed AWS onboarding template could not be verified";
const COMMERCIAL_REGION = /^(?!us-gov-)(?:af|ap|ca|eu|il|me|mx|sa|us)-[a-z0-9]+(?:-[a-z0-9]+)*-[1-9][0-9]*$/u;
const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/u;
const COMMERCIAL_IAM_ROLE_ARN = /^arn:aws:iam::[0-9]{12}:role\/[A-Za-z0-9_+=,.@\/-]+$/u;
const EXTERNAL_ID = /^[A-Za-z0-9+=,.@:/_-]{20,128}$/u;
const SESSION_NAME_PREFIX = /^[A-Za-z0-9+=,.@_-]{3,32}$/u;
const CUSTOMER_TENANT_ID = /^[A-Za-z0-9._:-]{3,64}$/u;

export const AWS_CUSTOMER_ROLE_TEMPLATE_URL_ENV = "SUTRA_CUSTOMER_ROLE_TEMPLATE_URL" as const;

export class PublicCustomerRoleTemplateVerificationError extends Error {
  public readonly code = "INVALID_STATE" as const;
  public readonly status = 503 as const;

  public constructor() {
    super(PUBLIC_TEMPLATE_VERIFICATION_MESSAGE);
    this.name = "PublicCustomerRoleTemplateVerificationError";
  }
}

export interface PublicTemplateVerificationOptions {
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface OneTimeCloudFormationLaunchInput {
  readonly handoffVisible: boolean;
  readonly partition: string;
  readonly templateUrl: string | null;
  readonly region: string;
  readonly stackName: string;
  readonly externalId: string | null;
  readonly vendorCollectorRoleArn: string | null;
  readonly sessionNamePrefix: string;
  readonly customerTenantId: string;
  readonly roleName: string;
}

function isCommercialRegion(value: string): boolean {
  return COMMERCIAL_REGION.test(value) && !value.includes("--");
}

function templateBucketRegion(url: URL): string | null {
  const pathStyle = /^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/u.exec(url.hostname);
  if (pathStyle?.[1] !== undefined) {
    const pathParts = url.pathname.split("/").filter(Boolean);
    return pathParts.length >= 2 ? pathStyle[1] : null;
  }

  const virtualHosted = /^([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\.s3\.([a-z0-9-]+)\.amazonaws\.com$/u.exec(url.hostname);
  if (virtualHosted?.[2] === undefined || url.pathname === "/") return null;
  return virtualHosted[2];
}

/**
 * Validates the operator-provided public artifact URL before it is returned to
 * a browser. Quick-create supports regional S3 HTTPS URLs; signed, website,
 * non-commercial, credential-bearing, and fragment-bearing URLs fail closed.
 */
export function parsePublicCustomerRoleTemplateUrl(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (value !== value.trim() || value.length > MAX_TEMPLATE_URL_LENGTH || /[\0\r\n]/u.test(value)) {
    throw new Error(`${AWS_CUSTOMER_ROLE_TEMPLATE_URL_ENV} must be a single HTTPS S3 URL`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${AWS_CUSTOMER_ROLE_TEMPLATE_URL_ENV} must be a valid HTTPS S3 URL`);
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== ""
  ) {
    throw new Error(`${AWS_CUSTOMER_ROLE_TEMPLATE_URL_ENV} must be a public HTTPS S3 URL without credentials, a custom port, or a fragment`);
  }

  const queryEntries = [...url.searchParams.entries()];
  if (
    queryEntries.length !== 1 ||
    queryEntries[0]?.[0] !== "versionId" ||
    queryEntries[0][1] === "" ||
    queryEntries[0][1] === "null"
  ) {
    throw new Error(`${AWS_CUSTOMER_ROLE_TEMPLATE_URL_ENV} must contain exactly one immutable, non-null versionId query parameter`);
  }

  const region = templateBucketRegion(url);
  if (region === null || !isCommercialRegion(region)) {
    throw new Error(`${AWS_CUSTOMER_ROLE_TEMPLATE_URL_ENV} must use a supported regional commercial-AWS S3 URL`);
  }
  const expectedPathSuffix =
    `/templates/${AWS_CUSTOMER_ROLE_TEMPLATE_VERSION}/${AWS_CUSTOMER_ROLE_TEMPLATE_SHA256}.yaml`;
  if (!url.pathname.endsWith(expectedPathSuffix)) {
    throw new Error(
      `${AWS_CUSTOMER_ROLE_TEMPLATE_URL_ENV} must reference the exact reviewed template version and SHA-256 path`,
    );
  }

  const normalized = url.toString();
  if (normalized.length > MAX_TEMPLATE_URL_LENGTH) {
    throw new Error(`${AWS_CUSTOMER_ROLE_TEMPLATE_URL_ENV} exceeds the CloudFormation quick-create URL limit`);
  }
  return normalized;
}

function verificationFailure(): PublicCustomerRoleTemplateVerificationError {
  return new PublicCustomerRoleTemplateVerificationError();
}

function parseTemplateContentLength(response: Response): number {
  const value = response.headers.get("content-length");
  if (value === null || !DECIMAL_CONTENT_LENGTH.test(value)) throw verificationFailure();
  const length = Number(value);
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > AWS_CUSTOMER_ROLE_TEMPLATE_MAX_BYTES
  ) {
    throw verificationFailure();
  }
  return length;
}

async function readExactTemplateBytes(
  response: Response,
  declaredLength: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (response.body === null) throw verificationFailure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let observedLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value.byteLength === 0) continue;
    observedLength += value.byteLength;
    if (
      observedLength > declaredLength ||
      observedLength > AWS_CUSTOMER_ROLE_TEMPLATE_MAX_BYTES
    ) {
      try {
        await reader.cancel();
      } catch {
        // The verification failure below is authoritative; cancellation is best effort.
      }
      throw verificationFailure();
    }
    chunks.push(value);
  }

  if (observedLength !== declaredLength) throw verificationFailure();
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(observedLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Downloads the immutable public S3 object without credentials or redirects
 * and verifies the exact response bytes against the reviewed repository hash.
 * Every failure is deliberately opaque so the URL and future trust values
 * cannot be reflected into API responses or local diagnostic logs.
 */
export async function verifyPublicCustomerRoleTemplate(
  templateUrl: string,
  options: PublicTemplateVerificationOptions = {},
): Promise<void> {
  const normalizedUrl = parsePublicCustomerRoleTemplateUrl(templateUrl);
  if (normalizedUrl === null) throw verificationFailure();
  const timeoutMs = options.timeoutMs ?? PUBLIC_TEMPLATE_FETCH_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > PUBLIC_TEMPLATE_FETCH_TIMEOUT_MS) {
    throw verificationFailure();
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(verificationFailure());
    }, timeoutMs);
  });

  const verify = async (): Promise<void> => {
    const response = await (options.fetcher ?? globalThis.fetch)(normalizedUrl, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        accept: "application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.1",
        "accept-encoding": "identity",
      },
    });
    if (!response.ok || response.redirected) throw verificationFailure();
    const contentEncoding = response.headers.get("content-encoding");
    if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") {
      throw verificationFailure();
    }
    const declaredLength = parseTemplateContentLength(response);
    const bytes = await readExactTemplateBytes(response, declaredLength);
    const observedSha256 = toHex(await crypto.subtle.digest("SHA-256", bytes));
    if (observedSha256 !== AWS_CUSTOMER_ROLE_TEMPLATE_SHA256) throw verificationFailure();
  };

  try {
    await Promise.race([verify(), deadline]);
  } catch {
    throw verificationFailure();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    controller.abort();
  }
}

/**
 * Keeps template verification outside the connection-creation transaction.
 * The callback cannot generate or commit an ExternalId unless the configured
 * immutable artifact has first passed byte-for-byte authenticity verification.
 */
export async function withVerifiedPublicCustomerRoleTemplate<T>(
  value: string | null | undefined,
  operation: (verifiedTemplateUrl: string | null) => Promise<T>,
  options: PublicTemplateVerificationOptions = {},
): Promise<T> {
  const templateUrl = parsePublicCustomerRoleTemplateUrl(value);
  if (templateUrl !== null) await verifyPublicCustomerRoleTemplate(templateUrl, options);
  return operation(templateUrl);
}

export function selectCommercialQuickCreateRegion(enabledRegions: readonly string[]): string {
  return enabledRegions.find(isCommercialRegion) ?? "us-east-1";
}

function assertLaunchValue(condition: boolean, label: string): asserts condition {
  if (!condition) throw new Error(`CloudFormation quick-create ${label} is invalid`);
}

/**
 * Constructs an AWS Console quick-create URL only for the active, one-time
 * handoff. All trust parameters live after '#', so they are not sent to the
 * Sutra server or AWS Console HTTP endpoint. The browser may retain a visited
 * fragment in local history, which the UI explicitly warns the operator about.
 */
export function buildOneTimeCloudFormationQuickCreateUrl(
  input: OneTimeCloudFormationLaunchInput,
): string | null {
  if (
    !input.handoffVisible ||
    input.partition !== "aws" ||
    input.templateUrl === null ||
    input.externalId === null ||
    input.vendorCollectorRoleArn === null
  ) {
    return null;
  }

  const templateUrl = parsePublicCustomerRoleTemplateUrl(input.templateUrl);
  assertLaunchValue(templateUrl !== null, "template URL");
  assertLaunchValue(isCommercialRegion(input.region), "Region");
  assertLaunchValue(STACK_NAME.test(input.stackName), "stack name");
  assertLaunchValue(
    COMMERCIAL_IAM_ROLE_ARN.test(input.vendorCollectorRoleArn) &&
      !input.vendorCollectorRoleArn.includes("//") &&
      !input.vendorCollectorRoleArn.endsWith("/"),
    "collector principal",
  );
  assertLaunchValue(EXTERNAL_ID.test(input.externalId), "ExternalId");
  assertLaunchValue(SESSION_NAME_PREFIX.test(input.sessionNamePrefix), "session prefix");
  assertLaunchValue(CUSTOMER_TENANT_ID.test(input.customerTenantId), "customer tenant ID");
  assertLaunchValue(input.roleName === "SutraReadOnlyRole", "role name");

  const fragment = new URLSearchParams();
  fragment.set("templateURL", templateUrl);
  fragment.set("stackName", input.stackName);
  fragment.set("param_VendorCollectorRoleArn", input.vendorCollectorRoleArn);
  fragment.set("param_ExternalId", input.externalId);
  fragment.set("param_SessionNamePrefix", input.sessionNamePrefix);
  fragment.set("param_CustomerTenantId", input.customerTenantId);
  fragment.set("param_RoleName", input.roleName);

  const consoleUrl = new URL("/cloudformation/home", AWS_CONSOLE_ORIGIN);
  consoleUrl.searchParams.set("region", input.region);
  consoleUrl.hash = `/stacks/quickcreate?${fragment.toString()}`;
  return consoleUrl.toString();
}
