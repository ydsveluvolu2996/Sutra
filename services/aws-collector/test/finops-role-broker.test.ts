import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AssumeRoleCommand,
  AssumeRoleCommandInput,
  AssumeRoleCommandOutput,
  GetCallerIdentityCommand,
  GetCallerIdentityCommandOutput,
} from "@aws-sdk/client-sts";

import {
  AwsRoleBroker,
  IMPLEMENTED_READ_ACTIONS,
  TRUST_ATTESTATION_ACTIONS,
  finopsDataExportSessionPolicy,
} from "../src/role-broker.js";
import {
  ConnectionIntegrityError,
  ConnectionStateError,
  UnsafeTrustPolicyError,
  type AssumeRoleClient,
  type CallerIdentityClient,
  type ConnectionScope,
  type FoundationalFinopsAddOnContract,
  type OnboardingTrustVerification,
  type RoleContractClient,
  type ScopedConnectionRegistry,
  type StoredAwsConnection,
} from "../src/types.js";

const SCOPE: ConnectionScope = { tenantId: "tenant-finops" };
const PRINCIPAL = "arn:aws:iam::999988887777:role/SutraLocalCollector";
const FINOPS_ACTIONS = [
  "s3:ListBucket",
  "s3:GetBucketLocation",
  "s3:GetObject",
  "s3:GetObjectAttributes",
  "bcm-data-exports:ListExports",
  "bcm-data-exports:GetExport",
] as const;

function contract(
  kind: "cur2" | "focus" = "cur2",
  overrides: Partial<FoundationalFinopsAddOnContract> = {},
): FoundationalFinopsAddOnContract {
  const exportName = kind === "cur2"
    ? "sutra_foundational_cur2_v1"
    : "sutra_foundational_focus12_v1";
  return {
    tenantId: "tenant-finops",
    connectionId: "conn-finops",
    contractId: kind === "cur2"
      ? "foundational-cur2-export-v1"
      : "foundational-focus12-export-v1",
    exportTable: kind === "cur2" ? "COST_AND_USAGE_REPORT" : "FOCUS_1_2_AWS",
    policyName: kind === "cur2"
      ? "SutraFoundationalCur2ReadV1"
      : "SutraFoundationalFocus12ReadV1",
    region: "us-east-1",
    bucket: kind === "cur2" ? "customer-cur2-export" : "customer-focus-export",
    prefix: `sutra/${kind}/${exportName}/`,
    exportName,
    exportArn:
      `arn:aws:bcm-data-exports:us-east-1:123456789012:export/${exportName}-1234`,
    ...overrides,
  };
}

function connection(
  overrides: Partial<StoredAwsConnection> = {},
): StoredAwsConnection {
  return {
    tenantId: "tenant-finops",
    connectionId: "conn-finops",
    expectedAccountId: "123456789012",
    roleArn: "arn:aws:iam::123456789012:role/sutra/SutraCollectorRole",
    externalId: "4a3e789b-5a2e-47db-9cab-226cbe52fc04",
    status: "ACTIVE",
    permissionPackVersion: "standard-2026-08.1",
    sessionNamePrefix: "mspcmdb-",
    roleProvisioningMode: "sutra_template",
    expectedRolePath: "/sutra/",
    expectedRoleName: "SutraCollectorRole",
    foundationalFinopsContracts: [contract()],
    ...overrides,
  };
}

class Registry implements ScopedConnectionRegistry {
  public constructor(public stored: StoredAwsConnection | null) {}
  public async resolve(): Promise<StoredAwsConnection | null> {
    return this.stored;
  }
  public async markOnboardingVerified(
    _scope: ConnectionScope,
    _connectionId: string,
    _verification: OnboardingTrustVerification,
  ): Promise<void> {
    void _scope;
    void _connectionId;
    void _verification;
  }
}

class Assume implements AssumeRoleClient {
  public readonly calls: AssumeRoleCommandInput[] = [];
  public async send(command: AssumeRoleCommand): Promise<AssumeRoleCommandOutput> {
    this.calls.push({ ...command.input });
    return {
      $metadata: {},
      Credentials: {
        AccessKeyId: "ASIAFINOPS",
        SecretAccessKey: "secret",
        SessionToken: "token",
        Expiration: new Date("2099-01-01T00:00:00.000Z"),
      },
    };
  }
}

class Identity implements CallerIdentityClient {
  public constructor(private readonly assume: Assume) {}
  public async send(
    _command: GetCallerIdentityCommand,
  ): Promise<GetCallerIdentityCommandOutput> {
    void _command;
    const sessionName = this.assume.calls.at(-1)?.RoleSessionName;
    assert.ok(sessionName);
    return {
      $metadata: {},
      Account: "123456789012",
      Arn:
        `arn:aws:sts::123456789012:assumed-role/SutraCollectorRole/${sessionName}`,
      UserId: `AROAFINOPS:${sessionName}`,
    };
  }
}

interface RoleOptions {
  readonly policyNames?: readonly string[];
  readonly mutatePolicy?: (
    policyName: string,
    document: Record<string, unknown>,
  ) => Record<string, unknown>;
}

