"use client";

import { useMemo, useState } from "react";
import { awsAccounts, customers, resources, securityGroups } from "../../lib/demo-data";

function publicIngressCount(group: (typeof securityGroups)[number]) {
  return group.ingress.filter((rule) => rule.ipv4Ranges.includes("0.0.0.0/0") || rule.ipv6Ranges.includes("::/0")).length;
}

export function InventoryBrowser() {
  const [query, setQuery] = useState("");
  const [service, setService] = useState("all");
  const [customer, setCustomer] = useState("all");
  const customerMap = useMemo(() => new Map(customers.map((item) => [item.id, item.name])), []);
  const accountMap = useMemo(() => new Map(awsAccounts.map((item) => [item.id, item])), []);
  const services = useMemo(() => [...new Set(resources.map((resource) => resource.service))].sort(), []);
  const filtered = useMemo(() => resources.filter((resource) => {
    const account = accountMap.get(resource.accountId);
    const haystack = `${resource.name} ${resource.nativeId} ${resource.resourceType} ${resource.region} ${account?.awsAccountId ?? ""}`.toLowerCase();
    return (service === "all" || resource.service === service) && (customer === "all" || resource.customerId === customer) && haystack.includes(query.toLowerCase());
  }), [accountMap, customer, query, service]);

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Configuration management database</p><h1>AWS resource inventory</h1><p className="page-subtitle">Search normalized assets, ownership, relationships, and security-group exposure with source freshness.</p></div>
        <div className="heading-actions"><button className="button button-secondary" type="button">Export current view</button><a className="button button-primary" href="/onboard">Connect account</a></div>
      </section>
      <div className="trust-strip" role="note"><span className="trust-icon">i</span><span><strong>Inventory and analyze mode.</strong> This foundation does not create, change, or delete customer resources or security-group rules.</span><a href="/controls">Why read-only?</a></div>

      <section className="inventory-stats">
        <article><small>Normalized resources</small><strong>{resources.length}</strong><span>Observed 15 Jul 2026 · 06:30 UTC</span></article>
        <article><small>Security groups</small><strong>{securityGroups.length}</strong><span>{securityGroups.filter((group) => publicIngressCount(group) > 0).length} with public ingress</span></article>
        <article><small>Resource types</small><strong>{new Set(resources.map((item) => item.resourceType)).size}</strong><span>{services.length} AWS services</span></article>
        <article><small>Coverage</small><strong>100%</strong><span>For the bounded demo collector pack</span></article>
      </section>

      <section className="panel inventory-panel">
        <div className="panel-heading"><div><p className="eyebrow">Current projection</p><h2>Resources</h2></div><span className="result-count">{filtered.length} results</span></div>
        <div className="filter-bar">
          <label className="search-field"><span className="sr-only">Search resources</span><input className="filter-control" placeholder="Search name, ID, account or region" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label><span className="sr-only">Filter by service</span><select className="filter-control" value={service} onChange={(event) => setService(event.target.value)}><option value="all">All services</option>{services.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}</select></label>
          <label><span className="sr-only">Filter by customer</span><select className="filter-control" value={customer} onChange={(event) => setCustomer(event.target.value)}><option value="all">All customers</option>{customers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          {(query || service !== "all" || customer !== "all") ? <button className="button button-secondary button-small" onClick={() => { setQuery(""); setService("all"); setCustomer("all"); }} type="button">Clear</button> : null}
        </div>
        <div className="data-table cmdb-table" role="table" aria-label="AWS resources">
          <div className="data-row data-header" role="row"><span>Service</span><span>Resource</span><span>Customer / account</span><span>Region</span><span>State</span><span>Last seen</span></div>
          {filtered.map((resource) => {
            const account = accountMap.get(resource.accountId);
            return <div className="data-row" role="row" key={resource.id}>
              <span><span className="service-chip">{resource.service.toUpperCase()}</span></span>
              <span className="primary-cell"><strong>{resource.name}</strong><small>{resource.resourceType} · {resource.nativeId}</small></span>
              <span className="primary-cell"><strong>{customerMap.get(resource.customerId)}</strong><small>{account?.awsAccountId}</small></span>
              <span><code className="region-code">{resource.region}</code></span>
              <span><span className={`resource-state state-${resource.state}`}>{resource.state}</span></span>
              <span className="muted-cell">{new Date(resource.lastSeenAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}</span>
            </div>;
          })}
          {filtered.length === 0 ? <div className="empty-state"><strong>No matching resources</strong><span>Adjust or clear the current filters.</span></div> : null}
        </div>
      </section>

      <section className="panel security-group-panel">
        <div className="panel-heading"><div><p className="eyebrow">Exposure analyzer</p><h2>Security groups</h2></div><a className="text-link" href="/findings">Open related findings →</a></div>
        <div className="security-group-grid">
          {securityGroups.map((group) => {
            const publicRules = publicIngressCount(group);
            const account = accountMap.get(group.accountId);
            return <article className="security-group-card" key={group.id}>
              <div><span className="service-chip">EC2</span><span className={publicRules ? "exposure exposure-open" : "exposure exposure-closed"}>{publicRules ? `${publicRules} public rule${publicRules > 1 ? "s" : ""}` : "No public ingress"}</span></div>
              <h3>{group.name}</h3><p>{group.groupId} · {group.region}</p>
              <dl><div><dt>Ingress</dt><dd>{group.ingress.length}</dd></div><div><dt>Egress</dt><dd>{group.egress.length}</dd></div><div><dt>VPC</dt><dd>{group.vpcId}</dd></div></dl>
              <small>{customerMap.get(group.customerId)} · {account?.awsAccountId}</small>
            </article>;
          })}
        </div>
      </section>
    </>
  );
}
