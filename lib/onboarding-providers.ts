/**
 * The cloud providers offered on the "Connect your infrastructure" hub.
 *
 * Dependency-free so the welcome flow, the connect hub and the tests all read
 * the same catalog without dragging runtime bindings into the browser bundle.
 *
 * Availability is a fact about Sutra, not a marketing position. A provider is
 * `available` only when a collector actually exists behind it, and today that
 * is AWS alone -- ADD-02 Azure and ADD-03 GCP are excluded from this release
 * and Oracle has no collector at all. The unavailable cards are still rendered,
 * in the same grid and at the same size, because hiding them would misstate the
 * roadmap while a live Connect button would misstate the product. Each one says
 * why instead.
 *
 * `capability` describes what the connection really does. There are no object
 * counts here: Sutra does not publish a supported-object total, and inventing
 * one to fill the slot would be a claim no test could pin.
 */
export const CLOUD_PROVIDER_IDS = Object.freeze(["aws", "azure", "gcp", "oracle"] as const);

export type CloudProviderId = (typeof CLOUD_PROVIDER_IDS)[number];

export interface CloudProviderCard {
  readonly id: CloudProviderId;
  readonly name: string;
  /** Short label under the mark, e.g. "Amazon Web Services". */
  readonly shortName: string;
  /** What connecting this provider actually gives the customer. */
  readonly capability: string;
  /** Where "Connect" goes. `null` means no live path exists. */
  readonly connectHref: string | null;
  /** Why the provider cannot be connected yet. `null` when it can. */
  readonly unavailableReason: string | null;
}

export const CLOUD_PROVIDERS: readonly CloudProviderCard[] = Object.freeze([
  {
    id: "aws",
    name: "AWS",
    shortName: "Amazon Web Services",
    capability:
      "Read-only inventory, cost and security posture across every account-enabled Region.",
    connectHref: "/onboard",
    unavailableReason: null,
  },
  {
    id: "azure",
    name: "Azure",
    shortName: "Microsoft Azure",
    capability: "Subscription inventory and cost, once the Azure collector ships.",
    connectHref: null,
    unavailableReason: "No Azure collector runs yet, so Sutra cannot read an Azure subscription.",
  },
  {
    id: "gcp",
    name: "Google Cloud",
    shortName: "Google Cloud Platform",
    capability: "Project inventory and billing export, once the GCP collector ships.",
    connectHref: null,
    unavailableReason: "No GCP collector runs yet, so Sutra cannot read a Google Cloud project.",
  },
  {
    id: "oracle",
    name: "Oracle",
    shortName: "Oracle Cloud Infrastructure",
    capability: "Compartment inventory, once the OCI collector ships.",
    connectHref: null,
    unavailableReason: "No OCI collector runs yet, so Sutra cannot read an Oracle tenancy.",
  },
] as const);

export function findCloudProvider(id: string): CloudProviderCard | null {
  return CLOUD_PROVIDERS.find((provider) => provider.id === id) ?? null;
}
