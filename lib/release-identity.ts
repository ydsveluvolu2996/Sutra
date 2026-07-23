export const RELEASE_IMAGE_HEADER = "X-Sutra-Release-Image";

const IMMUTABLE_SUTRA_ECR_IMAGE =
  /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com\/sutra\/app@sha256:[a-f0-9]{64}$/u;

/**
 * Validate the non-secret immutable image identity exposed by a deployed
 * release. Local development may omit it; a supplied value must always be an
 * exact account-local-style ECR digest reference for Sutra's one application
 * repository. Mutable tags, alternate repositories and control characters are
 * rejected before the value can reach a response header.
 */
export function validatedReleaseImage(value: string | undefined): string | null {
  if (value === undefined || value.length === 0) return null;
  if (value !== value.trim() || !IMMUTABLE_SUTRA_ECR_IMAGE.test(value)) {
    throw new Error("SUTRA_RELEASE_IMAGE must be an immutable sutra/app ECR digest reference");
  }
  return value;
}
