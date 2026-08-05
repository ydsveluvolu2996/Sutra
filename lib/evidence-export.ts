import type { PilotState } from "./pilot-types.ts";
import { canonicalJson } from "./canonical-json.ts";
import { safeCsvCell } from "./safe-csv.ts";

export type EvidenceExportFormat = "json" | "csv";

export function buildEvidenceExport(
  state: PilotState,
  format: EvidenceExportFormat,
  exportedAt: string,
): {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly artifactKind: "export_json" | "export_csv";
  readonly extension: "json" | "csv";
} {
  const encoder = new TextEncoder();
  if (format === "json") {
    return {
      body: encoder.encode(canonicalJson({ exportedAt, state })),
      contentType: "application/json",
      artifactKind: "export_json",
      extension: "json",
    };
  }
  const header = [
    "resource_key", "service", "resource_type", "native_id", "arn", "name", "region", "state",
    "lifecycle_state", "consecutive_complete_misses", "account_id", "collected_at",
    "content_sha256", "evidence_snapshot_id", "evidence_snapshot_sha256",
    "active_snapshot_id", "origin_kind", "fixture_id", "fixture_version",
  ];
  const rows = state.resources.map((resource) => [
    resource.resourceKey,
    resource.service,
    resource.resourceType,
    resource.nativeId,
    resource.arn,
    resource.name,
    resource.region,
    resource.state,
    resource.lifecycleState ?? "active",
    resource.consecutiveCompleteMisses ?? 0,
    resource.source.accountId,
    resource.source.collectedAt,
    resource.contentSha256,
    resource.evidenceSnapshot?.id,
    resource.evidenceSnapshot?.snapshotSha256,
    state.activeSnapshot?.id,
    state.activeSnapshot?.origin.kind,
    state.activeSnapshot?.origin.fixtureId,
    state.activeSnapshot?.origin.fixtureVersion,
  ]);
  const csv =
    `${header.map(safeCsvCell).join(",")}\r\n` +
    `${rows.map((row) => row.map(safeCsvCell).join(",")).join("\r\n")}\r\n`;
  return {
    body: encoder.encode(csv),
    contentType: "text/csv",
    artifactKind: "export_csv",
    extension: "csv",
  };
}
