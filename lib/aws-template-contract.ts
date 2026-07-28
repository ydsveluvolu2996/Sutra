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
// Hash last changed 2026-07-28 by the SutraReadOnlyRole -> SutraCollectorRole
// rename. Previous: 8257b9e9ba516795a3a75ca86ddca13199223f0b38fbd577797ffdd8d14eba98
//
// VERSION is deliberately NOT bumped: the permission contract itself is
// unchanged (same actions, same deny), only the default role name moved. The
// version labels the reviewed permission pack, not the file bytes.
export const AWS_CUSTOMER_ROLE_TEMPLATE_VERSION = "standard-2026-07.2" as const;
export const AWS_CUSTOMER_ROLE_TEMPLATE_SHA256 =
  "3ef5afb2bc587febd459a3d186eb82f52c91ad6612b75b515f4d14c97b739989" as const;
export const AWS_CUSTOMER_ROLE_TEMPLATE_PATH =
  "/sutra-customer-onboarding-role.yaml" as const;
