import type {
  AgentlessScanRepository,
  AgentlessScope,
  StoredAgentlessRun,
} from "../db/agentless-scan-repository.ts";
import type { AgentlessScanPlan } from "./aws-agentless-scan-plan.ts";
import type {
  AgentlessScanExecution,
  AgentlessScanFinding,
  AgentlessVolumeResult,
} from "../services/aws-collector/src/scan-runner.ts";
import type { readAgentlessRun } from "./pilot-server.ts";

type BrokerRunState = Awaited<ReturnType<typeof readAgentlessRun>>;

const RESOURCE_ID = /^(?:snap|vol|i)-[0-9a-f]{8,32}$/u;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/u;
const MAX_FINDINGS = 5_000;

function invalid(): never {
  throw Object.assign(new Error("The collector agentless result is invalid"), {
    code: "BROKER_RESPONSE_INVALID",
    status: 502,
  });
}

function stringArray(value: unknown, maximum: number): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((entry) => typeof entry !== "string" || !RESOURCE_ID.test(entry))
  ) invalid();
  if (new Set(value).size !== value.length) invalid();
  return value;
}

function parseFinding(value: unknown): AgentlessScanFinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== 3 ||
    typeof item.source !== "string" ||
    item.source.length < 1 ||
    item.source.length > 64 ||
    (item.severity !== "critical" &&
      item.severity !== "high" &&
      item.severity !== "medium" &&
      item.severity !== "low" &&
      item.severity !== "unknown") ||
    typeof item.title !== "string" ||
    item.title.length < 1 ||
    item.title.length > 500
  ) invalid();
  return { source: item.source, severity: item.severity, title: item.title };
}

export function parseAgentlessBrokerExecution(
  value: unknown,
  plan: AgentlessScanPlan,
): AgentlessScanExecution {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    !Object.hasOwn(record, "summary") ||
    record.schema !== "sutra.aws-agentless-scan-execution.v1" ||
    !Array.isArray(record.results) ||
    record.results.length !== plan.volumes.length
  ) invalid();
  const approved = new Set(plan.volumes.map((volume) => volume.volumeId));
  const seen = new Set<string>();
  let findingCount = 0;
  const results: AgentlessVolumeResult[] = record.results.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) invalid();
    const result = entry as Record<string, unknown>;
    const resultKeys = Object.keys(result);
    if (
      resultKeys.some((key) => ![
        "volumeId", "status", "findings", "error", "toreDown",
        "teardownFailures", "cleanupHandoff", "teardownDebt",
      ].includes(key)) ||
      resultKeys.length < 7 || resultKeys.length > 8 ||
      typeof result.volumeId !== "string" ||
      !approved.has(result.volumeId) ||
      seen.has(result.volumeId) ||
      (result.status !== "scanned" && result.status !== "failed") ||
      !Array.isArray(result.findings) ||
      (result.error !== null &&
        (typeof result.error !== "string" || result.error.length > 500))
    ) invalid();
    seen.add(result.volumeId);
    findingCount += result.findings.length;
    if (findingCount > MAX_FINDINGS) invalid();
    const teardownDebt = result.teardownDebt;
    if (
      teardownDebt !== undefined &&
      (!Array.isArray(teardownDebt) || teardownDebt.length > 32)
    ) invalid();
    return {
      volumeId: result.volumeId,
      status: result.status,
      findings: result.findings.map(parseFinding),
      error: result.error as string | null,
      toreDown: stringArray(result.toreDown, 32),
      teardownFailures: stringArray(result.teardownFailures, 32),
      cleanupHandoff: stringArray(result.cleanupHandoff, 32),
      ...(teardownDebt === undefined ? {} : {
        teardownDebt: teardownDebt.map((item) => {
          if (item === null || typeof item !== "object" || Array.isArray(item)) invalid();
          const debt = item as Record<string, unknown>;
          if (
            Object.keys(debt).length !== 5 ||
            typeof debt.resourceId !== "string" ||
            !RESOURCE_ID.test(debt.resourceId) ||
            (debt.resourceKind !== "snapshot" &&
              debt.resourceKind !== "volume" &&
              debt.resourceKind !== "instance") ||
            (debt.accountScope !== "customer" &&
              debt.accountScope !== "sutra-scan-account") ||
            typeof debt.region !== "string" ||
            !REGION.test(debt.region) ||
            typeof debt.error !== "string" ||
            debt.error.length === 0 ||
            debt.error.length > 500
          ) invalid();
          return {
            resourceId: debt.resourceId,
            resourceKind: debt.resourceKind,
            accountScope: debt.accountScope,
            region: debt.region,
            error: debt.error.slice(0, 500),
          };
        }),
      }),
    };
  });
  return {
    schema: "sutra.aws-agentless-scan-execution.v1",
    results,
    summary: {
      scanned: results.filter((result) => result.status === "scanned").length,
      failed: results.filter((result) => result.status === "failed").length,
      findings: results.reduce((sum, result) => sum + result.findings.length, 0),
      resourcesToreDown: results.reduce((sum, result) => sum + result.toreDown.length, 0),
      teardownFailures: results.reduce(
        (sum, result) =>
          sum +
          (result.teardownDebt ?? [])
            .filter((debt) => debt.accountScope === "sutra-scan-account").length,
        0,
      ),
      cleanupHandoffs: results.reduce(
        (sum, result) =>
          sum +
          (result.teardownDebt ?? [])
            .filter((debt) => debt.accountScope === "customer").length,
        0,
      ),
    },
  };
}

