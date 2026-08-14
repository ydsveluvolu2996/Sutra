/**
 * Static AWS keys remain fail-closed until the reviewed backend stores only a
 * Secrets Manager reference in PostgreSQL and resolves the value at collector
 * execution time. The older collector-encrypted registry is intentionally not
 * sufficient for this feature gate.
 */
export const AWS_STATIC_KEYS_SECRETS_MANAGER_BACKEND_READY = false;

export interface AwsStaticCredentialsFeatureEnvironment {
  readonly [name: string]: string | undefined;
  readonly SUTRA_AWS_STATIC_KEYS_ENABLED?: string;
}

export function isAwsStaticCredentialsOnboardingEnabled(
  environment: AwsStaticCredentialsFeatureEnvironment = process.env,
): boolean {
  return environment.SUTRA_AWS_STATIC_KEYS_ENABLED === "true"
    && AWS_STATIC_KEYS_SECRETS_MANAGER_BACKEND_READY;
}

export function assertAwsStaticCredentialsOnboardingEnabled(
  environment: AwsStaticCredentialsFeatureEnvironment = process.env,
): void {
  if (isAwsStaticCredentialsOnboardingEnabled(environment)) return;
  throw Object.assign(
    new Error("Access-key onboarding is unavailable until the reviewed AWS Secrets Manager storage boundary is deployed"),
    { code: "INVALID_STATE" },
  );
}
