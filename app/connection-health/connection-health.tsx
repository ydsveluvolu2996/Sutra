"use client";

import { useEffect, useState } from "react";
import type { ChromeState } from "../components/dashboard-chrome";
import {
  DashboardCard,
  DashboardTileRow,
  DataTable,
  StatePill,
  StatTile,
} from "../components/dashboard-chrome";

/**
 * Connection health, and only connection health.
 *
 * This navigation entry used to be an anchor into `/onboard#connection-lifecycle`,
 * so a reader who wanted one connection's state was handed the onboarding form,
 * the trust panels and (until it moved to FinOps) the whole dashboard catalog.
 * Worse, the anchor landed on the destructive controls: Disable and Offboard.
 *
 * Health is a read. Nothing here mutates a connection; the lifecycle actions
 * stay on Manage AWS account, which is where an operator goes intending to
 * change something.
 */

interface HealthConnection {
  readonly id: string;
  readonly customerName: string;
  readonly awsAccountId: string;
  readonly partition: string;
  readonly sourceKind: "aws_trust_role" | "aws_static_credentials" | "simulated_fixture";
  readonly status: "pending" | "active" | "disabled" | "error";
  readonly roleArn: string | null;
  readonly permissionPackVersion: string;
  readonly lastValidatedAt: string | null;
  readonly lastSuccessfulSyncAt: string | null;
}

interface SyncRun {
  readonly id: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly status: string;
  readonly error: string | null;
}

const SOURCE_LABEL: Readonly<Record<HealthConnection["sourceKind"], string>> = {
  aws_trust_role: "IAM role",
  aws_static_credentials: "Access keys",
  simulated_fixture: "Simulated fixture",
};

// Connection status maps onto the chrome's own state vocabulary. `pending`
// stays "pending" rather than "failed": awaiting validation is a normal step in
// onboarding, not a fault, and colouring it as one trains operators to ignore
// the colour.
const STATE_TONE: Readonly<Record<HealthConnection["status"], ChromeState>> = {
  active: "resolved",
  pending: "pending",
  disabled: "suppressed",
  error: "failed",
};

function formatTimestamp(value: string | null): string {
  if (value === null) return "Never";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "Unknown";
  return new Date(parsed).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function ConnectionHealth() {
  const [connection, setConnection] = useState<HealthConnection | null>(null);
  const [runs, setRuns] = useState<readonly SyncRun[]>([]);
  const [collectorMode, setCollectorMode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const [stateResponse, healthResponse] = await Promise.all([
          fetch("/api/pilot/state", { headers: { accept: "application/json" } }),
          fetch("/api/pilot/health", { headers: { accept: "application/json" } }),
        ]);
        if (!stateResponse.ok) throw new Error("The workspace state could not be read.");
        const stateBody = await stateResponse.json() as {
          state: { connection: HealthConnection | null; syncRuns?: readonly SyncRun[] };
        };
        const healthBody = healthResponse.ok
          ? await healthResponse.json() as { health?: { mode?: string } }
          : null;
        if (cancelled) return;
        setConnection(stateBody.state.connection);
        setRuns(stateBody.state.syncRuns ?? []);
        // Absent is absent. A failed health read is never rendered as "live".
        setCollectorMode(healthBody?.health?.mode ?? null);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unknown error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <section className="panel">
        <div className="loading-state" role="status">
          <span className="loading-spinner" />Reading connection health…
        </div>
      </section>
    );
  }

  if (error !== null) {
    return (
      <section className="panel">
        <div className="inline-warning" role="alert">
          <strong>Connection health is unavailable.</strong>
          <span>{error}</span>
        </div>
      </section>
    );
  }

  if (connection === null) {
    return (
      <section className="panel">
        <div className="empty-state" role="status">
          <strong>No AWS connection yet.</strong>
          <span>
            Onboard an AWS account to see its trust, validation and collection health here.
          </span>
        </div>
      </section>
    );
  }

  const lastRun = runs[0] ?? null;

  return (
    <>
      <section className="page-heading">
        <div>
          <p className="eyebrow">Connection health</p>
          <h1>{connection.customerName}</h1>
          <p className="page-subtitle">
            Account {connection.awsAccountId} · {connection.partition} ·{" "}
            {SOURCE_LABEL[connection.sourceKind]}
          </p>
        </div>
      </section>

      <DashboardTileRow>
        <StatTile
          label="Connection state"
          value={connection.status}
          caption={`Permission pack ${connection.permissionPackVersion}`}
        />
        <StatTile
          label="Last validated"
          value={formatTimestamp(connection.lastValidatedAt)}
          caption="Trust and permissions are re-attested before every collection"
        />
        <StatTile
          label="Last successful collection"
          value={formatTimestamp(connection.lastSuccessfulSyncAt)}
          caption="A granted permission is not an observed delivery"
        />
        <StatTile
          label="Collector"
          value={collectorMode ?? "Unavailable"}
          caption={collectorMode === null ? "The collector health probe did not answer" : "Live collection path"}
        />
      </DashboardTileRow>

      <DashboardCard
        title="Trust binding"
        subtitle="What this connection is bound to, and how Sutra reaches it."
      >
        <dl className="definition-grid">
          <div><dt>Source</dt><dd>{SOURCE_LABEL[connection.sourceKind]}</dd></div>
          <div>
            <dt>Role ARN</dt>
            <dd>{connection.roleArn ?? "Not applicable for access-key connections"}</dd>
          </div>
          <div><dt>Permission pack</dt><dd>{connection.permissionPackVersion}</dd></div>
          <div>
            <dt>State</dt>
            <dd><StatePill state={STATE_TONE[connection.status]} label={connection.status} /></dd>
          </div>
        </dl>
      </DashboardCard>

      <DashboardCard
        title="Recent collection runs"
        subtitle="Outcome of the most recent collections for this connection."
      >
        <DataTable<SyncRun>
          caption="Recent collection runs for this connection"
          rowKey={(run) => run.id}
          columns={[
            { id: "started", header: "Started", cell: (run) => formatTimestamp(run.startedAt) },
            { id: "completed", header: "Completed", cell: (run) => formatTimestamp(run.completedAt) },
            { id: "status", header: "Status", cell: (run) => run.status },
            {
              id: "detail",
              header: "Detail",
              // Never invent a reason for a failure that did not report one.
              cell: (run) => run.error ?? (run.status === "succeeded" ? "—" : "No detail reported"),
            },
          ]}
          rows={runs.slice(0, 10)}
          empty="No collection has run for this connection yet."
        />
      </DashboardCard>

      <p className="page-subtitle">
        To disable or offboard this connection, use{" "}
        <a href="/onboard#connection-lifecycle">Manage AWS account</a>. Those actions change
        state and deliberately do not live on a health page.
        {lastRun === null ? " No run history exists yet." : ""}
      </p>
    </>
  );
}
