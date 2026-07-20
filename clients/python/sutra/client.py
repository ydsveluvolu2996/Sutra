"""Idiomatic, dependency-free Python client for the Sutra Public API v1.

Uses only the standard library (``urllib``) so it installs with zero third-party
dependencies. If you prefer ``requests``, the request surface is small enough to
swap ``_request`` — but stdlib is the default to keep deployments lean.

Keep the endpoint surface in ``ENDPOINTS`` in lock-step with the OpenAPI spec;
the drift guard in ``tests/public-api-sdk-contract.test.ts`` enforces this by
parsing this module.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import (
    Any,
    Callable,
    Dict,
    Iterator,
    List,
    NamedTuple,
    Optional,
    TypeVar,
)

from .types import (
    Case,
    CasePage,
    CaseStatusRequest,
    ComplianceReport,
    FindingPage,
    ResourcePage,
    SnapshotStatus,
    VulnerabilityPage,
)

__all__ = [
    "SutraClient",
    "SutraApiError",
    "SutraAuthError",
    "SutraScopeError",
    "SutraBadRequestError",
    "SutraRateLimitError",
    "Endpoint",
    "ENDPOINTS",
]

T = TypeVar("T")


class Endpoint(NamedTuple):
    """HTTP method + templated path + the client method that services it."""

    method: str
    path: str
    client_method: str


# One entry per OpenAPI operation. Paths and methods must match the spec exactly.
ENDPOINTS: List[Endpoint] = [
    Endpoint("GET", "/resources", "list_resources"),
    Endpoint("GET", "/findings", "list_findings"),
    Endpoint("GET", "/cases", "list_cases"),
    Endpoint("PATCH", "/cases/{caseId}", "update_case_status"),
    Endpoint("GET", "/snapshots", "get_snapshots"),
    Endpoint("GET", "/compliance", "get_compliance"),
    Endpoint("GET", "/vulnerabilities", "list_vulnerabilities"),
]


class SutraApiError(Exception):
    """Base class for every error surfaced by the client."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(f"{status} {code}: {message}")
        self.status = status
        self.code = code
        self.api_message = message


class SutraAuthError(SutraApiError):
    """401 - the token is missing, unknown, revoked or expired."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(401, code, message)


class SutraScopeError(SutraApiError):
    """403 - the token does not carry the scope this endpoint requires."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(403, code, message)


class SutraBadRequestError(SutraApiError):
    """400 - a malformed request (bad cursor, limit, body or missing key)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(400, code, message)


class SutraRateLimitError(SutraApiError):
    """429 - the per-minute quota (120 req/min) was exceeded."""

    def __init__(self, code: str, message: str, retry_after_seconds: Optional[int]) -> None:
        super().__init__(429, code, message)
        self.retry_after_seconds = retry_after_seconds


@dataclass
class SutraClient:
    """A tenant-scoped client for the Sutra Public API.

    Args:
        base_url: API root, e.g. ``https://app.sutra.example/api/public/v1``.
        token: Service-account token (``sutra_pat_...``), sent as a Bearer credential.
        timeout: Per-request socket timeout in seconds.
    """

    base_url: str
    token: str
    timeout: float = 30.0

    def __post_init__(self) -> None:
        self.base_url = self.base_url.rstrip("/")

    # --- Reads -------------------------------------------------------------

    def list_resources(self, cursor: Optional[str] = None, limit: Optional[int] = None) -> ResourcePage:
        """List a page of normalized resources from the published snapshot."""
        return self._request("GET", self._with_query("/resources", cursor, limit))

    def list_findings(self, cursor: Optional[str] = None, limit: Optional[int] = None) -> FindingPage:
        """List a page of posture findings from the published snapshot."""
        return self._request("GET", self._with_query("/findings", cursor, limit))

    def list_cases(self, cursor: Optional[str] = None, limit: Optional[int] = None) -> CasePage:
        """List a page of finding cases."""
        return self._request("GET", self._with_query("/cases", cursor, limit))

    def get_snapshots(self) -> SnapshotStatus:
        """Active snapshot metadata, coverage and the 20 most recent sync runs."""
        body = self._request("GET", "/snapshots")
        return body["data"]

    def get_compliance(self) -> ComplianceReport:
        """Per-framework compliance readiness summaries with disclaimers."""
        body = self._request("GET", "/compliance")
        return body["data"]

    def list_vulnerabilities(self, cursor: Optional[str] = None, limit: Optional[int] = None) -> VulnerabilityPage:
        """List a page of cloud vulnerability findings."""
        return self._request("GET", self._with_query("/vulnerabilities", cursor, limit))

    # --- Writes ------------------------------------------------------------

    def update_case_status(self, case_id: str, status: CaseStatusRequest, idempotency_key: str) -> Case:
        """Transition a case's status.

        Idempotent: the same ``idempotency_key`` replays the stored response,
        and reusing it with a different body is a 409.
        """
        path = "/cases/" + urllib.parse.quote(case_id, safe="")
        body = self._request("PATCH", path, body={"status": status}, idempotency_key=idempotency_key)
        return body["data"]

    # --- Pagination --------------------------------------------------------

    def paginate(
        self,
        fetch_page: Callable[[Optional[str]], Dict[str, Any]],
        cursor: Optional[str] = None,
    ) -> Iterator[Dict[str, Any]]:
        """Yield each page of a paginated endpoint, following ``page.next``.

        Example::

            for page in client.paginate(lambda c: client.list_findings(cursor=c)):
                for finding in page["data"]:
                    ...
        """
        while True:
            page = fetch_page(cursor)
            yield page
            cursor = page["page"]["next"]
            if cursor is None:
                break

    def collect(
        self,
        fetch_page: Callable[[Optional[str]], Dict[str, Any]],
        cursor: Optional[str] = None,
    ) -> List[Any]:
        """Collect every item across all pages into one list."""
        items: List[Any] = []
        for page in self.paginate(fetch_page, cursor):
            items.extend(page["data"])
        return items

    # --- Internals ---------------------------------------------------------

    def _with_query(self, path: str, cursor: Optional[str], limit: Optional[int]) -> str:
        params: List[tuple] = []
        if cursor is not None:
            params.append(("cursor", cursor))
        if limit is not None:
            params.append(("limit", str(limit)))
        if not params:
            return path
        return path + "?" + urllib.parse.urlencode(params)

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Any:
        headers = {
            "authorization": "Bearer " + self.token,
            "accept": "application/json",
        }
        data: Optional[bytes] = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        if idempotency_key is not None:
            headers["idempotency-key"] = idempotency_key

        request = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raise self._to_error(error) from None

    def _to_error(self, error: urllib.error.HTTPError) -> SutraApiError:
        status = error.code
        code = "UNKNOWN"
        message = "Request failed with status " + str(status)
        try:
            payload = json.loads(error.read().decode("utf-8"))
            envelope = payload.get("error")
            if isinstance(envelope, dict):
                code = str(envelope.get("code", code))
                message = str(envelope.get("message", message))
        except (ValueError, AttributeError):
            pass  # non-JSON error body; keep the defaults

        if status == 401:
            return SutraAuthError(code, message)
        if status == 403:
            return SutraScopeError(code, message)
        if status == 400:
            return SutraBadRequestError(code, message)
        if status == 429:
            header = error.headers.get("retry-after") if error.headers is not None else None
            retry_after = int(header) if header is not None and header.isdigit() else None
            return SutraRateLimitError(code, message, retry_after)
        return SutraApiError(status, code, message)
