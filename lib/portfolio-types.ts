import type { ConnectionStatus } from "./pilot-types";
import type { AwsRegionSelection } from "./aws-region-selection.ts";

export interface PortfolioConnectionSummary {
  readonly id: string;
  readonly customerId: string;
  // `aws_static_credentials` is a live AWS source the database already returns:
  // access-key onboarding writes it, and lib/compliance-engine.ts has always
  // modelled it. Omitting it here made the portfolio type narrower than the rows
  // it describes, so an access-key deployment was typed as something it is not.
  readonly sourceKind: "aws_trust_role" | "aws_static_credentials" | "simulated_fixture";
  readonly fixtureId: string | null;
  readonly fixtureVersion: string | null;
  readonly awsAccountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly status: ConnectionStatus;
  readonly roleArn: string | null;
  readonly enabledRegions: AwsRegionSelection;
  readonly permissionPackVersion: string;
  readonly lastSuccessfulSyncAt: string | null;
  readonly latestSnapshotAt: string | null;
  readonly latestSnapshotOrigin: "unknown" | "simulated_fixture" | "aws_live" | null;
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
