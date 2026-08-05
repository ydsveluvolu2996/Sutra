/** Immutable least-privilege permission successor for ADV-10 ResilienceVue. */
export { RESILIENCE_VUE_PERMISSION_PACK_VERSION } from "./types.js";
import { RESILIENCE_VUE_PERMISSION_PACK_VERSION } from "./types.js";
import { RESILIENCE_VUE_PROVIDER_READ_ACTIONS, RESILIENCE_VUE_PROVIDER_SESSION_ACTIONS } from "./resilience-vue-provider-adapter.js";

export const RESILIENCE_VUE_PERMISSION_POLICY_NAME = "SutraFinopsResilienceVueReadV1" as const;
export const RESILIENCE_VUE_PERMISSION_SOURCE_ID = "aws_resilience_hub" as const;
export const RESILIENCE_VUE_PERMISSION_ACTIONS = RESILIENCE_VUE_PROVIDER_READ_ACTIONS;
export const RESILIENCE_VUE_SESSION_ACTIONS = RESILIENCE_VUE_PROVIDER_SESSION_ACTIONS;
export const RESILIENCE_VUE_PERMISSION_CONTRACT = Object.freeze({
  permissionPackVersion: RESILIENCE_VUE_PERMISSION_PACK_VERSION,
  policyName: RESILIENCE_VUE_PERMISSION_POLICY_NAME,
  sourceId: RESILIENCE_VUE_PERMISSION_SOURCE_ID,
  effect: "Allow" as const,
  actions: RESILIENCE_VUE_PERMISSION_ACTIONS,
  resources: Object.freeze(["*"] as const),
  mutableActions: Object.freeze([] as const),
});

export function assertResilienceVuePermissionContract(input: {
  readonly permissionPackVersion: string;
  readonly policyName: string;
  readonly actions: readonly string[];
  readonly resources: readonly string[];
}): void {
  if (input.permissionPackVersion !== RESILIENCE_VUE_PERMISSION_PACK_VERSION
    || input.policyName !== RESILIENCE_VUE_PERMISSION_POLICY_NAME
    || JSON.stringify(input.actions) !== JSON.stringify(RESILIENCE_VUE_PERMISSION_ACTIONS)
    || JSON.stringify(input.resources) !== JSON.stringify(["*"])) {
    throw new Error("RESILIENCE_VUE_PERMISSION_CONTRACT_REJECTED");
  }
}
