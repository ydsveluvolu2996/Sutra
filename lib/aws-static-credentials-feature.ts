/**
 * This compile-time review gate records that the reference-only AWS Secrets
 * Manager backend is present. Deployments still have to opt in with the exact
 * runtime flag, so older or partially updated hosts remain fail-closed.
 */
export const AWS_STATIC_KEYS_SECRETS_MANAGER_BACKEND_READY = true;

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
    new Error("Access-key onboarding is unavailable unless this deployment enables the reviewed AWS Secrets Manager storage boundary"),
    { code: "INVALID_STATE" },
  );
}
