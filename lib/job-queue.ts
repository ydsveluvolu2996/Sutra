export type JobFailureDisposition = "retry" | "dead-letter";

export interface JobAttemptLike {
  readonly attempt: number;
  readonly maxAttempts: number;
}

export function classify(job: JobAttemptLike): JobFailureDisposition {
  if (!Number.isSafeInteger(job.attempt) || !Number.isSafeInteger(job.maxAttempts) || job.attempt < 1 || job.maxAttempts < 1) {
    throw Object.assign(new Error("The job attempt state is invalid"), { code: "INVALID_INPUT" });
  }
  return job.attempt >= job.maxAttempts ? "dead-letter" : "retry";
}

export function decideNextAttempt(input: {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly nowMs: number;
}): { readonly kind: "retry-at"; readonly runAfterMs: number } | { readonly kind: "dead-letter" } {
  const disposition = classify(input);
  if (
    !Number.isSafeInteger(input.baseDelayMs) || input.baseDelayMs < 1 || input.baseDelayMs > 24 * 60 * 60 * 1_000 ||
    !Number.isFinite(input.nowMs)
  ) throw Object.assign(new Error("The job retry policy is invalid"), { code: "INVALID_INPUT" });
  if (disposition === "dead-letter") return { kind: "dead-letter" };
  const exponent = Math.min(input.attempt - 1, 20);
  const delay = Math.min(input.baseDelayMs * (2 ** exponent), 7 * 24 * 60 * 60 * 1_000);
  return { kind: "retry-at", runAfterMs: input.nowMs + delay };
}
