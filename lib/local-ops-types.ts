import { parsePilotSnapshot } from "./pilot-boundary.ts";
import type { PilotSnapshotPayload } from "./pilot-types";

export type LocalFixtureVersion = "2026.07.0" | "2026.07.1";
export type LocalFixtureJobStatus = "pending" | "leased" | "succeeded" | "dead_letter";

export interface LocalFixtureDescriptor {
  readonly fixtureId: string;
  readonly customerName: string;
  readonly customerId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: "aws";
  readonly enabledRegions: readonly string[];
  readonly availableVersions: readonly LocalFixtureVersion[];
}

export interface LocalFixtureJobSummary {
  readonly jobId: string;
  readonly tenantId: string;
  readonly kind: "fixture.inventory.collect";
  readonly fixtureId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly version: LocalFixtureVersion;
  readonly status: LocalFixtureJobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly availableAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly lastFailure: {
    readonly code: string;
    readonly message: string;
    readonly failedAt: string;
    readonly retryAt: string | null;
  } | null;
}

export interface LocalFixtureJobResult {
  readonly job: LocalFixtureJobSummary;
  readonly fixtureId: string;
  readonly version: LocalFixtureVersion;
  readonly customerId: string;
  readonly connectionId: string;
  readonly tenantId: string;
  readonly snapshot: PilotSnapshotPayload;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,191}$/u;
const CUSTOMER_ID = /^cust_[a-f0-9]{32}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const JOB_ID = /^job_[a-f0-9]{48}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z0-9-]+-\d$/u;

function invalid(): never {
  throw new Error("The signed local operations response is invalid");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = record(value);
  const actual = Object.keys(result);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid();
  return result;
}

function text(value: unknown, pattern: RegExp, maximum = 256): string {
  if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) invalid();
  return value;
}

function timestamp(value: unknown): string {
  const result = text(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u, 32);
  if (!Number.isFinite(Date.parse(result))) invalid();
  return result;
}

function version(value: unknown): LocalFixtureVersion {
  if (value !== "2026.07.0" && value !== "2026.07.1") invalid();
  return value;
}

function nonnegativeInteger(value: unknown, maximum = 1_000_000): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) invalid();
  return value as number;
}

function positiveInteger(value: unknown, maximum = 1_000_000): number {
  const result = nonnegativeInteger(value, maximum);
  if (result < 1) invalid();
  return result;
}

function parseFixture(value: unknown): LocalFixtureDescriptor {
  const item = exact(value, [
    "fixtureId", "customerName", "customerId", "tenantId", "connectionId", "accountId",
    "partition", "enabledRegions", "availableVersions",
  ]);
  if (item.partition !== "aws" || !Array.isArray(item.enabledRegions) || !Array.isArray(item.availableVersions)) invalid();
  const enabledRegions = item.enabledRegions.map((region) => text(region, REGION, 32));
  const availableVersions = item.availableVersions.map(version);
  if (enabledRegions.length < 1 || enabledRegions.length > 32 || new Set(enabledRegions).size !== enabledRegions.length) invalid();
  if (availableVersions.length < 1 || new Set(availableVersions).size !== availableVersions.length) invalid();
  return {
    fixtureId: text(item.fixtureId, ID),
    customerName: text(item.customerName, /^[^<>\u0000-\u001f\u007f]{2,100}$/u, 100),
    customerId: text(item.customerId, CUSTOMER_ID),
    tenantId: text(item.tenantId, ID),
    connectionId: text(item.connectionId, CONNECTION_ID),
    accountId: text(item.accountId, ACCOUNT_ID, 12),
    partition: "aws",
    enabledRegions,
    availableVersions,
  };
}

