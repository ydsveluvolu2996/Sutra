"use client";

import { useEffect, useState } from "react";
import { connectionIdFromPilotStateResponse } from "../../lib/pilot-state-response";

/**
 * VPC flow-log coverage.
 *
 * This panel answers "is this VPC observable?" and refuses to be read as "what
 * talked to what". Sutra reads flow-log CONFIGURATION only — the records live in
 * CloudWatch Logs or S3 and need permissions the customer role does not hold — so
 * the engine's own claim boundary is rendered verbatim rather than paraphrased.
 *
 * The two states that must never look alike:
 *   * a VPC with no flow log — the actionable finding, because when something
 *     happens there the evidence does not exist and cannot be recovered later; and
 *   * a snapshot where nothing was collected — which is an unasked question, not a
 *     clean result. The API distinguishes these and this panel leads with it.
 */

interface VpcCoverage {
  readonly vpcId: string;
  readonly region: string;
  readonly isDefault: boolean;
  readonly level: "vpc" | "all-subnets" | "partial-subnets" | "configured-inactive" | "none";
  readonly observable: boolean;
  readonly trafficType: "ACCEPT" | "REJECT" | "ALL" | "unknown";
  readonly acceptedTrafficRecorded: boolean;
  readonly coveredSubnets: number;
  readonly totalSubnets: number;
  readonly flowLogIds: readonly string[];
  readonly gapReason: string | null;
}

interface CoverageReport {
  readonly vpcs: readonly VpcCoverage[];
  readonly summary: {
    readonly total: number;
    readonly observable: number;
    readonly blind: number;
    readonly partial: number;
    readonly inactive: number;
    readonly rejectOnly: number;
  };
  readonly claimBoundary: string;
  readonly disclaimer: string;
}

interface Evidence {
  readonly available: boolean;
  readonly reason?: string;
  readonly disambiguateBy?: string;
}

interface CoverageResponse {
  readonly coverage: CoverageReport;
  readonly evidence: Evidence;
  readonly inputs: { readonly vpcs: number; readonly flowLogs: number; readonly subnets: number };
  readonly scannedAt: string | null;
}

const LEVEL_LABEL: Record<VpcCoverage["level"], string> = {
  "vpc": "VPC-level log",
  "all-subnets": "Every subnet covered",
  "partial-subnets": "Partially covered",
  "configured-inactive": "Configured but inactive",
  "none": "No flow log",
};

