import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildEnterpriseActivationReadiness,
  type EnterpriseActivationReadinessInput,
} from "../lib/enterprise-activation-readiness.ts";

const NOW = Date.parse("2026-07-30T12:00:00.000Z");

function readyInput(): EnterpriseActivationReadinessInput {
  return {
    now: NOW,
    connectionId: `conn_${"a".repeat(32)}`,
    finops: {
      curPeriodCount: 2,
      curLineCount: 900,
      costStatus: "COMPLETE",
      costCollectedAt: "2026-07-30T10:00:00.000Z",
      forecastStatus: "AVAILABLE",
    },
    compliance: {
      snapshotId: "snap_a",
      snapshotCollectedAt: "2026-07-30T09:00:00.000Z",
      snapshotCoverageState: "complete",
      total: 20,
      fail: 2,
      unknown: 0,
      approvedMfaSignoffCount: 1,
    },
    notifications: {
      state: "healthy",
      enabledDestinations: 2,
      configuredDestinations: 2,
      actionableJobs: 0,
      deadLetter: 0,
    },
    itsm: {
      connectorCount: 1,
      enabledConnectorCount: 1,
      managedSecretBacked: true,
      bidirectionallyVerifiedConnectorCount: 1,
    },
    threatIntelligence: {
      asOf: "2026-07-30T06:00:00.000Z",
      cveCount: 250_000,
    },
    platformHealth: { overall: "operational" },
  };
}

describe("enterprise activation readiness", () => {
  it("reports ready only when every engine has current production evidence", () => {
    const report = buildEnterpriseActivationReadiness(readyInput());
    assert.equal(report.overall, "ready");
    assert.equal(report.summary.ready, 6);
    assert.equal(report.summary.blocked, 0);
    assert.equal(report.domains.every((domain) => domain.state === "ready"), true);
  });

  it("does not count implemented-but-unconfigured engines as ready", () => {
    const report = buildEnterpriseActivationReadiness({
      ...readyInput(),
      finops: {
        curPeriodCount: 0,
        curLineCount: 0,
        costStatus: null,
        costCollectedAt: null,
        forecastStatus: null,
      },
      compliance: {
        snapshotId: null,
        snapshotCollectedAt: null,
        snapshotCoverageState: null,
        total: 20,
        fail: 0,
        unknown: 20,
        approvedMfaSignoffCount: 0,
      },
      notifications: {
        state: "not_configured",
        enabledDestinations: 0,
        configuredDestinations: 0,
        actionableJobs: 0,
        deadLetter: 0,
      },
      itsm: {
        connectorCount: 0,
        enabledConnectorCount: 0,
        managedSecretBacked: false,
        bidirectionallyVerifiedConnectorCount: 0,
      },
    });
    assert.equal(report.overall, "not_configured");
    assert.equal(report.summary.not_configured, 4);
  });

  it("fails closed when threat data is absent or a delivery dependency is blocked", () => {
    const report = buildEnterpriseActivationReadiness({
      ...readyInput(),
      notifications: {
        state: "blocked",
        enabledDestinations: 1,
        configuredDestinations: 0,
        actionableJobs: 1,
        deadLetter: 0,
      },
      threatIntelligence: { asOf: null, cveCount: 0 },
    });
    assert.equal(report.overall, "blocked");
    assert.equal(report.summary.blocked, 2);
    assert.equal(report.domains.find((domain) => domain.key === "threat_intelligence")?.state, "blocked");
  });

  it("surfaces stale evidence and local ITSM credentials as attention", () => {
    const report = buildEnterpriseActivationReadiness({
      ...readyInput(),
      compliance: {
        ...readyInput().compliance,
        snapshotCollectedAt: "2026-07-28T09:00:00.000Z",
        snapshotCoverageState: "partial",
        unknown: 3,
        approvedMfaSignoffCount: 0,
      },
      itsm: {
        connectorCount: 1,
        enabledConnectorCount: 1,
        managedSecretBacked: false,
        bidirectionallyVerifiedConnectorCount: 0,
      },
      threatIntelligence: {
        asOf: "2026-07-27T06:00:00.000Z",
        cveCount: 250_000,
      },
    });
    assert.equal(report.overall, "attention");
    assert.equal(report.summary.attention, 3);
    const itsm = report.domains.find((domain) => domain.key === "itsm");
    assert.match(itsm?.summary ?? "", /not managed-secret backed/u);
  });

  it("keeps managed ITSM connectors in attention until both directions are proven after update", () => {
    const report = buildEnterpriseActivationReadiness({
      ...readyInput(),
      itsm: {
        connectorCount: 1,
        enabledConnectorCount: 1,
        managedSecretBacked: true,
        bidirectionallyVerifiedConnectorCount: 0,
      },
    });
    const itsm = report.domains.find((domain) => domain.key === "itsm");
    assert.equal(itsm?.state, "attention");
    assert.match(itsm?.summary ?? "", /bidirectional delivery has not been proven/u);
  });

  it("rejects an invalid clock instead of creating false timestamps", () => {
    assert.throws(
      () => buildEnterpriseActivationReadiness({ ...readyInput(), now: Number.NaN }),
      /finite readiness clock/u,
    );
  });
});
