export type ManagedEvidenceExportFormat = "json" | "csv";

function responseMessage(value: unknown): string {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return "The managed export was rejected";
  }
  const error = (value as { error?: unknown }).error;
  return typeof error === "object" && error !== null && "message" in error
    ? String((error as { message?: unknown }).message ?? "The managed export was rejected")
    : "The managed export was rejected";
}

/**
 * Archive, issue an actor-bound one-use grant, then stream through Sutra.
 * No object-store URL or key ever reaches the browser.
 */
export async function downloadManagedEvidenceExport(
  connectionId: string,
  format: ManagedEvidenceExportFormat,
): Promise<void> {
  const issued = await fetch(
    `/api/v1/evidence/exports?connectionId=${encodeURIComponent(connectionId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ format }),
    },
  );
  const payload: unknown = await issued.json().catch(() => null);
  if (!issued.ok) throw new Error(responseMessage(payload));
  const token =
    typeof payload === "object" && payload !== null &&
      "grant" in payload && typeof payload.grant === "object" && payload.grant !== null &&
      "token" in payload.grant && typeof payload.grant.token === "string"
      ? payload.grant.token
      : null;
  if (token === null) throw new Error("The managed export grant was unavailable");
  const downloaded = await fetch("/api/v1/evidence/download", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!downloaded.ok) {
    const denied: unknown = await downloaded.json().catch(() => null);
    throw new Error(responseMessage(denied));
  }
  const blob = await downloaded.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `sutra-cmdb.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
