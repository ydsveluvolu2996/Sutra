// ─── DEPLOY ORDERING: PUBLISH BEFORE YOU SHIP ───────────────────────────────
//
// The S3 object key embeds this hash:
//   templates/${VERSION}/${SHA256}.yaml
//
// So ANY edit to infrastructure/customer-onboarding-role.yaml changes the hash,
// which changes the object key, which means the quick-create link this app hands
// customers points at an object that DOES NOT EXIST until it is published.
//
// Ship the app first and customer onboarding 404s. The required order is:
//
//   1. pnpm publish:onboarding-template   (needs AWS credentials + the explicit
//                                          acknowledgement token)
//   2. deploy the app
//
// The previous object is never overwritten — a new hash is a new key — so links
// already in flight against the old template keep working. Only the new link is
// broken by publishing late.
//
// Hash last changed 2026-07-30 when permission pack .4 added read-only Amazon
// Bedrock guardrail, invocation-logging, and data-retention posture. Previous:
// ca3ac48892789106beaab73acea225555ee3190e6d8cad581c7be0ad89a07d77
export const AWS_CUSTOMER_ROLE_TEMPLATE_VERSION = "standard-2026-07.4" as const;
export const AWS_CUSTOMER_ROLE_TEMPLATE_SHA256 =
  "1f08f008ab024bc9c440340340e7a7cfbad7ed394e6704c3df7173766f727fc8" as const;
export const AWS_CUSTOMER_ROLE_TEMPLATE_PATH =
  "/sutra-customer-onboarding-role.yaml" as const;
