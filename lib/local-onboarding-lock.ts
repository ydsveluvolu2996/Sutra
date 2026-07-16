import type { AwsPartition } from "./pilot-types";

const accountTails = new Map<string, Promise<void>>();

/**
 * Serializes the local pilot's create/recover and role-registration handoffs
 * for one AWS account. Database identities still enforce create concurrency;
 * this process lock closes the response-vs-role race so an ExternalId cannot
 * be returned after role registration in the single local application process.
 */
export async function withLocalOnboardingAccountLock<T>(
  partition: AwsPartition,
  accountId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${partition}:${accountId}`;
  const previous = accountTails.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  accountTails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (accountTails.get(key) === tail) accountTails.delete(key);
  }
}
