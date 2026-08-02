/** Immutable `.8.12` least-privilege permission contract for ADV-05. */
import { GRAVITON_SAVINGS_PERMISSION_PACK_VERSION } from "./types.js";
import { GRAVITON_PROVIDER_SESSION_ACTIONS } from "./graviton-savings-provider-adapter.js";
export const GRAVITON_SAVINGS_PERMISSION_POLICY_NAME = "SutraFinopsGravitonSavingsReadV1" as const;
export const GRAVITON_SAVINGS_PERMISSION_ACTIONS = GRAVITON_PROVIDER_SESSION_ACTIONS;
export const GRAVITON_SAVINGS_SESSION_ACTIONS = GRAVITON_PROVIDER_SESSION_ACTIONS;
export const GRAVITON_SAVINGS_PERMISSION_CONTRACT = Object.freeze({
  permissionPackVersion: GRAVITON_SAVINGS_PERMISSION_PACK_VERSION,
  policyName: GRAVITON_SAVINGS_PERMISSION_POLICY_NAME,
  actions: GRAVITON_SAVINGS_PERMISSION_ACTIONS,
  resources: Object.freeze(["*"] as const), mutableActions: Object.freeze([] as const),
});