export function parseLocalFixtureCatalog(value: unknown): readonly LocalFixtureDescriptor[] {
  const root = exact(value, ["fixtures"]);
  if (!Array.isArray(root.fixtures) || root.fixtures.length > 50) invalid();
  const fixtures = root.fixtures.map(parseFixture);
  for (const field of ["fixtureId", "customerId", "connectionId", "accountId"] as const) {
    if (new Set(fixtures.map((fixture) => fixture[field])).size !== fixtures.length) invalid();
  }
  return fixtures;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function parseFailure(value: unknown): LocalFixtureJobSummary["lastFailure"] {
  if (value === null) return null;
  const failure = exact(value, ["code", "message", "failedAt", "retryAt"]);
  return {
    code: text(failure.code, ID),
    message: text(failure.message, /^[^\u0000-\u001f\u007f]{1,1000}$/u, 1000),
    failedAt: timestamp(failure.failedAt),
    retryAt: nullableTimestamp(failure.retryAt),
  };
}

export function parseLocalFixtureJob(value: unknown): LocalFixtureJobSummary {
  const item = exact(value, [
    "jobId", "tenantId", "kind", "fixtureId", "customerId", "connectionId", "version",
    "status", "attempts", "maxAttempts", "availableAt", "createdAt", "updatedAt", "completedAt",
    "lastFailure",
  ]);
  if (item.kind !== "fixture.inventory.collect") invalid();
  if (item.status !== "pending" && item.status !== "leased" && item.status !== "succeeded" && item.status !== "dead_letter") invalid();
  const attempts = nonnegativeInteger(item.attempts, 1_000);
  const maxAttempts = positiveInteger(item.maxAttempts, 1_000);
  const createdAt = timestamp(item.createdAt);
  const updatedAt = timestamp(item.updatedAt);
  const completedAt = nullableTimestamp(item.completedAt);
  const lastFailure = parseFailure(item.lastFailure);
  if (
    attempts > maxAttempts ||
    Date.parse(updatedAt) < Date.parse(createdAt) ||
    ((item.status === "succeeded" || item.status === "dead_letter") !== (completedAt !== null)) ||
    (completedAt !== null && Date.parse(completedAt) < Date.parse(createdAt)) ||
    (item.status === "dead_letter" && lastFailure === null)
  ) invalid();
  return {
    jobId: text(item.jobId, JOB_ID),
    tenantId: text(item.tenantId, ID),
    kind: item.kind,
    fixtureId: text(item.fixtureId, ID),
    customerId: text(item.customerId, CUSTOMER_ID),
    connectionId: text(item.connectionId, CONNECTION_ID),
    version: version(item.version),
    status: item.status,
    attempts,
    maxAttempts,
    availableAt: timestamp(item.availableAt),
    createdAt,
    updatedAt,
    completedAt,
    lastFailure,
  };
}

export function parseLocalFixtureJobs(value: unknown): readonly LocalFixtureJobSummary[] {
  const root = exact(value, ["jobs", "count", "limit"]);
  if (!Array.isArray(root.jobs) || root.jobs.length > 100) invalid();
  const jobs = root.jobs.map(parseLocalFixtureJob);
  if (nonnegativeInteger(root.count, 100) !== jobs.length || positiveInteger(root.limit, 100) < jobs.length) invalid();
  return jobs;
}

export function parseLocalFixtureEnqueue(
  value: unknown,
  fixture: LocalFixtureDescriptor,
  expectedVersion: LocalFixtureVersion,
): { readonly created: boolean; readonly job: LocalFixtureJobSummary } {
  const root = exact(value, ["created", "job"]);
  if (typeof root.created !== "boolean") invalid();
  const job = parseLocalFixtureJob(root.job);
  if (
    job.tenantId !== fixture.tenantId ||
    job.fixtureId !== fixture.fixtureId ||
    job.customerId !== fixture.customerId ||
    job.connectionId !== fixture.connectionId ||
    job.version !== expectedVersion
  ) invalid();
  return { created: root.created, job };
}

export async function parseLocalFixtureResult(
  value: unknown,
  fixture: LocalFixtureDescriptor,
  expectedJobId: string,
  expectedVersion: LocalFixtureVersion,
): Promise<LocalFixtureJobResult> {
  const root = exact(value, ["job", "result"]);
  const job = parseLocalFixtureJob(root.job);
  const result = exact(root.result, ["jobId", "tenantId", "customerId", "connectionId", "fixtureId", "version", "snapshot"]);
  if (
    job.jobId !== expectedJobId || job.status !== "succeeded" ||
    job.tenantId !== fixture.tenantId ||
    job.fixtureId !== fixture.fixtureId || job.customerId !== fixture.customerId ||
    job.connectionId !== fixture.connectionId || job.version !== expectedVersion ||
    result.jobId !== job.jobId || result.tenantId !== fixture.tenantId ||
    result.customerId !== fixture.customerId || result.connectionId !== fixture.connectionId ||
    result.fixtureId !== fixture.fixtureId || result.version !== expectedVersion
  ) invalid();
  const snapshot = await parsePilotSnapshot(result.snapshot, {
    jobId: expectedJobId,
    connectionId: fixture.connectionId,
    accountId: fixture.accountId,
    partition: fixture.partition,
  });
  return {
    job,
    fixtureId: fixture.fixtureId,
    version: expectedVersion,
    customerId: fixture.customerId,
    connectionId: fixture.connectionId,
    tenantId: fixture.tenantId,
    snapshot,
  };
}

export async function parseLocalFixtureResultFromCatalog(
  value: unknown,
  fixtures: readonly LocalFixtureDescriptor[],
  expectedJobId: string,
): Promise<LocalFixtureJobResult> {
  const root = exact(value, ["job", "result"]);
  const job = parseLocalFixtureJob(root.job);
  const fixture = fixtures.find((candidate) =>
    candidate.fixtureId === job.fixtureId &&
    candidate.tenantId === job.tenantId &&
    candidate.customerId === job.customerId &&
    candidate.connectionId === job.connectionId &&
    candidate.availableVersions.includes(job.version));
  if (fixture === undefined) invalid();
  return parseLocalFixtureResult(value, fixture, expectedJobId, job.version);
}
