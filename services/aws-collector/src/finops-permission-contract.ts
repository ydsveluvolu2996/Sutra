import {
  type AwsPartition,
  type FoundationalFinopsAddOnContract,
  type FoundationalFinopsBindingRequest,
  type FoundationalFinopsContractId,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const EXPORT_NAME = /^[0-9A-Za-z_-]{1,128}$/u;
const EXPORT_PREFIX =
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}(?:\/[A-Za-z0-9][A-Za-z0-9_-]{0,62}){1,4}\/$/u;
const BUCKET =
  /^(?!\d+\.\d+\.\d+\.\d+$)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;

interface ContractShape {
  readonly exportTable: FoundationalFinopsAddOnContract["exportTable"];
  readonly policyName: FoundationalFinopsAddOnContract["policyName"];
}

const CONTRACT_SHAPES: Readonly<Record<FoundationalFinopsContractId, ContractShape>> = {
  "foundational-cur2-export-v1": {
    exportTable: "COST_AND_USAGE_REPORT",
    policyName: "SutraFoundationalCur2ReadV1",
  },
  "foundational-focus12-export-v1": {
    exportTable: "FOCUS_1_2_AWS",
    policyName: "SutraFoundationalFocus12ReadV1",
  },
};

const CONTRACT_KEYS = [
  "tenantId",
  "connectionId",
  "contractId",
  "exportTable",
  "policyName",
  "region",
  "bucket",
  "prefix",
  "exportName",
  "exportArn",
] as const;

export class FoundationalFinopsContractError extends Error {
  public constructor() {
    super("Foundational FinOps permission contract is invalid");
    this.name = "FoundationalFinopsContractError";
  }
}

export interface FoundationalFinopsContractOwner {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly expectedAccountId: string;
  readonly partition: AwsPartition;
}

export function parseFoundationalFinopsContracts(
  value: unknown,
  owner: FoundationalFinopsContractOwner,
): readonly FoundationalFinopsAddOnContract[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) fail();
  const contracts = value.map((candidate) => parseContract(candidate, owner));
  if (
    new Set(contracts.map(({ contractId }) => contractId)).size !== contracts.length ||
    new Set(contracts.map(({ policyName }) => policyName)).size !== contracts.length
  ) {
    fail();
  }
  return contracts.sort((left, right) => left.contractId.localeCompare(right.contractId));
}

export function resolveFoundationalFinopsContract(
  value: unknown,
  owner: FoundationalFinopsContractOwner,
  request: FoundationalFinopsBindingRequest,
): FoundationalFinopsAddOnContract {
  if (!validBindingRequest(request)) fail();
  const contracts = parseFoundationalFinopsContracts(value, owner);
  const match = contracts.find((contract) =>
    contract.contractId === request.contractId &&
    contract.exportName === request.exportName &&
    contract.region === request.region &&
    contract.bucket === request.bucket &&
    contract.prefix === request.prefix
  );
  if (match === undefined) fail();
  return match;
}

export function foundationalFinopsObjectArn(
  contract: FoundationalFinopsAddOnContract,
  partition: AwsPartition,
): string {
  return `arn:${partition}:s3:::${contract.bucket}/${contract.prefix}*`;
}

function parseContract(
  value: unknown,
  owner: FoundationalFinopsContractOwner,
): FoundationalFinopsAddOnContract {
  const record = exactRecord(value, CONTRACT_KEYS);
  const contractId = record.contractId;
  if (
    typeof contractId !== "string" ||
    !Object.hasOwn(CONTRACT_SHAPES, contractId)
  ) {
    fail();
  }
  const shape = CONTRACT_SHAPES[contractId as FoundationalFinopsContractId];
  if (
    record.tenantId !== owner.tenantId ||
    record.connectionId !== owner.connectionId ||
    typeof record.tenantId !== "string" ||
    typeof record.connectionId !== "string" ||
    !IDENTIFIER.test(record.tenantId) ||
    !IDENTIFIER.test(record.connectionId) ||
    record.exportTable !== shape.exportTable ||
    record.policyName !== shape.policyName ||
    typeof record.region !== "string" ||
    !REGION.test(record.region) ||
    !regionMatchesPartition(record.region, owner.partition) ||
    typeof record.bucket !== "string" ||
    !BUCKET.test(record.bucket) ||
    typeof record.exportName !== "string" ||
    !EXPORT_NAME.test(record.exportName) ||
    typeof record.prefix !== "string" ||
    !EXPORT_PREFIX.test(record.prefix) ||
    !record.prefix.endsWith(`/${record.exportName}/`) ||
    typeof record.exportArn !== "string" ||
    record.exportArn !== expectedExportArn(
      record.exportArn,
      owner,
      record.region,
      record.exportName,
    )
  ) {
    fail();
  }
  return {
    tenantId: record.tenantId,
    connectionId: record.connectionId,
    contractId: contractId as FoundationalFinopsContractId,
    exportTable: shape.exportTable,
    policyName: shape.policyName,
    region: record.region,
    bucket: record.bucket,
    prefix: record.prefix,
    exportName: record.exportName,
    exportArn: record.exportArn,
  };
}

function expectedExportArn(
  value: string,
  owner: FoundationalFinopsContractOwner,
  region: string,
  exportName: string,
): string {
  const prefix =
    `arn:${owner.partition}:bcm-data-exports:${region}:` +
    `${owner.expectedAccountId}:export/`;
  const resource = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  const expectedResourcePrefix = `${exportName}-`;
  const generatedIdentifier = resource.startsWith(expectedResourcePrefix)
    ? resource.slice(expectedResourcePrefix.length)
    : "";
  if (!/^[0-9A-Za-z-]{1,128}$/u.test(generatedIdentifier)) fail();
  return `${prefix}${resource}`;
}

function validBindingRequest(value: FoundationalFinopsBindingRequest): boolean {
  return Object.hasOwn(CONTRACT_SHAPES, value.contractId) &&
    EXPORT_NAME.test(value.exportName) &&
    REGION.test(value.region) &&
    BUCKET.test(value.bucket) &&
    EXPORT_PREFIX.test(value.prefix) &&
    value.prefix.endsWith(`/${value.exportName}/`);
}

function regionMatchesPartition(region: string, partition: AwsPartition): boolean {
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail();
  return value as Record<string, unknown>;
}

function fail(): never {
  throw new FoundationalFinopsContractError();
}
