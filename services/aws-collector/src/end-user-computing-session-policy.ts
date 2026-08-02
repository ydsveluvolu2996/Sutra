/** Exact read-only STS intersection for one ADV-11 account/Region target. */
import { END_USER_COMPUTING_SESSION_ACTIONS } from "./end-user-computing-permission-contract.js";

const GLOBAL_READS = Object.freeze([
  "appstream:DescribeFleets",
  "appstream:DescribeStacks",
  "cloudwatch:GetMetricData",
  "workspaces:DescribeWorkspaceBundles",
  "workspaces:DescribeWorkspaces",
  "workspaces:DescribeWorkspacesConnectionStatus",
] as const);

export function endUserComputingSessionPolicy(input: {
  readonly accountId: string;
  readonly partition: "aws" | "aws-cn" | "aws-us-gov";
  readonly region: string;
}): string {
  if (!/^\d{12}$/u.test(input.accountId)
    || !["aws", "aws-cn", "aws-us-gov"].includes(input.partition)
    || !/^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u.test(input.region)) {
    throw new Error("END_USER_COMPUTING_SESSION_SCOPE_INVALID");
  }
  const policy = JSON.stringify({ Version: "2012-10-17", Statement: [
    { Sid: "VerifyEndUserComputingIdentity", Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" },
    { Sid: "ReadEndUserComputingGlobalEvidence", Effect: "Allow", Action: GLOBAL_READS, Resource: "*" },
    { Sid: "ReadExactAppStreamFleets", Effect: "Allow", Action: ["appstream:DescribeSessions"],
      Resource: [`arn:${input.partition}:appstream:${input.region}:${input.accountId}:fleet/*`] },
    { Sid: "ReadExactAppStreamStacks", Effect: "Allow", Action: ["appstream:DescribeSessions", "appstream:ListAssociatedFleets"],
      Resource: [`arn:${input.partition}:appstream:${input.region}:${input.accountId}:stack/*`] },
  ] });
  const policyActions = JSON.stringify([...GLOBAL_READS, "appstream:DescribeSessions", "appstream:ListAssociatedFleets"].sort());
  if (policyActions !== JSON.stringify([...END_USER_COMPUTING_SESSION_ACTIONS].sort())) {
    throw new Error("END_USER_COMPUTING_SESSION_ACTION_DRIFT");
  }
  if (Buffer.byteLength(policy, "utf8") > 2_048) throw new Error("END_USER_COMPUTING_SESSION_POLICY_TOO_LARGE");
  return policy;
}
