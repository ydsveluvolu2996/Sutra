/** Default AWS SDK client factory kept separate from the pure evidence adapter. */
import { SupportClient } from "@aws-sdk/client-support";
import { workloadIdentityAwsClientConfig } from "./role-broker.js";
import type { AwsTemporaryCredentials } from "./types.js";
import type {
  AwsSupportCasesProviderClient,
  AwsSupportCasesProviderPartition,
} from "./aws-support-cases-provider-adapter.js";

export function createAwsSupportCasesProviderClient(input: {
  readonly partition: AwsSupportCasesProviderPartition;
  readonly credentials: AwsTemporaryCredentials;
}): AwsSupportCasesProviderClient {
  const region = input.partition === "aws" ? "us-east-1" : "us-gov-west-1";
  return new SupportClient({
    ...workloadIdentityAwsClientConfig(region, 4),
    credentials: input.credentials,
  });
}
