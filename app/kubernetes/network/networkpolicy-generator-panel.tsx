"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  GeneratedNetworkPolicy,
  NetworkPolicyGenerationSummary,
} from "../../../lib/kubernetes-networkpolicy-generator";

interface GeneratorResponse {
  readonly schema: "sutra.kubernetes-networkpolicy-generator.v1";
  readonly policies: readonly GeneratedNetworkPolicy[];
  readonly summary: NetworkPolicyGenerationSummary;
  readonly disclaimer: string;
  readonly flowsObserved: number;
  readonly configured: boolean;
  readonly error?: { readonly message?: string };
}

export function NetworkPolicyGeneratorPanel({ connectionId, clusterId }: { readonly connectionId: string | null; readonly clusterId: string | null }) {
  const [data, setData] = useState<GeneratorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openWorkload, setOpenWorkload] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (connectionId === null || clusterId === null) { setData(null); return; }
    setBusy(true);
    try {
      const response = await fetch(`/api/v1/kubernetes/networkpolicies?connectionId=${encodeURIComponent(connectionId)}&clusterId=${encodeURIComponent(clusterId)}`, { cache: "no-store", credentials: "same-origin" });
      const body = await response.json() as GeneratorResponse;
      if (!response.ok || body.policies === undefined) throw new Error(body.error?.message ?? "Policy generation is unavailable");
      setData(body);
      setError(null);
    } catch (caught) {
      setData(null);
      setError(caught instanceof Error ? caught.message : "Policy generation is unavailable");
    } finally {
      setBusy(false);
    }
  }, [clusterId, connectionId]);
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const copy = useCallback(async (key: string, yaml: string) => {
    try {
      await navigator.clipboard.writeText(yaml);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
    } catch { /* clipboard unavailable; the YAML is still shown for manual copy */ }
  }, []);

  if (connectionId === null || clusterId === null) return null;
  const summary = data?.summary ?? null;

  return (
    <section className="panel">
      <div className="panel-heading">
        <div><p className="eyebrow">Least-privilege from observed flows</p><h2>Generate NetworkPolicies</h2></div>
        <button className="button button-secondary button-small" disabled={busy} onClick={() => void load()} type="button">{busy ? "Generating…" : "Regenerate"}</button>
      </div>
      <p className="panel-footnote">One Kubernetes NetworkPolicy per workload, reproducing only the Cilium/Hubble connectivity observed in the collection window — ingress from the peers seen sending to it, egress to the peers+ports seen leaving it. A workload with no observed flows gets an explicit default-deny. Every policy is a reviewed <strong>suggestion</strong>, flagged INCOMPLETE; flow absence is not proof a connection is unused. Confirm your CNI enforces NetworkPolicy before applying.</p>

      {error ? <div className="page-alert page-alert-error" role="alert"><span>{error}</span><button onClick={() => void load()} type="button">Retry</button></div> : null}

      {data !== null && summary !== null ? <>
        <div className="inventory-stats">
          <article><small>Policies generated</small><strong>{summary.policies}</strong><span>{summary.withObservedPeers} with observed peers</span></article>
          <article><small>Default-deny</small><strong>{summary.defaultDeny}</strong><span>no flows observed</span></article>
          <article><small>Flows attributed</small><strong>{summary.flowsAttributed}</strong><span>of {summary.flowsConsidered} considered</span></article>
          <article><small>Unlabeled peers</small><strong>{summary.peersWithoutLabels}</strong><span>namespace-scoped selectors</span></article>
        </div>

        {data.policies.length > 0 ? <div className="networkpolicy-list">
          {data.policies.map((policy) => {
            const key = `${policy.workloadRef.namespace}/${policy.workloadRef.name}`;
            const open = openWorkload === key;
            return (
              <article className="networkpolicy-row" key={key}>
                <div className="networkpolicy-head">
                  <div><strong>{policy.workloadRef.name}</strong><small>{policy.workloadRef.namespace} · {policy.observedPeers} observed peer{policy.observedPeers === 1 ? "" : "s"}</small></div>
                  <div className="heading-actions">
                    <button className="button button-secondary button-small" onClick={() => setOpenWorkload(open ? null : key)} type="button">{open ? "Hide YAML" : "View YAML"}</button>
                    <button className="button button-secondary button-small" onClick={() => void copy(key, policy.policyYaml)} type="button">{copied === key ? "Copied" : "Copy"}</button>
                  </div>
                </div>
                {open ? <pre className="networkpolicy-yaml"><code>{policy.policyYaml}</code></pre> : null}
              </article>
            );
          })}
        </div> : <p className="panel-footnote">{data.configured ? "No pod-to-pod L4 flows were attributable to a named workload in the collection window." : "No Cilium/Hubble flows have been reported for this cluster yet — enroll the agent with Hubble export to generate policies from observed traffic."}</p>}
        <p className="panel-footnote">{data.disclaimer}</p>
      </> : null}
    </section>
  );
}
