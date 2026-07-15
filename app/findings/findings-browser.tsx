"use client";

import { useMemo, useState } from "react";
import { awsAccounts, customers, demoFindings, demoPostureSummary } from "../../lib/demo-data";

const severityOrder = ["critical", "high", "medium", "low", "informational"] as const;

export function FindingsBrowser() {
  const [severity, setSeverity] = useState("all");
  const [customer, setCustomer] = useState("all");
  const [query, setQuery] = useState("");
  const customerMap = useMemo(() => new Map(customers.map((item) => [item.id, item.name])), []);
  const accountMap = useMemo(() => new Map(awsAccounts.map((item) => [item.id, item])), []);
  const filtered = useMemo(() => demoFindings.filter((finding) => {
    const haystack = `${finding.title} ${finding.description} ${finding.target.name} ${finding.service} ${finding.region}`.toLowerCase();
    return (severity === "all" || finding.severity === severity) && (customer === "all" || finding.customerId === customer) && haystack.includes(query.toLowerCase());
  }), [customer, query, severity]);

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Evidence-backed posture</p><h1>Security findings</h1><p className="page-subtitle">Configuration and coverage observations with deterministic evidence and suggested remediation.</p></div>
        <div className="heading-actions"><a className="button button-secondary" href="/controls">Control library</a><button className="button button-primary" type="button">Run assessment</button></div>
      </section>
      <div className="trust-strip" role="note"><span className="trust-icon">i</span><span><strong>Scope matters.</strong> These are configuration assessments from fictional demo data, not proof of compromise, runtime threat detection, or CVE scanning.</span><a href="/controls#architecture">See limitations</a></div>

      <section className="finding-summary">
        {severityOrder.slice(0, 4).map((level) => <article key={level}><span className={`severity-dot severity-${level}`} /><small>{level}</small><strong>{demoPostureSummary.bySeverity[level]}</strong></article>)}
        <article><span className="severity-dot severity-info" /><small>Affected accounts</small><strong>{demoPostureSummary.affectedAccounts}</strong></article>
      </section>

      <section className="panel findings-panel">
        <div className="panel-heading"><div><p className="eyebrow">Open queue</p><h2>Current findings</h2></div><span className="result-count">{filtered.length} results</span></div>
        <div className="filter-bar">
          <label className="search-field"><span className="sr-only">Search findings</span><input className="filter-control" placeholder="Search finding, target, service or region" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label><span className="sr-only">Filter by severity</span><select className="filter-control" value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="all">All severities</option>{severityOrder.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label><span className="sr-only">Filter by customer</span><select className="filter-control" value={customer} onChange={(event) => setCustomer(event.target.value)}><option value="all">All customers</option>{customers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          {(query || severity !== "all" || customer !== "all") ? <button className="button button-secondary button-small" onClick={() => { setQuery(""); setSeverity("all"); setCustomer("all"); }} type="button">Clear</button> : null}
        </div>
        <div className="finding-list">
          {filtered.map((finding) => {
            const account = accountMap.get(finding.accountId);
            return <details className="finding-item" key={finding.id}>
              <summary>
                <span className={`severity-badge severity-${finding.severity}`}>{finding.severity}</span>
                <span className="finding-title"><strong>{finding.title}</strong><small>{finding.target.name} · {finding.region}</small></span>
                <span className="finding-scope"><strong>{customerMap.get(finding.customerId)}</strong><small>{account?.awsAccountId}</small></span>
                <span className="finding-service">{finding.service.toUpperCase()}</span>
                <span className="finding-chevron">⌄</span>
              </summary>
              <div className="finding-detail">
                <div><p className="eyebrow">Observation</p><p>{finding.description}</p><p className="limitation-note">Source: deterministic configuration check · capability: configuration assessment</p></div>
                <div><p className="eyebrow">Evidence</p><dl>{Object.entries(finding.evidence).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{Array.isArray(value) ? value.join(", ") : String(value)}</dd></div>)}</dl></div>
                <div><p className="eyebrow">Suggested remediation</p><p>{finding.remediation}</p><button className="button button-secondary button-small" type="button">Acknowledge</button></div>
              </div>
            </details>;
          })}
          {filtered.length === 0 ? <div className="empty-state"><strong>No matching findings</strong><span>Adjust or clear the current filters.</span></div> : null}
        </div>
      </section>
    </>
  );
}
