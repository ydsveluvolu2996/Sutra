"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { KubernetesStoredWorkspace, StoredKubernetesCluster } from "../../db/kubernetes-repository";
import type { PilotState } from "../../lib/pilot-types";
import { projectStoredKubernetesWorkspace } from "../../lib/kubernetes-workspace-projection";

interface KubernetesApiBody {
  readonly clusters: readonly StoredKubernetesCluster[];
  readonly workspace: KubernetesStoredWorkspace | null;
  readonly error?: { readonly message?: string };
}

async function readBody(response: Response): Promise<KubernetesApiBody> {
  const body = await response.json().catch(() => null) as KubernetesApiBody | null;
  if (!response.ok || body === null) {
    throw new Error(body?.error?.message ?? "Sutra could not load the Kubernetes workspace");
  }
  return body;
}

export function useKubernetesEvidence(state: PilotState | null) {
  const [clusters, setClusters] = useState<readonly StoredKubernetesCluster[]>([]);
  const [workspace, setWorkspace] = useState<KubernetesStoredWorkspace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectionId = state?.connection?.id ?? null;

  const refresh = useCallback(async () => {
    if (connectionId === null) {
      setClusters([]);
      setWorkspace(null);
      setError(null);
      return;
    }
    setLoading(true);
    try {
      const clusterBody = await readBody(await fetch(
        `/api/v1/kubernetes?connectionId=${encodeURIComponent(connectionId)}`,
        { cache: "no-store" },
      ));
      setClusters(clusterBody.clusters);
      const selected = clusterBody.clusters.find((cluster) => cluster.status === "active") ?? null;
      if (selected === null) {
        setWorkspace(null);
      } else {
        const workspaceBody = await readBody(await fetch(
          `/api/v1/kubernetes?connectionId=${encodeURIComponent(connectionId)}&clusterId=${encodeURIComponent(selected.id)}`,
          { cache: "no-store" },
        ));
        setWorkspace(workspaceBody.workspace);
      }
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sutra could not load Kubernetes evidence");
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void refresh(), 0);
    const listener = () => void refresh();
    window.addEventListener("sutra:kubernetes-changed", listener);
    return () => {
      window.clearTimeout(initialLoad);
      window.removeEventListener("sutra:kubernetes-changed", listener);
    };
  }, [refresh]);

  const projectionInput = useMemo(() => {
    if (workspace === null || state?.connection === null || state?.connection === undefined) {
      return {
        resources: state?.resources ?? [],
        relationships: state?.relationships ?? [],
        findings: state?.findings ?? [],
        coverage: state?.coverage ?? [],
      };
    }
    const stored = projectStoredKubernetesWorkspace(workspace, state.connection);
    return {
      resources: [...(state.resources ?? []), ...stored.resources],
      relationships: [...(state.relationships ?? []), ...stored.relationships],
      findings: [...(state.findings ?? []), ...stored.findings],
      coverage: [...(state.coverage ?? []), ...stored.coverage],
    };
  }, [state, workspace]);

  return { clusters, workspace, loading, error, refresh, projectionInput };
}