function roleClient(
  stored: StoredAwsConnection,
  options: RoleOptions = {},
): RoleContractClient {
  const contracts = stored.foundationalFinopsContracts ?? [];
  const policies = new Map<string, Record<string, unknown>>([
    ["SutraImplementedMetadataCollectors", basePolicy(stored.roleArn)],
    ...contracts.map((item) =>
      [item.policyName, addOnPolicy(item)] as const
    ),
  ]);
  return {
    getRole: async () => ({
      arn: stored.roleArn,
      roleName: "SutraCollectorRole",
      path: "/sutra/",
      maxSessionDuration: 3_600,
      assumeRolePolicyDocument: encodeURIComponent(JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Sid: "ExactCollectorWithConnectionExternalId",
          Effect: "Allow",
          Principal: { AWS: PRINCIPAL },
          Action: "sts:AssumeRole",
          Condition: {
            StringEquals: { "sts:ExternalId": stored.externalId },
            StringLike: {
              "sts:RoleSessionName": `${stored.sessionNamePrefix ?? "mspcmdb-"}*`,
            },
          },
        }],
      })),
      tags: [
        { key: "sutra:access-mode", value: "read-only" },
        { key: "sutra:permission-pack", value: "standard-2026-08.1" },
        { key: "sutra:managed-by", value: "cloudformation" },
      ],
    }),
    listRolePolicies: async () => ({
      policyNames: options.policyNames ?? [...policies.keys()],
      isTruncated: false,
    }),
    listAttachedRolePolicies: async () => ({ policies: [], isTruncated: false }),
    getRolePolicy: async (_roleName, policyName) => {
      const found = policies.get(policyName);
      if (found === undefined) return {};
      const document = options.mutatePolicy?.(policyName, structuredClone(found)) ?? found;
      return { policyDocument: encodeURIComponent(JSON.stringify(document)) };
    },
  };
}

function basePolicy(roleArn: string): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "DenyUnimplementedActions",
        Effect: "Deny",
        NotAction: [
          ...IMPLEMENTED_READ_ACTIONS,
          ...TRUST_ATTESTATION_ACTIONS,
          ...FINOPS_ACTIONS,
        ],
        Resource: "*",
      },
      {
        Sid: "ImplementedMetadataApis",
        Effect: "Allow",
        Action: IMPLEMENTED_READ_ACTIONS,
        Resource: "*",
      },
      {
        Sid: "TrustContractAttestation",
        Effect: "Allow",
        Action: TRUST_ATTESTATION_ACTIONS,
        Resource: roleArn,
      },
    ],
  };
}

function addOnPolicy(item: FoundationalFinopsAddOnContract): Record<string, unknown> {
  const isCur = item.contractId === "foundational-cur2-export-v1";
  const prefixRoot = item.prefix.slice(0, -1);
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: isCur
          ? "ListOnlyExactFoundationalExportPrefix"
          : "ListOnlyExactFocus12ExportPrefix",
        Effect: "Allow",
        Action: "s3:ListBucket",
        Resource: `arn:aws:s3:::${item.bucket}`,
        Condition: {
          StringLike: {
            "s3:prefix": [prefixRoot, `${prefixRoot}/*`],
          },
        },
      },
      {
        Sid: isCur
          ? "ReadDedicatedBucketLocation"
          : "ReadDedicatedFocus12BucketLocation",
        Effect: "Allow",
        Action: "s3:GetBucketLocation",
        Resource: `arn:aws:s3:::${item.bucket}`,
      },
      {
        Sid: isCur
          ? "ReadOnlyExactFoundationalExportObjects"
          : "ReadOnlyExactFocus12ExportObjects",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:GetObjectAttributes"],
        Resource: `arn:aws:s3:::${item.bucket}/${item.prefix}*`,
      },
      ...(isCur
        ? [{
            Sid: "ListDataExports",
            Effect: "Allow",
            Action: "bcm-data-exports:ListExports",
            Resource: "*",
          }]
        : []),
      {
        Sid: isCur
          ? "ReadOnlyThisDataExport"
          : "ReadOnlyThisFocus12ExportStatus",
        Effect: "Allow",
        Action: "bcm-data-exports:GetExport",
        Resource: item.exportArn,
      },
    ],
  };
}

function binding(item: FoundationalFinopsAddOnContract) {
  return {
    contractId: item.contractId,
    exportName: item.exportName,
    region: item.region,
    bucket: item.bucket,
    prefix: item.prefix,
  };
}

function broker(
  stored: StoredAwsConnection,
  options: RoleOptions = {},
): { readonly broker: AwsRoleBroker; readonly assume: Assume } {
  const assume = new Assume();
  return {
    assume,
    broker: new AwsRoleBroker({
      registry: new Registry(stored),
      assumeRoleClient: assume,
      callerIdentityClientFactory: () => new Identity(assume),
      roleContractClientFactory: () => roleClient(stored, options),
      expectedPrincipalArn: PRINCIPAL,
      now: () => new Date("2026-07-31T00:00:00.000Z"),
    }),
  };
}