function failedWithoutResult(plan: AgentlessScanPlan, message: string): AgentlessScanExecution {
  const results: AgentlessVolumeResult[] = plan.volumes.map((volume) => ({
    volumeId: volume.volumeId,
    status: "failed",
    findings: [],
    error: message,
    toreDown: [],
    teardownFailures: [],
    cleanupHandoff: [],
    teardownDebt: [],
  }));
  return {
    schema: "sutra.aws-agentless-scan-execution.v1",
    results,
    summary: {
      scanned: 0,
      failed: results.length,
      findings: 0,
      resourcesToreDown: 0,
      teardownFailures: 0,
      cleanupHandoffs: 0,
    },
  };
}

export async function reconcileAgentlessBrokerRun(input: {
  readonly repository: AgentlessScanRepository;
  readonly scope: AgentlessScope;
  readonly run: StoredAgentlessRun;
  readonly connectionId: string;
  readonly plan: AgentlessScanPlan;
  readonly broker: BrokerRunState;
}): Promise<"running" | "completed" | "failed"> {
  if (
    input.run.connectionId !== input.connectionId ||
    input.broker.connectionId !== input.connectionId ||
    input.broker.tenantId !== input.scope.orgId ||
    input.broker.runId !== input.run.id
  ) invalid();
  if (input.broker.phase === "running") return "running";
  const brokerError = input.broker.error === null
    ? null
    : `${input.broker.error.code}: ${input.broker.error.message}`.slice(0, 500);
  const execution = input.broker.execution === null
    ? failedWithoutResult(input.plan, brokerError ?? "The broker produced no scan result")
    : parseAgentlessBrokerExecution(input.broker.execution, input.plan);
  await input.repository.completeRun(
    input.scope,
    input.run.id,
    execution,
    {
      connectionId: input.connectionId,
      regionByVolumeId: Object.fromEntries(
        input.plan.volumes.map((volume) => [volume.volumeId, volume.region]),
      ),
      instanceByVolumeId: Object.fromEntries(
        execution.results.flatMap((result) => {
          const instance = (result.teardownDebt ?? [])
            .find((debt) => debt.resourceKind === "instance");
          return instance === undefined ? [] : [[result.volumeId, instance.resourceId]];
        }),
      ),
      error: input.broker.phase === "failed"
        ? brokerError ?? "The broker failed the agentless scan"
        : null,
    },
  );
  return input.broker.phase === "failed" ||
      (execution.summary.scanned === 0 && execution.summary.failed > 0)
    ? "failed"
    : "completed";
}
