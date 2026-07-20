"""Typed payloads for the Sutra Public API v1.

These ``TypedDict`` shapes mirror the OpenAPI spec served at
``GET /api/public/v1/openapi.json``, which in turn mirrors the real handler
outputs. Responses are returned as plain ``dict`` objects (parsed JSON) that
conform to these types, so no runtime conversion layer is needed and nothing is
silently dropped. Edit these by hand when a schema changes; the endpoint
surface is drift-guarded by ``tests/public-api-sdk-contract.test.ts``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, TypedDict

FindingSeverity = Literal["critical", "high", "medium", "low", "informational"]
FindingStatus = Literal["open", "acknowledged", "resolved", "suppressed"]
CaseStatus = Literal["open", "investigating", "resolved", "closed"]
CaseStatusRequest = Literal["open", "investigating", "resolved", "accepted_risk"]
CasePriority = Literal["critical", "high", "medium", "low"]
CaseSlaState = Literal["on_track", "due_soon", "overdue", "met", "missed"]
CaseActivityKind = Literal[
    "created", "status_changed", "assignment_changed",
    "priority_changed", "due_date_changed", "note_added",
]
CoverageStatus = Literal["succeeded", "partial", "failed", "skipped"]
SyncStatus = Literal["queued", "running", "partial", "succeeded", "failed", "cancelled"]
VulnerabilitySeverity = Literal["critical", "high", "medium", "low", "unknown"]
VulnerabilityStatus = Literal["open", "resolved"]


class PageInfo(TypedDict):
    next: Optional[str]


class Resource(TypedDict):
    resourceKey: str
    service: str
    resourceType: str
    region: str
    name: Optional[str]
    state: str
    arn: Optional[str]
    nativeId: str
    tags: Dict[str, str]


class Finding(TypedDict):
    fingerprint: str
    resourceKey: Optional[str]
    controlKey: str
    controlVersion: str
    severity: FindingSeverity
    status: FindingStatus
    title: str
    summary: str
    remediation: str
    evidence: Dict[str, Any]
    evaluatedAt: str


class CaseAssignee(TypedDict):
    membershipId: str
    userId: str
    displayName: str
    email: str
    role: str


class CaseActivity(TypedDict):
    id: str
    caseId: str
    kind: CaseActivityKind
    actorId: str
    actorName: str
    occurredAt: str
    detail: Dict[str, Optional[str]]
    previousHash: Optional[str]
    eventHash: str


class Case(TypedDict):
    id: str
    caseNumber: str
    orgId: str
    customerId: str
    connectionId: str
    findingFingerprint: str
    findingSnapshotId: str
    findingSeverity: str
    title: str
    status: CaseStatus
    priority: CasePriority
    assignee: Optional[CaseAssignee]
    dueAt: str
    resolvedAt: Optional[str]
    closedAt: Optional[str]
    createdAt: str
    updatedAt: str
    slaState: CaseSlaState
    activities: List[CaseActivity]


class CoverageEntry(TypedDict, total=False):
    collectorKey: str
    region: str
    status: CoverageStatus
    itemsObserved: int
    pagesObserved: int
    errorCode: str
    message: str


class SnapshotOrigin(TypedDict):
    kind: Literal["unknown", "simulated_fixture", "aws_sandbox"]
    fixtureId: Optional[str]
    fixtureVersion: Optional[str]


class ActiveSnapshot(TypedDict):
    id: str
    collectedAt: str
    coverageState: Literal["complete", "partial"]
    snapshotSha256: str
    origin: SnapshotOrigin


class SyncRun(TypedDict):
    id: str
    connectionId: str
    status: SyncStatus
    coverageState: Literal["complete", "partial", "unknown"]
    totals: Dict[str, Any]
    startedAt: Optional[str]
    finishedAt: Optional[str]
    createdAt: str


class SnapshotStatus(TypedDict):
    activeSnapshot: Optional[ActiveSnapshot]
    coverage: List[CoverageEntry]
    syncRuns: List[SyncRun]


class ReadinessScope(TypedDict):
    tenantId: Optional[str]
    collectionId: Optional[str]
    collectedAt: Optional[str]


class ReadinessStateCounts(TypedDict):
    PASS: int
    FAIL: int
    UNKNOWN: int
    NOT_COLLECTED: int


class FrameworkSummary(TypedDict):
    id: str
    title: str
    summary: ReadinessStateCounts
    disclaimer: str


class ComplianceReport(TypedDict):
    scope: ReadinessScope
    frameworks: List[FrameworkSummary]


class Vulnerability(TypedDict):
    id: str
    findingKey: str
    resourceKey: str
    resourceKind: str
    cveId: Optional[str]
    packageName: Optional[str]
    installedVersion: Optional[str]
    fixedVersion: Optional[str]
    severity: VulnerabilitySeverity
    cvssScore: Optional[float]
    source: str
    status: VulnerabilityStatus
    firstSeenMs: int
    lastSeenMs: int


class ResourcePage(TypedDict):
    data: List[Resource]
    page: PageInfo


class FindingPage(TypedDict):
    data: List[Finding]
    page: PageInfo


class CasePage(TypedDict):
    data: List[Case]
    page: PageInfo


class VulnerabilityPage(TypedDict):
    data: List[Vulnerability]
    page: PageInfo
