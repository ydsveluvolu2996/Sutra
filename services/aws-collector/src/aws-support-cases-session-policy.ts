/** Exact STS intersection used only by the credential-owning ADV-09 route. */
import { AWS_SUPPORT_CASES_PROVIDER_SESSION_ACTIONS } from
  "./aws-support-cases-provider-adapter.js";

export function awsSupportCasesProviderSessionPolicy(): string {
  const policy = JSON.stringify({
    Version: "2012-10-17",
    Statement: [{
      Sid: "ReadPrivacyMinimizedAwsSupportCases",
      Effect: "Allow",
      Action: AWS_SUPPORT_CASES_PROVIDER_SESSION_ACTIONS,
      Resource: "*",
    }],
  });
  if (Buffer.byteLength(policy, "utf8") > 2_048) {
    throw new Error("AWS_SUPPORT_CASES_SESSION_POLICY_TOO_LARGE");
  }
  return policy;
}
