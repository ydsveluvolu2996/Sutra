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
//   1. pnpm live:aws:publish-template   (needs AWS credentials + the explicit
//                                        acknowledgement token)
//   2. deploy the app
//
// The previous object is never overwritten — a new hash is a new key — so links
// already in flight against the old template keep working. Only the new link is
// broken by publishing late.
//
// Hash last changed 2026-08-05 when onboarding adopted the standard-2026-08.12
// action set, so a newly onboarded account grants the read-only FinOps source
// contracts through ADV-05 Graviton Savings instead of the inventory-only
// standard-2026-07.4 set, which granted no FinOps source at all. Previous:
// 1f08f008ab024bc9c440340340e7a7cfbad7ed394e6704c3df7173766f727fc8
export const AWS_CUSTOMER_ROLE_TEMPLATE_VERSION = "standard-2026-08.12" as const;
export const AWS_CUSTOMER_ROLE_TEMPLATE_SHA256 =
  "5ff8968179a1b8d265a8a4a82c594530edbbc5bb4822c3f42a1848e4e7e4db80" as const;
export const AWS_CUSTOMER_ROLE_TEMPLATE_PATH =
  "/sutra-customer-onboarding-role.yaml" as const;
