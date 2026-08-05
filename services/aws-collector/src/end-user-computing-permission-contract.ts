/** Immutable `.8.11` least-privilege permission contract for ADV-11. */
import { END_USER_COMPUTING_PERMISSION_PACK_VERSION } from "./types.js";
import { END_USER_COMPUTING_PROVIDER_ACTIONS } from "./end-user-computing-provider-adapter.js";

export const END_USER_COMPUTING_PERMISSION_POLICY_NAME =
  "SutraFinopsEndUserComputingReadV1" as const;
export const END_USER_COMPUTING_PERMISSION_SOURCE_ID = "end_user_computing" as const;
export const END_USER_COMPUTING_PERMISSION_ACTIONS = END_USER_COMPUTING_PROVIDER_ACTIONS;
export const END_USER_COMPUTING_SESSION_ACTIONS = END_USER_COMPUTING_PROVIDER_ACTIONS;

export const END_USER_COMPUTING_PERMISSION_CONTRACT = Object.freeze({
  permissionPackVersion: END_USER_COMPUTING_PERMISSION_PACK_VERSION,
  policyName: END_USER_COMPUTING_PERMISSION_POLICY_NAME,
  sourceId: END_USER_COMPUTING_PERMISSION_SOURCE_ID,
  effect: "Allow" as const,
  actions: END_USER_COMPUTING_PERMISSION_ACTIONS,
  resources: Object.freeze(["*"] as const),
  mutableActions: Object.freeze([] as const),
});