export function FlowLogCoveragePanel(): React.JSX.Element {
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pageHeading = (
    <div className="page-heading">
      <div>
        <p className="eyebrow">Network visibility</p>
        <h1>VPC flow-log coverage</h1>
        <p className="page-subtitle">
          Which VPCs record network traffic, and which are permanent investigative blind spots.
          A VPC with no flow log cannot be investigated after an incident — the evidence never
          existed and cannot be recovered retroactively.
        </p>
      </div>
    </div>
  );

  // Deliberately NOT `void load()`: a helper that calls setLoading(true)
  // synchronously is a cascading render that react-hooks/set-state-in-effect
  // correctly flags. The async IIFE keeps the first state write inside the effect.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const requestedConnectionId = new URLSearchParams(window.location.search).get("connectionId");
        const statePath = requestedConnectionId !== null && /^conn_[a-f0-9]{32}$/u.test(requestedConnectionId)
          ? `/api/pilot/state?connectionId=${encodeURIComponent(requestedConnectionId)}`
          : "/api/pilot/state";
        const stateResponse = await fetch(statePath, { credentials: "same-origin" });
        if (!stateResponse.ok) throw new Error("Could not load the workspace state");
        const state = await stateResponse.json() as unknown;
        if (cancelled) return;
        const connectionId = connectionIdFromPilotStateResponse(state);
        setConnected(connectionId !== null);
        if (connectionId === null) return;

        const response = await fetch(
          `/api/v1/flow-log-coverage?connectionId=${encodeURIComponent(connectionId)}`,
          { credentials: "same-origin" },
        );
        if (!response.ok) throw new Error("Could not load flow-log coverage");
        const payload = await response.json() as CoverageResponse;
        if (!cancelled) setData(payload);
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unexpected error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <>{pageHeading}<section className="panel"><p>Loading flow-log coverage…</p></section></>;

  if (error !== null) {
    return (
      <>
        {pageHeading}
        <section className="panel">
          <p className="cmdbq-error" role="alert">{error}</p>
        </section>
      </>
    );
  }

  if (connected === false) {
    return (
      <>
        {pageHeading}
        <section className="panel empty-workspace">
          <span className="empty-workspace-icon">FL</span>
          <h2>No AWS account is connected</h2>
          <p>
            Connect and validate a customer account so Sutra can collect VPC flow-log configuration
            and report which networks are observable.
          </p>
          <a className="button button-primary" href="/onboard">Connect AWS account</a>
        </section>
      </>
    );
  }

  const report = data?.coverage;
  const evidence = data?.evidence;

  return (
    <>
      {pageHeading}

      {/* Not dismissible: the boundary between "recorded" and "analysed" is the
          single easiest thing for a reader to get wrong on this page. */}
      {report !== undefined ? (
        <p className="inline-warning">
          <strong>Coverage, not traffic analysis.</strong>
          <span>{report.disclaimer}</span>
        </p>
      ) : null}

      {evidence !== undefined && !evidence.available ? (
        <p className="inline-warning" role="alert">
          <strong>Nothing was collected — this is not a clean result</strong>
          <span>
            {evidence.reason}
            {evidence.disambiguateBy === undefined ? null : <> <b>{evidence.disambiguateBy}</b></>}
          </span>
        </p>
      ) : null}

      {report !== undefined ? (
        <section className="panel">
          <div className="panel-heading">
            <div><h2>Summary</h2></div>
            <span className="result-count">
              {report.summary.observable} of {report.summary.total} VPCs observable
            </span>
          </div>
          <div className="stat-row">
            <div><small>Observable</small><strong>{report.summary.observable}</strong><span>records are being produced</span></div>
            <div><small>Blind</small><strong>{report.summary.blind}</strong><span>no flow log at all</span></div>
            <div><small>Partial</small><strong>{report.summary.partial}</strong><span>some subnets uncovered</span></div>
            <div><small>Inactive</small><strong>{report.summary.inactive}</strong><span>configured, producing nothing</span></div>
            <div><small>REJECT only</small><strong>{report.summary.rejectOnly}</strong><span>cannot show what was reached</span></div>
          </div>
          {report.summary.rejectOnly > 0 ? (
            <p className="panel-footnote">
              REJECT-only logging looks like coverage but cannot answer the question that matters
              during an investigation: what did the attacker successfully reach. Accepted traffic is
              not recorded in those VPCs.
            </p>
          ) : null}
        </section>
      ) : null}

      {report !== undefined ? (
        <section className="panel">
          <div className="panel-heading">
            <div><h2>Per-VPC verdict</h2></div>
            {data?.scannedAt === null || data?.scannedAt === undefined
              ? null
              : <span className="result-count">Collected {new Date(data.scannedAt).toISOString()}</span>}
          </div>
          {report.vpcs.length === 0 ? (
            <p>
              No VPCs are present in the active snapshot. Run a collection to populate the
              inventory — an empty list here means nothing was inventoried, not that nothing exists.
            </p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>VPC</th><th>Region</th><th>Coverage</th><th>Traffic</th>
                    <th>Subnets</th><th>Flow logs</th><th>Gap</th>
                  </tr>
                </thead>
                <tbody>
                  {report.vpcs.map((vpc) => (
                    <tr key={`${vpc.region}/${vpc.vpcId}`}>
                      <td>
                        <code>{vpc.vpcId}</code>
                        {vpc.isDefault ? <span className="pill">default</span> : null}
                      </td>
                      <td>{vpc.region}</td>
                      <td>
                        <span className={vpc.observable ? "pill pill-pass" : "pill pill-fail"}>
                          {LEVEL_LABEL[vpc.level]}
                        </span>
                      </td>
                      <td>
                        {vpc.trafficType}
                        {vpc.observable && !vpc.acceptedTrafficRecorded
                          ? <span className="pill pill-warn">accepted traffic not recorded</span>
                          : null}
                      </td>
                      <td>
                        {vpc.level === "vpc"
                          ? "covered at VPC level"
                          : `${vpc.coveredSubnets} / ${vpc.totalSubnets}`}
                      </td>
                      <td>{vpc.flowLogIds.length === 0 ? "—" : vpc.flowLogIds.join(", ")}</td>
                      <td>{vpc.gapReason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="panel-footnote">
            Evidence: <code>{report.claimBoundary}</code> · {data?.inputs.vpcs ?? 0} VPCs,{" "}
            {data?.inputs.subnets ?? 0} subnets, {data?.inputs.flowLogs ?? 0} flow logs read from the
            active snapshot.
          </p>
        </section>
      ) : null}
    </>
  );
}
