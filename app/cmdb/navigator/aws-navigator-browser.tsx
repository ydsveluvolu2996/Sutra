"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AwsNavigatorCoverageState,
  AwsNavigatorEnvelope,
  AwsNavigatorTypeView,
} from "../../../lib/aws-navigator";
import { compactIdentifier, formatTimestamp } from "../../components/use-pilot-state";

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const BOOKMARK_ID = /^[a-z0-9][a-z0-9./-]{0,260}$/u;
const MAX_RECENT = 8;
const MAX_PINNED = 12;

interface Bookmark {
  readonly id: string;
  readonly title: string;
  readonly href: string;
  readonly kind: AwsNavigatorEnvelope["destination"]["kind"];
}

interface BookmarkState {
  readonly recent: readonly Bookmark[];
  readonly pinned: readonly Bookmark[];
}

interface RequestScope {
  readonly connectionId: string | null;
  readonly region: string;
}

interface NavigatorResponseState {
  readonly key: string;
  readonly envelope: AwsNavigatorEnvelope | null;
  readonly error: string | null;
}

const EMPTY_BOOKMARKS: BookmarkState = Object.freeze({ recent: [], pinned: [] });

function coverageLabel(state: AwsNavigatorCoverageState): string {
  switch (state) {
    case "complete": return "Complete";
    case "not_configured": return "Not configured";
    case "waiting": return "Waiting for collection";
    case "not_collected": return "Not collected";
    case "permission_required": return "Permission required";
    case "partial": return "Partial";
    case "failed": return "Failed";
    case "retained": return "Last good retained";
    case "stale": return "Stale";
    case "unavailable": return "Unavailable";
  }
}

function coverageTone(state: AwsNavigatorCoverageState): string {
  if (state === "complete") return "status-positive";
  if (state === "permission_required" || state === "failed") return "status-negative";
  return "status-medium";
}

function bookmarkKey(connectionId: string | null): string {
  return `sutra.aws-navigator.destinations.v1.${connectionId ?? "catalog-only"}`;
}

function validBookmark(value: unknown): value is Bookmark {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<Bookmark>;
  return typeof candidate.id === "string" && BOOKMARK_ID.test(candidate.id)
    && typeof candidate.title === "string" && candidate.title.length > 0 && candidate.title.length <= 160
    && typeof candidate.href === "string" && candidate.href.startsWith("/cmdb/navigator") && candidate.href.length <= 512
    && (candidate.kind === "category" || candidate.kind === "service" || candidate.kind === "resource_type");
}

function readBookmarks(connectionId: string | null): BookmarkState {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(bookmarkKey(connectionId)) ?? "null");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return EMPTY_BOOKMARKS;
    const candidate = parsed as { recent?: unknown; pinned?: unknown };
    return {
      recent: Array.isArray(candidate.recent) ? candidate.recent.filter(validBookmark).slice(0, MAX_RECENT) : [],
      pinned: Array.isArray(candidate.pinned) ? candidate.pinned.filter(validBookmark).slice(0, MAX_PINNED) : [],
    };
  } catch {
    return EMPTY_BOOKMARKS;
  }
}

function writeBookmarks(connectionId: string | null, state: BookmarkState): void {
  try {
    window.localStorage.setItem(bookmarkKey(connectionId), JSON.stringify(state));
  } catch { /* Navigation remains functional when browser storage is unavailable. */ }
}

function TypeCount({ type }: { readonly type: AwsNavigatorTypeView }) {
  if (type.coverage.authoritativeCount !== null) {
    return <><strong>{type.coverage.authoritativeCount.toLocaleString()}</strong><small>authoritative in this boundary</small></>;
  }
  if (type.coverage.lastKnownCount !== null) {
    return <><strong>Last known {type.coverage.lastKnownCount.toLocaleString()}</strong><small>not a current count</small></>;
  }
  return <><strong>—</strong><small>{coverageLabel(type.coverage.state)}</small></>;
}

