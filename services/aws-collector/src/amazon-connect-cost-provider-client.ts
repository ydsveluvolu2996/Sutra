/** Lazily loaded AWS SDK v3 client for the ADD-11 credential boundary. */
import type { AwsTemporaryCredentials } from "./types.js";
import type { AmazonConnectCostProviderReader } from
  "./amazon-connect-cost-provider-adapter.js";

type Command = object;
interface ConnectSdk {
  readonly ConnectClient: new (input: Record<string, unknown>) => {
    send(command: Command, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown>;
    destroy(): void;
  };
  readonly DescribeInstanceCommand: new (input: Record<string, unknown>) => Command;
  readonly ListPhoneNumbersV2Command: new (input: Record<string, unknown>) => Command;
}

export function createAmazonConnectCostProviderReader(input: {
  readonly credentials: AwsTemporaryCredentials;
  readonly region: string;
}): AmazonConnectCostProviderReader {
  const moduleName = "@aws-sdk/client-connect";
  let loaded: Promise<{ readonly sdk: ConnectSdk; readonly client: InstanceType<ConnectSdk["ConnectClient"]> }> | null = null;
  const client = () => {
    loaded ??= import(moduleName).then((value) => {
      const sdk = value as unknown as ConnectSdk;
      if (typeof sdk.ConnectClient !== "function"
        || typeof sdk.DescribeInstanceCommand !== "function"
        || typeof sdk.ListPhoneNumbersV2Command !== "function") {
        throw new Error("AMAZON_CONNECT_SDK_UNAVAILABLE");
      }
      return { sdk, client: new sdk.ConnectClient({ region: input.region,
        credentials: input.credentials, maxAttempts: 3 }) };
    });
    return loaded;
  };
  const reader: AmazonConnectCostProviderReader = {
    describeInstance: async (request: { readonly InstanceId: string }, signal: AbortSignal) => {
      const active = await client();
      return active.client.send(new active.sdk.DescribeInstanceCommand(request),
        { abortSignal: signal });
    },
    listPhoneNumbersV2: async (request: { readonly TargetArn: string; readonly MaxResults: 1_000;
      readonly NextToken?: string }, signal: AbortSignal) => {
      const active = await client();
      return active.client.send(new active.sdk.ListPhoneNumbersV2Command(request),
        { abortSignal: signal });
    },
  };
  return Object.freeze(reader);
}
