const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u;
const SAFE_IDENTIFIER = /^[A-Za-z0-9._-]{3,512}$/u;
const ACCOUNT_ID = /^[0-9]{4,32}$/u;
const ACCESS_TOKEN = /^[A-Za-z0-9._-]{20,2048}$/u;
const MAX_TOKEN_RESPONSE_BYTES = 32 * 1024;
const MAX_CONTENT_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

const DATA_CENTERS = {
  us: {
    accounts: "https://accounts.zoho.com",
    mail: "https://mail.zoho.com",
  },
  eu: {
    accounts: "https://accounts.zoho.eu",
    mail: "https://mail.zoho.eu",
  },
  in: {
    accounts: "https://accounts.zoho.in",
    mail: "https://mail.zoho.in",
  },
  au: {
    accounts: "https://accounts.zoho.com.au",
    mail: "https://mail.zoho.com.au",
  },
  jp: {
    accounts: "https://accounts.zoho.jp",
    mail: "https://mail.zoho.jp",
  },
  ca: {
    accounts: "https://accounts.zohocloud.ca",
    mail: "https://mail.zohocloud.ca",
  },
  cn: {
    accounts: "https://accounts.zoho.com.cn",
    mail: "https://mail.zoho.com.cn",
  },
  ae: {
    accounts: "https://accounts.zoho.ae",
    mail: "https://mail.zoho.ae",
  },
  sa: {
    accounts: "https://accounts.zoho.sa",
    mail: "https://mail.zoho.sa",
  },
} as const;

export type ZohoDataCenter = keyof typeof DATA_CENTERS;

export interface ZohoMailEnvironment {
  readonly SUTRA_ZOHO_DATACENTER?: string;
  readonly SUTRA_ZOHO_MAIL_ACCOUNT_ID?: string;
  readonly SUTRA_ZOHO_CLIENT_ID?: string;
  readonly SUTRA_ZOHO_CLIENT_SECRET?: string;
  readonly SUTRA_ZOHO_REFRESH_TOKEN?: string;
}

export interface ZohoMailMessage {
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly subject: string;
  readonly content: string;
}

export interface ZohoMailDeliveryResult {
  readonly status: "accepted" | "failed" | "unknown";
  readonly errorCode:
    | "EMAIL_NOT_CONFIGURED"
    | "EMAIL_CONFIGURATION_INVALID"
    | "PROVIDER_AUTHENTICATION_FAILED"
    | "PROVIDER_RATE_LIMITED"
    | "PROVIDER_UNAVAILABLE"
    | "PROVIDER_REJECTED"
    | "PROVIDER_RESULT_UNKNOWN"
    | null;
  readonly httpStatus: number | null;
}

export interface ResolvedZohoMailConfiguration {
  readonly tokenEndpoint: string;
  readonly sendEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

function singleLine(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && !/[\u0000-\u001f\u007f]/u.test(trimmed) ? trimmed : null;
}

export function resolveZohoMailConfiguration(
  environment: ZohoMailEnvironment,
): ResolvedZohoMailConfiguration | null {
  const dataCenter = singleLine(environment.SUTRA_ZOHO_DATACENTER);
  const accountId = singleLine(environment.SUTRA_ZOHO_MAIL_ACCOUNT_ID);
  const clientId = singleLine(environment.SUTRA_ZOHO_CLIENT_ID);
  const clientSecret = singleLine(environment.SUTRA_ZOHO_CLIENT_SECRET);
  const refreshToken = singleLine(environment.SUTRA_ZOHO_REFRESH_TOKEN);
  if (
    dataCenter === null ||
    !(dataCenter in DATA_CENTERS) ||
    accountId === null ||
    !ACCOUNT_ID.test(accountId) ||
    clientId === null ||
    !SAFE_IDENTIFIER.test(clientId) ||
    clientSecret === null ||
    clientSecret.length < 8 ||
    clientSecret.length > 512 ||
    refreshToken === null ||
    !ACCESS_TOKEN.test(refreshToken)
  ) {
    return null;
  }
  const regional = DATA_CENTERS[dataCenter as ZohoDataCenter];
  return {
    tokenEndpoint: `${regional.accounts}/oauth/v2/token`,
    sendEndpoint: `${regional.mail}/api/accounts/${accountId}/messages`,
    clientId,
    clientSecret,
    refreshToken,
  };
}

function validMessage(message: ZohoMailMessage): boolean {
  return (
    EMAIL.test(message.fromAddress) &&
    EMAIL.test(message.toAddress) &&
    !/[\u0000-\u001f\u007f]/u.test(message.fromAddress) &&
    !/[\u0000-\u001f\u007f]/u.test(message.toAddress) &&
    message.subject.length > 0 &&
    message.subject.length <= 200 &&
    !/[\u0000-\u001f\u007f]/u.test(message.subject) &&
    message.content.length > 0 &&
    new TextEncoder().encode(message.content).length <= MAX_CONTENT_BYTES
  );
}

function classifiedFailure(status: number): ZohoMailDeliveryResult {
  return {
    status: "failed",
    errorCode:
      status === 401 || status === 403
        ? "PROVIDER_AUTHENTICATION_FAILED"
        : status === 429
          ? "PROVIDER_RATE_LIMITED"
          : status >= 500
            ? "PROVIDER_UNAVAILABLE"
            : "PROVIDER_REJECTED",
    httpStatus: status,
  };
}

async function accessToken(response: Response): Promise<string | null> {
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return null;
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_TOKEN_RESPONSE_BYTES) return null;
  const source = await response.text();
  if (new TextEncoder().encode(source).length > MAX_TOKEN_RESPONSE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const token = (value as Record<string, unknown>).access_token;
  return typeof token === "string" && ACCESS_TOKEN.test(token) ? token : null;
}

/**
 * Send one plaintext message through the regional Zoho Mail REST API.
 *
 * The long-lived refresh token and client secret stay in managed runtime
 * configuration. A short-lived access token is minted for each send and is
 * neither returned nor persisted.
 */
export async function sendZohoMail(
  environment: ZohoMailEnvironment,
  message: ZohoMailMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<ZohoMailDeliveryResult> {
  const configuration = resolveZohoMailConfiguration(environment);
  if (configuration === null) {
    return {
      status: "failed",
      errorCode: "EMAIL_NOT_CONFIGURED",
      httpStatus: null,
    };
  }
  if (!validMessage(message)) {
    return {
      status: "failed",
      errorCode: "EMAIL_CONFIGURATION_INVALID",
      httpStatus: null,
    };
  }

  try {
    const tokenResponse = await fetchImpl(configuration.tokenEndpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: configuration.clientId,
        client_secret: configuration.clientSecret,
        refresh_token: configuration.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!tokenResponse.ok) return classifiedFailure(tokenResponse.status);
    const token = await accessToken(tokenResponse);
    if (token === null) return classifiedFailure(401);

    const response = await fetchImpl(configuration.sendEndpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Zoho-oauthtoken ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        fromAddress: message.fromAddress,
        toAddress: message.toAddress,
        subject: message.subject,
        content: message.content,
        mailFormat: "plaintext",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return classifiedFailure(response.status);
    return { status: "accepted", errorCode: null, httpStatus: response.status };
  } catch {
    return {
      status: "unknown",
      errorCode: "PROVIDER_RESULT_UNKNOWN",
      httpStatus: null,
    };
  }
}
