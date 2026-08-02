/** Default AWS SDK v3 reader for credential-owned ADV-12 collection. */
import {
  DescribeExecutionCommand,
  DescribeStateMachineCommand,
  ListExecutionsCommand,
  SFNClient,
} from "@aws-sdk/client-sfn";
import type { AwsTemporaryCredentials } from "./types.js";
import type { DcfProviderReader } from "./dcf-step-functions-provider-adapter.js";

export function createDcfStepFunctionsSdkReader(input: {
  readonly credentials: AwsTemporaryCredentials;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly region: string;
}): DcfProviderReader {
  const expectedPrefix = input.partition === "aws-cn" ? "cn-"
    : input.partition === "aws-us-gov" ? "us-gov-" : "";
  if ((expectedPrefix !== "" && !input.region.startsWith(expectedPrefix))
    || (expectedPrefix === "" && (input.region.startsWith("cn-") || input.region.startsWith("us-gov-")))) {
    throw new Error("DCF_STEP_FUNCTIONS_SDK_SCOPE_INVALID");
  }
  const client = new SFNClient({
    region: input.region,
    credentials: input.credentials,
    maxAttempts: 1,
  });
  return Object.freeze({
    describeStateMachine: async (
      request: Parameters<DcfProviderReader["describeStateMachine"]>[0],
      signal: AbortSignal,
    ) => client.send(
      new DescribeStateMachineCommand({
        stateMachineArn: request.stateMachineArn,
        includedData: request.includedData,
      }),
      { abortSignal: signal },
    ),
    listExecutions: async (
      request: Parameters<DcfProviderReader["listExecutions"]>[0],
      signal: AbortSignal,
    ) => client.send(
      new ListExecutionsCommand({
        stateMachineArn: request.stateMachineArn,
        maxResults: request.maxResults,
        ...(request.nextToken === null ? {} : { nextToken: request.nextToken }),
      }),
      { abortSignal: signal },
    ),
    describeExecution: async (
      request: Parameters<DcfProviderReader["describeExecution"]>[0],
      signal: AbortSignal,
    ) => client.send(
      new DescribeExecutionCommand({
        executionArn: request.executionArn,
        includedData: request.includedData,
      }),
      { abortSignal: signal },
    ),
  });
}
