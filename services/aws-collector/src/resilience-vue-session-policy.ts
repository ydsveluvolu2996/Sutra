/** Exact read-only STS intersection for one ADV-10 account/Region target. */
import { RESILIENCE_VUE_PROVIDER_READ_ACTIONS } from "./resilience-vue-provider-adapter.js";

const GLOBAL_DISCOVERY = new Set([
  "resiliencehub:ListApps",
  "resiliencehub:ListResiliencyPolicies",
]);

export function resilienceVueProviderSessionPolicy(input: {
  readonly accountId: string;
  readonly partition: "aws" | "aws-cn" | "aws-us-gov";
  readonly region: string;
}): string {
  if (!/^\d{12}$/u.test(input.accountId)
    || !["aws", "aws-cn", "aws-us-gov"].includes(input.partition)
    || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u.test(input.region)) {
    throw new Error("RESILIENCE_VUE_SESSION_SCOPE_INVALID");
  }
  const scoped = RESILIENCE_VUE_PROVIDER_READ_ACTIONS.filter((action) => !GLOBAL_DISCOVERY.has(action));
  const policy = JSON.stringify({ Version: "2012-10-17", Statement: [
    { Sid: "VerifyResilienceVueIdentity", Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" },
    { Sid: "DiscoverResilienceHub", Effect: "Allow",
      Action: [...GLOBAL_DISCOVERY].sort(), Resource: "*" },
    { Sid: "ReadScopedResilienceHubEvidence", Effect: "Allow", Action: scoped,
      Resource: [
        `arn:${input.partition}:resiliencehub:${input.region}:${input.accountId}:app/*`,
        `arn:${input.partition}:resiliencehub:${input.region}:${input.accountId}:app-assessment/*`,
        `arn:${input.partition}:resiliencehub:${input.region}:${input.accountId}:resiliency-policy/*`,
      ] },
  ] });
  if (Buffer.byteLength(policy, "utf8") > 2_048) throw new Error("RESILIENCE_VUE_SESSION_POLICY_TOO_LARGE");
  return policy;
}
