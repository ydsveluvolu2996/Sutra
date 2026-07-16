import type { ConnectionStatus } from "./pilot-types";

export interface PortfolioConnectionSummary {
  readonly id: string;
  readonly customerId: string;
  readonly awsAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly status: ConnectionStatus;
  readonly roleArn: string | null;
  readonly enabledRegions: readonly string[];
  readonly permissionPackVersion: string;
  readonly lastSuccessfulSyncAt: string | null;
  readonly latestSnapshotAt: string | null;
  readonly resourceCount: number;
  readonly openFindingCount: number;
}

export interface PortfolioCustomerSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: "active" | "trial" | "suspended";
  readonly connectionCount: number;
  readonly resourceCount: number;
  readonly openFindingCount: number;
  readonly latestSnapshotAt: string | null;
  readonly connections: readonly PortfolioConnectionSummary[];
}

export interface PortfolioState {
  readonly organizationId: string;
  readonly scopeMode: "all_customers" | "assigned_customers";
  readonly measuredAt: string;
  readonly totals: {
    readonly customers: number;
    readonly connections: number;
    readonly resources: number;
    readonly openFindings: number;
  };
  readonly customers: readonly PortfolioCustomerSummary[];
}