test(".4 and .8.1 without an attested add-on reject before STS", async () => {
  const {
    foundationalFinopsContracts: _omittedContracts,
    ...withoutAddOn
  } = connection();
  void _omittedContracts;
  for (const stored of [
    connection({ permissionPackVersion: "standard-2026-07.4" }),
    withoutAddOn,
  ]) {
    const setup = broker(stored);
    await assert.rejects(
      setup.broker.assumeValidatedFinopsSession(
        SCOPE,
        stored.connectionId,
        "job-finops",
        binding(contract()),
      ),
      ConnectionStateError,
    );
    assert.equal(setup.assume.calls.length, 0);
  }
});

test("wrong contract, export, region, bucket, or prefix rejects before STS", async () => {
  const stored = connection();
  const exact = binding(contract());
  const variants = [
    { ...exact, contractId: "foundational-focus12-export-v1" as const },
    { ...exact, exportName: "other_export" },
    { ...exact, region: "us-west-2" },
    { ...exact, bucket: "other-export-bucket" },
    { ...exact, prefix: `other/${exact.exportName}/` },
  ];
  for (const request of variants) {
    const setup = broker(stored);
    await assert.rejects(
      setup.broker.assumeValidatedFinopsSession(
        SCOPE,
        stored.connectionId,
        "job-finops",
        request,
      ),
      ConnectionIntegrityError,
    );
    assert.equal(setup.assume.calls.length, 0);
  }
});

test("a cross-tenant stored binding rejects before STS", async () => {
  const stored = connection({
    foundationalFinopsContracts: [contract("cur2", { tenantId: "tenant-other" })],
  });
  const setup = broker(stored);
  await assert.rejects(
    setup.broker.assumeValidatedFinopsSession(
      SCOPE,
      stored.connectionId,
      "job-finops",
      binding(contract()),
    ),
    ConnectionIntegrityError,
  );
  assert.equal(setup.assume.calls.length, 0);
});

test("a same-account ARN for a different export rejects before STS", async () => {
  const stored = connection({
    foundationalFinopsContracts: [contract("cur2", {
      exportArn:
        "arn:aws:bcm-data-exports:us-east-1:123456789012:" +
        "export/different_export-1234",
    })],
  });
  const setup = broker(stored);
  await assert.rejects(
    setup.broker.assumeValidatedFinopsSession(
      SCOPE,
      stored.connectionId,
      "job-finops",
      binding(contract()),
    ),
    ConnectionIntegrityError,
  );
  assert.equal(setup.assume.calls.length, 0);
});

test("missing, additional, and widened add-on policies fail attestation", async () => {
  const stored = connection();
  const expectedNames = [
    "SutraImplementedMetadataCollectors",
    "SutraFoundationalCur2ReadV1",
  ];
  const cases: RoleOptions[] = [
    { policyNames: ["SutraImplementedMetadataCollectors"] },
    { policyNames: [...expectedNames, "UnexpectedReadPolicy"] },
    {
      mutatePolicy: (name, document) => {
        if (name !== "SutraFoundationalCur2ReadV1") return document;
        const statements = document.Statement as Array<Record<string, unknown>>;
        const objects = statements.find((item) =>
          item.Sid === "ReadOnlyExactFoundationalExportObjects"
        );
        assert.ok(objects);
        objects.Resource = "arn:aws:s3:::customer-cur2-export/*";
        return document;
      },
    },
  ];
  for (const options of cases) {
    const setup = broker(stored, options);
    await assert.rejects(
      setup.broker.assumeValidatedFinopsSession(
        SCOPE,
        stored.connectionId,
        "job-finops",
        binding(contract()),
      ),
      UnsafeTrustPolicyError,
    );
    assert.equal(setup.assume.calls.length, 1);
  }
});

test("exact CUR2 composition succeeds with a prefix-only STS object ceiling", async () => {
  const stored = connection();
  const item = contract();
  const setup = broker(stored);
  await setup.broker.assumeValidatedFinopsSession(
    SCOPE,
    stored.connectionId,
    "job-finops",
    binding(item),
  );
  assert.equal(
    setup.assume.calls[0]?.Policy,
    finopsDataExportSessionPolicy(stored.roleArn, item),
  );
  const policy = JSON.parse(setup.assume.calls[0]?.Policy ?? "{}") as {
    Statement: Array<{ Action: string | string[]; Resource: string }>;
  };
  const serialized = JSON.stringify(policy);
  assert.equal(
    serialized.includes(
      "arn:aws:s3:::customer-cur2-export/sutra/cur2/" +
      "sutra_foundational_cur2_v1/*",
    ),
    true,
  );
  assert.equal(serialized.includes("s3:ListBucket"), false);
  assert.equal(serialized.includes("bcm-data-exports"), false);
});

test("exact FOCUS composition succeeds independently", async () => {
  const focus = contract("focus");
  const stored = connection({ foundationalFinopsContracts: [focus] });
  const setup = broker(stored);
  const session = await setup.broker.assumeValidatedFinopsSession(
    SCOPE,
    stored.connectionId,
    "job-focus",
    binding(focus),
  );
  assert.equal(session.connectionId, stored.connectionId);
  assert.equal(setup.assume.calls.length, 1);
});
