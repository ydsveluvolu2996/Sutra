/**
 * AWS connection source kinds whose persisted collection output is readable by
 * customer-scoped dashboard and posture routes.
 *
 * Both kinds reach AWS through the collector and land their results in the same
 * org/customer/connection-scoped tables, so a route that only reads persisted
 * output must not discriminate between them. The distinction that matters to a
 * reader is whether the connection is a real AWS connection at all: a
 * `simulated_fixture` carries demo data and is deliberately excluded here so a
 * fixture can never be mistaken for collected customer evidence.
 *
 * How each kind authenticates to AWS is a collector concern, not a route
 * concern. `aws_trust_role` assumes a customer-owned role with an external ID;
 * `aws_static_credentials` uses customer-supplied keys held encrypted by the
 * collector. Neither credential path is reachable from these routes.
 */
export const AWS_COLLECTABLE_SOURCE_KINDS = Object.freeze([
  "aws_trust_role",
  "aws_static_credentials",
] as const);

export type AwsCollectableSourceKind =
  typeof AWS_COLLECTABLE_SOURCE_KINDS[number];

/**
 * True when the source kind is a real AWS connection whose collected output may
 * be read by a customer-scoped route.
 *
 * This is a source-kind check only. It is never an authorization decision:
 * callers must still resolve the connection inside the authenticated
 * organization and assert the session capability against its customer.
 */
// The parameter is widened to `string` rather than importing the connection
// type: `db/pilot-repository` calls this helper, so importing its type here
// would close an import cycle.
export function isCollectableAwsSourceKind(
  sourceKind: string,
): sourceKind is AwsCollectableSourceKind {
  return (AWS_COLLECTABLE_SOURCE_KINDS as readonly string[]).includes(sourceKind);
}
