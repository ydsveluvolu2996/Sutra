/** Exact per-request STS intersection for ADV-06 AWS Health collection. */
import { AWS_HEALTH_SESSION_ACTIONS } from "./aws-health-permission-contract.js";

export function awsHealthSessionPolicy(): string {
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Sid: "ReadAwsHealthOrganization",
      Effect: "Allow",
      Action: AWS_HEALTH_SESSION_ACTIONS,
      Resource: "*",
    }],
  });
  if (Buffer.byteLength(policy, "utf8") > 2_048) {
    throw new Error("AWS_HEALTH_SESSION_POLICY_TOO_LARGE");
  }
  return policy;
}
