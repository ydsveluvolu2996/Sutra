import type {
  NotificationDestination,
  NotificationOutboxJob,
  NotificationOutboxStatus,
} from "./notification-destination-types.ts";

export type NotificationDeliveryHealthState =
  | "not_configured"
  | "healthy"
  | "degraded"
  | "blocked";

export interface NotificationDeliveryHealth {
  readonly state: NotificationDeliveryHealthState;
  readonly enabledDestinations: number;
  readonly configuredDestinations: number;
  readonly queued: number;
  readonly processing: number;
  readonly retrying: number;
  readonly providerAccepted: number;
  readonly deliveryDelayed: number;
  readonly delivered: number;
  readonly deliveryFailed: number;
  readonly deadLetter: number;
  readonly adapterMissing: number;
  readonly oldestActionableAgeSeconds: number | null;
  readonly message: string;
}

const ACTIONABLE = new Set<NotificationOutboxStatus>([
  "pending",
  "processing",
  "provider_accepted",
  "retry_scheduled",
]);

/**
 * Configuration alone is not provider-delivery evidence. An enabled
 * destination becomes adapter-ready only after the worker has delivered a job
 * for the current saved destination version.
 */
export function withObservedNotificationReadiness(
  destinations: readonly NotificationDestination[],
  jobs: readonly NotificationOutboxJob[],
  workerConfigured: boolean,
): readonly NotificationDestination[] {
  return destinations.map((destination) => {
    const destinationUpdatedAt = Date.parse(destination.updatedAt);
    const observedDelivery = Number.isFinite(destinationUpdatedAt) && jobs.some((job) =>
      job.destinationId === destination.id &&
      job.status === "delivered" &&
      job.deliveredAt !== null &&
      Date.parse(job.deliveredAt) >= destinationUpdatedAt);
    return {
      ...destination,
      deliveryReadiness:
        workerConfigured && observedDelivery
          ? "configured" as const
          : "adapter_not_configured" as const,
    };
  });
}

export function assessNotificationDeliveryHealth(input: {
  readonly destinations: readonly NotificationDestination[];
  readonly jobs: readonly NotificationOutboxJob[];
  readonly workerConfigured: boolean;
  readonly now?: number;
}): NotificationDeliveryHealth {
  const now = input.now ?? Date.now();
  const enabled = input.destinations.filter((destination) => destination.enabled);
  const counts = new Map<NotificationOutboxStatus, number>();
  for (const job of input.jobs) counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
  const actionable = input.jobs.filter((job) => ACTIONABLE.has(job.status));
  const oldestActionableAgeSeconds = actionable.length === 0
    ? null
    : Math.max(0, Math.floor((now - Math.min(...actionable.map((job) => Date.parse(job.createdAt)))) / 1_000));
  const adapterMissing = counts.get("not_configured") ?? 0;
  const deadLetter = counts.get("dead_letter") ?? 0;
  const deliveryFailed = counts.get("delivery_failed") ?? 0;
  const retrying = counts.get("retry_scheduled") ?? 0;
  const deliveryDelayed = input.jobs.filter(
    (job) =>
      job.status === "provider_accepted" &&
      job.lastErrorCode === "SES_DELIVERY_DELAY",
  ).length;
  const configuredDestinations = enabled.filter(
    (destination) => destination.deliveryReadiness === "configured",
  ).length;

  let state: NotificationDeliveryHealthState;
  let message: string;
  if (enabled.length === 0) {
    state = "not_configured";
    message = "No enabled customer destination is configured.";
  } else if (!input.workerConfigured || configuredDestinations < enabled.length || adapterMissing > 0) {
    state = "blocked";
    message = "Delivery is durably queued, but one or more provider adapters are not configured.";
  } else if (
    deadLetter > 0 ||
    deliveryFailed > 0 ||
    deliveryDelayed > 0 ||
    retrying > 0 ||
    (oldestActionableAgeSeconds ?? 0) > 300
  ) {
    state = "degraded";
    message = "Delivery requires operator attention because jobs are delayed, retrying, failed, or dead-lettered.";
  } else {
    state = "healthy";
    message = "The worker and enabled destinations are ready, with no delayed or failed job observed.";
  }

  return {
    state,
    enabledDestinations: enabled.length,
    configuredDestinations,
    queued: counts.get("pending") ?? 0,
    processing: counts.get("processing") ?? 0,
    retrying,
    providerAccepted: counts.get("provider_accepted") ?? 0,
    deliveryDelayed,
    delivered: counts.get("delivered") ?? 0,
    deliveryFailed,
    deadLetter,
    adapterMissing,
    oldestActionableAgeSeconds,
    message,
  };
}
