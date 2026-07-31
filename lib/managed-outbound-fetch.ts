import {
  createManagedOutboundFetch,
  ManagedOutboundClientConfigurationError,
  type ManagedOutboundClientEnvironment,
  type ManagedOutboundClientRuntime,
} from "../services/managed-outbound-gateway/client.ts";

export type ManagedOutboundEnvironment = ManagedOutboundClientEnvironment;
export { ManagedOutboundClientConfigurationError };

/**
 * Select the fixed-destination signed gateway only when its complete
 * three-value client configuration is present. An injected fetch is always
 * retained for unit tests and explicitly local callers. A partially populated
 * managed configuration is an operator error and must never fall back to
 * unrestricted network egress.
 */
export function productionOutboundFetch(
  environment: ManagedOutboundEnvironment,
  injectedFetch?: typeof fetch,
  runtime: ManagedOutboundClientRuntime = {},
): typeof fetch {
  const values = [
    environment.SUTRA_MANAGED_OUTBOUND_URL,
    environment.SUTRA_MANAGED_OUTBOUND_KEY_ID,
    environment.SUTRA_MANAGED_OUTBOUND_PRIVATE_KEY,
  ];
  const supplied = values.map((value) => value !== undefined);
  if (!supplied.some(Boolean)) return injectedFetch ?? fetch;
  if (
    !supplied.every(Boolean) ||
    values.some((value) => value?.trim().length === 0)
  ) {
    throw new ManagedOutboundClientConfigurationError();
  }
  if (injectedFetch !== undefined) return injectedFetch;
  return createManagedOutboundFetch(environment, runtime);
}

/**
 * Production delivery workloads must never regain direct internet egress when
 * the gateway tuple is absent. Explicit injected transports remain available
 * for isolated tests and local harnesses.
 */
export function requiredManagedOutboundFetch(
  environment: ManagedOutboundEnvironment,
  injectedFetch?: typeof fetch,
  runtime: ManagedOutboundClientRuntime = {},
): typeof fetch {
  if (injectedFetch !== undefined) return injectedFetch;
  const values = [
    environment.SUTRA_MANAGED_OUTBOUND_URL,
    environment.SUTRA_MANAGED_OUTBOUND_KEY_ID,
    environment.SUTRA_MANAGED_OUTBOUND_PRIVATE_KEY,
  ];
  if (
    !values.every((value) => value !== undefined && value.trim().length > 0)
  ) {
    throw new ManagedOutboundClientConfigurationError();
  }
  return createManagedOutboundFetch(environment, runtime);
}