export function AwsNavigatorBrowser({
  segments,
  initialConnectionId = null,
  initialRegion = "all",
  initialQuery = "",
}: {
  readonly segments: readonly string[];
  readonly initialConnectionId?: string | null;
  readonly initialRegion?: string;
  readonly initialQuery?: string;
}) {
  const path = segments.join("/");
  const [requestScope, setRequestScope] = useState<RequestScope>({
    connectionId: initialConnectionId !== null && CONNECTION_ID.test(initialConnectionId) ? initialConnectionId : null,
    region: initialRegion,
  });
  const [queryInput, setQueryInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery.trim());
  const [response, setResponse] = useState<NavigatorResponseState | null>(null);
  const [bookmarks, setBookmarks] = useState<BookmarkState>(EMPTY_BOOKMARKS);
  const bookmarkScopeRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    const parameters = new URLSearchParams();
    if (requestScope.connectionId !== null) parameters.set("connectionId", requestScope.connectionId);
    if (path !== "") parameters.set("path", path);
    if (requestScope.region !== "all") parameters.set("region", requestScope.region);
    if (query !== "") parameters.set("q", query);
    const controller = new AbortController();
    const key = `${path}\n${requestScope.connectionId ?? ""}\n${requestScope.region}\n${query}`;
    void fetch(`/api/v1/cmdb/navigator?${parameters.toString()}`, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json().catch(() => null) as (AwsNavigatorEnvelope & { error?: { message?: string } }) | null;
      if (!response.ok || body === null) throw new Error(body?.error?.message ?? "AWS Navigator is unavailable");
      return body;
    }).then((body) => {
      setResponse({ key, envelope: body, error: null });
      const url = new URL(window.location.href);
      if (body.scope.connectionId === null) url.searchParams.delete("connectionId");
      else url.searchParams.set("connectionId", body.scope.connectionId);
      if (requestScope.region === "all") url.searchParams.delete("region");
      else url.searchParams.set("region", requestScope.region);
      if (query === "") url.searchParams.delete("q");
      else url.searchParams.set("q", query);
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      setBookmarks((current) => {
        const base = bookmarkScopeRef.current === body.scope.connectionId
          ? current
          : readBookmarks(body.scope.connectionId);
        bookmarkScopeRef.current = body.scope.connectionId;
        if (body.destination.kind === "root") return base;
        const bookmark: Bookmark = {
          id: `${body.destination.kind}/${body.destination.id}`,
          title: body.destination.title,
          href: body.destination.href,
          kind: body.destination.kind,
        };
        const next = { ...base, recent: [bookmark, ...base.recent.filter((item) => item.id !== bookmark.id)].slice(0, MAX_RECENT) };
        writeBookmarks(body.scope.connectionId, next);
        return next;
      });
    }).catch((caught: unknown) => {
      if (controller.signal.aborted) return;
      setResponse({
        key,
        envelope: null,
        error: caught instanceof Error ? caught.message : "AWS Navigator is unavailable",
      });
    });
    return () => controller.abort();
  }, [path, query, requestScope]);

  const requestKey = `${path}\n${requestScope.connectionId ?? ""}\n${requestScope.region}\n${query}`;
  const envelope = response?.key === requestKey ? response.envelope : null;
  const error = response?.key === requestKey ? response.error : null;
  const loading = response?.key !== requestKey;

  const currentBookmark = useMemo<Bookmark | null>(() => envelope === null || envelope.destination.kind === "root"
    ? null
    : {
        id: `${envelope.destination.kind}/${envelope.destination.id}`,
        title: envelope.destination.title,
        href: envelope.destination.href,
        kind: envelope.destination.kind,
      }, [envelope]);
  const currentPinned = currentBookmark !== null && bookmarks.pinned.some((item) => item.id === currentBookmark.id);

  function togglePin(): void {
    if (currentBookmark === null || envelope === null) return;
    setBookmarks((current) => {
      const pinned = current.pinned.some((item) => item.id === currentBookmark.id)
        ? current.pinned.filter((item) => item.id !== currentBookmark.id)
        : [currentBookmark, ...current.pinned].slice(0, MAX_PINNED);
      const next = { ...current, pinned };
      writeBookmarks(envelope.scope.connectionId, next);
      return next;
    });
  }

  function selectRegion(region: string): void {
    setRequestScope((current) => ({ ...current, region }));
  }

  return <>
    <section className="page-heading navigator-heading">
      <div>
        <p className="eyebrow">Configuration management database</p>
        <h1>{envelope?.destination.title ?? "AWS Navigator"}</h1>
        <p className="page-subtitle">Browse the canonical AWS taxonomy and distinguish catalog breadth from complete, current collector evidence.</p>
      </div>
      {currentBookmark ? <button className="button button-secondary" onClick={togglePin} type="button">{currentPinned ? "Unpin destination" : "Pin destination"}</button> : null}
    </section>

    <section className="panel navigator-command-bar" aria-label="AWS Navigator search and scope">
      <label className="navigator-search"><span>Search catalog and collected resources</span><input className="filter-control" type="search" value={queryInput} onChange={(event) => setQueryInput(event.target.value)} placeholder="VPC, subnet, ARN, tag, account…" /></label>
      <label><span>Region boundary</span><select className="filter-control" value={requestScope.region} onChange={(event) => selectRegion(event.target.value)}><option value="all">All collected Regions</option>{envelope?.scope.regions.map((region) => <option value={region} key={region}>{region}</option>)}</select></label>
      <div className="navigator-scope"><span>Account scope</span><strong>{envelope?.scope.customerName ?? (loading ? "Resolving scope…" : "Catalog only")}</strong><small>{envelope?.scope.accountId ?? "No authorized AWS connection"}</small></div>
    </section>

    {loading ? <div className="loading-state" role="status"><span className="loading-spinner" />Loading tenant-scoped AWS catalog evidence…</div> : null}
    {error ? <div className="page-alert page-alert-error" role="alert"><strong>AWS Navigator is unavailable</strong><span>{error}</span></div> : null}

    {envelope ? <>
      <nav className="navigator-breadcrumbs" aria-label="Breadcrumb">{envelope.breadcrumbs.map((item, index) => <span key={item.href}>{index > 0 ? <b aria-hidden="true">/</b> : null}<a href={item.href} aria-current={index === envelope.breadcrumbs.length - 1 ? "page" : undefined}>{item.label}</a></span>)}</nav>

      {envelope.scope.connectionId === null ? <div className="page-alert page-alert-warning" role="note"><strong>Catalog-only view</strong><span>No authorized AWS connection is selected. Resource counts remain unavailable; they are not reported as zero.</span></div>
        : envelope.scope.activeSnapshot === null ? <div className="page-alert page-alert-warning" role="note"><strong>Waiting for the first complete collection</strong><span>The catalog is available, but no inventory count is authoritative for {envelope.scope.accountId}.</span></div>
        : envelope.scope.freshness === "stale" ? <div className="page-alert page-alert-warning" role="note"><strong>Last complete snapshot is stale</strong><span>Collected values are labeled last known and are not presented as current counts.</span></div>
        : envelope.scope.latestAttempt && envelope.scope.latestAttempt.status !== "succeeded" ? <div className="page-alert page-alert-warning" role="note"><strong>Latest collection attempt: {envelope.scope.latestAttempt.status}</strong><span>The previous complete snapshot remains immutable; affected types disclose retained, partial, failed, or permission-required state.</span></div>
        : null}

      <section className="navigator-facts" aria-label="Catalog provenance">
        <article><small>Categories</small><strong>{envelope.catalog.categoryCount}</strong><span>captured Navigator taxonomy</span></article>
        <article><small>Services</small><strong>{envelope.catalog.serviceCount}</strong><span>approved destinations</span></article>
        <article><small>Reference types</small><strong>{envelope.catalog.referenceTypeCount}</strong><span>usable union, source anomaly retained</span></article>
        <article><small>Taggable types</small><strong>{envelope.catalog.taggableTypeCount}</strong><span>Tag Analyzer source inventory</span></article>
      </section>

      {query !== "" ? <section className="panel navigator-search-results">
        <div className="panel-heading"><div><p className="eyebrow">Server-scoped search</p><h2>Results for “{query}”</h2></div><span className="result-count">{envelope.searchResults.length} result{envelope.searchResults.length === 1 ? "" : "s"}</span></div>
        {envelope.searchResults.length > 0 ? <div className="navigator-result-list">{envelope.searchResults.map((result, index) => <a href={result.href} key={`${result.kind}:${result.href}:${index}`}><span className="service-chip">{result.kind.replace("_", " ")}</span><div><strong>{result.title}</strong><small>{result.subtitle}</small></div>{result.coverageState ? <b className={`status-pill ${coverageTone(result.coverageState)}`}>{coverageLabel(result.coverageState)}</b> : null}</a>)}</div>
          : <div className="empty-state"><strong>No matching authorized result</strong><span>Search covers the AWS catalog and resources in the selected account/Region boundary only.</span></div>}
      </section> : null}

      {query === "" && envelope.destination.kind === "root" && (bookmarks.pinned.length > 0 || bookmarks.recent.length > 0) ? <section className="navigator-shortcuts">
        {bookmarks.pinned.length > 0 ? <article className="panel"><div className="panel-heading"><div><p className="eyebrow">Personal shortcuts</p><h2>Pinned</h2></div></div><div className="navigator-link-list">{bookmarks.pinned.map((item) => <a href={item.href} key={item.id}><strong>{item.title}</strong><small>{item.kind.replace("_", " ")}</small></a>)}</div></article> : null}
        {bookmarks.recent.length > 0 ? <article className="panel"><div className="panel-heading"><div><p className="eyebrow">This browser</p><h2>Recent</h2></div></div><div className="navigator-link-list">{bookmarks.recent.map((item) => <a href={item.href} key={item.id}><strong>{item.title}</strong><small>{item.kind.replace("_", " ")}</small></a>)}</div></article> : null}
      </section> : null}

      {query === "" && envelope.categories.length > 0 ? <section className="navigator-card-grid">{envelope.categories.map((category) => <a className="panel navigator-card" href={category.href} key={category.id}><div><span className={`status-pill ${coverageTone(category.coverageState)}`}>{coverageLabel(category.coverageState)}</span><small>{category.serviceCount} services</small></div><h2>{category.name}</h2><p>{category.catalogTypeCount} catalog types · {category.implementedTypeCount} implemented</p><strong>{category.observedInCoveredTypes === null ? "No complete type coverage" : `${category.observedInCoveredTypes.toLocaleString()} observed in ${category.completeTypeCount} covered types`}</strong></a>)}</section> : null}

      {query === "" && envelope.services.length > 0 && envelope.destination.kind !== "resource_type" ? <section className="navigator-card-grid">{envelope.services.map((service) => <a className="panel navigator-card" href={service.href} key={service.id}><div><span className={`status-pill ${coverageTone(service.coverageState)}`}>{coverageLabel(service.coverageState)}</span><small>{service.catalogTypeCount} catalog types</small></div><h2>{service.name}</h2><p>{service.implementedTypeCount} implemented · {service.externallyAcceptedTypeCount} externally accepted</p><strong>{service.observedInCoveredTypes === null ? "No complete type coverage" : `${service.observedInCoveredTypes.toLocaleString()} observed in ${service.completeTypeCount} covered types`}</strong></a>)}</section> : null}

      {query === "" && envelope.resourceTypes.length > 0 ? <section className="panel navigator-types">
        <div className="panel-heading"><div><p className="eyebrow">Resource-type contract</p><h2>{envelope.destination.kind === "resource_type" ? envelope.destination.title : "Catalog types"}</h2></div><span className="result-count">{envelope.resourceTypes.length} type{envelope.resourceTypes.length === 1 ? "" : "s"}</span></div>
        <div className="navigator-type-list">{envelope.resourceTypes.map((type) => <article key={`${type.serviceId}/${type.id}`}>
          <div className="navigator-type-name"><a href={type.href}><strong>{type.name}</strong></a><small>{type.normalizedResourceType ?? "Adapter contract not assessed"}</small></div>
          <div className="navigator-type-maturity"><span>{type.origin === "sutra_extension" ? "Sutra extension" : "Reference catalog"}</span><b>{type.maturity.externallyAccepted ? "Externally accepted" : type.maturity.implemented ? "Implemented" : type.maturity.adapterPlanned ? "Adapter planned" : "Cataloged"}</b><small>{type.taggable ? "Taggable" : "Tag applicability not asserted"}</small></div>
          <div className="navigator-type-state"><span className={`status-pill ${coverageTone(type.coverage.state)}`}>{coverageLabel(type.coverage.state)}</span><small>{type.coverage.message}</small></div>
          <div className="navigator-type-count"><TypeCount type={type} />{type.coverage.retirementPendingCount > 0 ? <small>{type.coverage.retirementPendingCount} retirement pending</small> : null}</div>
          {envelope.destination.kind === "resource_type" ? <dl className="navigator-type-contract"><div><dt>Scope</dt><dd>{type.scope}</dd></div><div><dt>Partitions</dt><dd>{type.partitions.length ? type.partitions.join(", ") : "Not assessed"}</dd></div><div><dt>Collector</dt><dd>{type.collectorKey ?? "Not implemented"}</dd></div><div><dt>Required read operations</dt><dd>{type.requiredOperations.length ? type.requiredOperations.join(", ") : "Not assessed"}</dd></div><div><dt>Snapshot evidence</dt><dd>{envelope.scope.activeSnapshot ? `${formatTimestamp(envelope.scope.activeSnapshot.collectedAt)} · ${compactIdentifier(envelope.scope.activeSnapshot.snapshotSha256, 18)}` : "No complete snapshot"}</dd></div></dl> : null}
        </article>)}</div>
      </section> : null}

      <p className="navigator-footnote">Catalog version {envelope.catalog.version}. Catalog membership does not imply collection, configuration, permissions, freshness, implementation, or external acceptance. The captured source-count anomaly remains documented rather than becoming a synthetic resource type.</p>
    </> : null}
  </>;
}
