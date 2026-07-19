export function isRecentMfaVerification(
  verifiedAt: number | null,
  now: number,
  maximumAgeMs: number,
): boolean {
  return verifiedAt !== null &&
    Number.isFinite(verifiedAt) &&
    Number.isFinite(now) &&
    Number.isFinite(maximumAgeMs) &&
    maximumAgeMs >= 0 &&
    verifiedAt <= now &&
    now - verifiedAt <= maximumAgeMs;
}
