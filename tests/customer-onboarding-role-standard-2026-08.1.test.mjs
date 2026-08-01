import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const successor = await readFile(
  new URL(
    "../infrastructure/customer-onboarding-role-standard-2026-08.1.yaml",
    import.meta.url,
  ),
  "utf8",
);
const current = await readFile(
  new URL("../infrastructure/customer-onboarding-role.yaml", import.meta.url),
  "utf8",
);
const publicDefault = await readFile(
  new URL("../public/sutra-customer-onboarding-role.yaml", import.meta.url),
  "utf8",
);
const addOn = await readFile(
  new URL(
    "../infrastructure/finops-foundational-cur2-export-v1.yaml",
    import.meta.url,
  ),
  "utf8",
);
const runbook = await readFile(
  new URL(
    "../docs/customer-onboarding-role-standard-2026-08.1.md",
    import.meta.url,
  ),
  "utf8",
);

const FOUNDATIONAL_READS = [
  "s3:ListBucket",
  "s3:GetBucketLocation",
  "s3:GetObject",
  "s3:GetObjectAttributes",
  "kms:Decrypt",
  "bcm-data-exports:ListExports",
  "bcm-data-exports:GetExport",
];
const FINOPS_SOURCE_READS = [
  "ce:GetAnomalies",
  "ce:GetAnomalyMonitors",
  "ce:GetAnomalySubscriptions",
];

function statementBlock(source, sid, nextSid) {
  const start = source.indexOf(`- Sid: ${sid}`);
  assert.notEqual(start, -1, `${sid} statement must exist`);
  const endCandidates = nextSid === null
    ? [
        source.indexOf("\n        - PolicyName:", start),
        source.indexOf("\n      Tags:", start),
        source.indexOf("\nOutputs:", start),
      ].filter((candidate) => candidate >= 0)
    : [source.indexOf(`- Sid: ${nextSid}`, start)];
  const end = endCandidates.length === 0 ? -1 : Math.min(...endCandidates);
  assert.notEqual(end, -1, `${sid} statement must be bounded`);
  return source.slice(start, end);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `${startMarker} section must exist`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${startMarker} section must be bounded`);
  return source.slice(start, end);
}

function listActions(block, key) {
  const keyStart = block.indexOf(`${key}:`);
  assert.notEqual(keyStart, -1, `${key} list must exist`);
  const list = block.slice(keyStart).match(
    /^(?:\s{18}|\s{16})Resource:/mu,
  );
  const end = list === null ? block.length : keyStart + list.index;
  return [...block.slice(keyStart, end).matchAll(
    /^\s+- ([a-z0-9-]+:[A-Za-z0-9*]+)\s*$/gmu,
  )].map((match) => match[1]);
}

const successorDeny = statementBlock(
  successor,
  "DenyUnimplementedActions",
  "ImplementedMetadataApis",
);
const currentDeny = statementBlock(
  current,
  "DenyUnimplementedActions",
  "ImplementedMetadataApis",
);
const successorMetadata = statementBlock(
  successor,
  "ImplementedMetadataApis",
  "TrustContractAttestation",
);
const currentMetadata = statementBlock(
  current,
  "ImplementedMetadataApis",
  "TrustContractAttestation",
);
const successorAttestation = statementBlock(
  successor,
  "TrustContractAttestation",
  null,
);
const currentAttestation = statementBlock(
  current,
  "TrustContractAttestation",
  null,
);
const successorFinopsSource = statementBlock(
  successor,
  "ExactFinopsSourceRead",
  null,
);

test("the successor is an explicit immutable source contract and leaves both defaults on 2026-07.4", () => {
  assert.match(
    successor,
    /Version: standard-2026-08\.1[\s\S]*FoundationalFinopsAddOn: foundational-cur2-export-v1/u,
  );
  assert.match(
    successor,
    /Key: sutra:permission-pack\s*\n\s*Value: standard-2026-08\.1/u,
  );
  assert.match(
    successor,
    /PermissionPackVersion:[\s\S]*Value: standard-2026-08\.1/u,
  );
  assert.match(current, /Value: standard-2026-07\.4/u);
  assert.match(publicDefault, /Value: standard-2026-07\.4/u);
  assert.doesNotMatch(current, /standard-2026-08\.1/u);
  assert.doesNotMatch(publicDefault, /standard-2026-08\.1/u);
  assert.match(runbook, /has not been\s+published or deployed/u);
  assert.match(runbook, /Do not overwrite a previously published/u);
});

test("the deny ceiling changes by exactly the reviewed Foundational and FinOps source reads", () => {
  const currentActions = listActions(currentDeny, "NotAction");
  const successorActions = listActions(successorDeny, "NotAction");
  const additions = successorActions.filter(
    (action) => !currentActions.includes(action),
  );
  const removals = currentActions.filter(
    (action) => !successorActions.includes(action),
  );

  const reviewedAdditions = [...FOUNDATIONAL_READS, ...FINOPS_SOURCE_READS];
  assert.deepEqual(additions, reviewedAdditions);
  assert.deepEqual(removals, []);
  assert.equal(
    successorActions.length,
    currentActions.length + reviewedAdditions.length,
  );
  assert.equal(new Set(successorActions).size, successorActions.length);
  assert.match(successorDeny, /Effect: Deny/u);
  assert.match(successorDeny, /Resource: '\*'/u);
});

test("the base role grants none of the seven newly ceiling-permitted Foundational reads", () => {
  for (const action of FOUNDATIONAL_READS) {
    const occurrences = [...successor.matchAll(
      new RegExp(`^\\s+- ${escapeRegExp(action)}\\s*$`, "gmu"),
    )];
    assert.equal(
      occurrences.length,
      1,
      `${action} must occur only once, in the deny ceiling`,
    );
    assert.doesNotMatch(successorMetadata, new RegExp(action, "u"));
    assert.doesNotMatch(successorAttestation, new RegExp(action, "u"));
  }
  assert.doesNotMatch(
    successor,
    /bcm-data-exports:(?:Create|Update|Delete)Export|s3:(?:Put|Delete)Object/u,
  );
});

test("the Cost Anomaly source policy grants exactly its three read actions", () => {
  assert.match(successor, /PolicyName: SutraFinopsCostAnomalyReadV1/u);
  assert.deepEqual(
    listActions(successorFinopsSource, "Action"),
    FINOPS_SOURCE_READS,
  );
  assert.match(successorFinopsSource, /Effect: Allow/u);
  assert.match(successorFinopsSource, /Resource: '\*'/u);
  assert.doesNotMatch(successorMetadata, /ce:GetAnomal/u);
  assert.doesNotMatch(successorAttestation, /ce:GetAnomal/u);
  for (const action of FINOPS_SOURCE_READS) {
    assert.equal(
      [...successor.matchAll(
        new RegExp(`^\\s+- ${escapeRegExp(action)}\\s*$`, "gmu"),
      )].length,
      2,
      `${action} must occur only in the deny ceiling and exact source policy`,
    );
  }
  assert.doesNotMatch(
    successorFinopsSource,
    /ce:(?:Create|Update|Delete)Anomaly|Action:\s*['"]?\*['"]?/u,
  );
});

test("the existing metadata and role-attestation Allows are byte-for-byte preserved", () => {
  assert.equal(
    section(successor, "Parameters:", "Conditions:"),
    section(current, "Parameters:", "Conditions:"),
  );
  assert.equal(
    section(
      successor,
      "      AssumeRolePolicyDocument:",
      "      Policies:",
    ),
    section(
      current,
      "      AssumeRolePolicyDocument:",
      "      Policies:",
    ),
  );
  assert.deepEqual(
    listActions(successorMetadata, "Action"),
    listActions(currentMetadata, "Action"),
  );
  assert.deepEqual(
    listActions(successorAttestation, "Action"),
    listActions(currentAttestation, "Action"),
  );
  assert.match(
    successorAttestation,
    /arn:\$\{AWS::Partition\}:iam::\$\{AWS::AccountId\}:role\/sutra\/\$\{RoleName\}/u,
  );
});

test("tenant-bound trust, session controls, role path and tags remain enforced", () => {
  assert.match(
    successor,
    /AllowedPattern: '\^arn:\(aws\|aws-us-gov\|aws-cn\):iam::\[0-9\]\{12\}:role\//u,
  );
  assert.match(
    successor,
    /Principal:[\s\S]*AWS:\s*\n\s*Ref: VendorCollectorRoleArn/u,
  );
  assert.match(
    successor,
    /sts:ExternalId:\s*\n\s*Ref: ExternalId/u,
  );
  assert.match(
    successor,
    /sts:RoleSessionName:[\s\S]*Fn::Sub: '\$\{SessionNamePrefix\}\*'/u,
  );
  assert.match(successor, /Path: \/sutra\//u);
  assert.match(successor, /MaxSessionDuration: 3600/u);
  assert.match(
    successor,
    /Key: sutra:tenant-id\s*\n\s*Value:\s*\n\s*Ref: CustomerTenantId/u,
  );
  assert.match(
    successor,
    /Key: sutra:access-mode\s*\n\s*Value: read-only/u,
  );
  assert.doesNotMatch(
    successor,
    /Principal:\s*['"]?\*['"]?|arn:[^'"\s]*:iam::[^'"\s]*:root/u,
  );
});

test("the add-on owns exact resource-scoped Allows for all seven reads", () => {
  const list = statementBlock(
    addOn,
    "ListOnlyExactFoundationalExportPrefix",
    "ReadDedicatedBucketLocation",
  );
  const location = statementBlock(
    addOn,
    "ReadDedicatedBucketLocation",
    "ReadOnlyExactFoundationalExportObjects",
  );
  const objects = statementBlock(
    addOn,
    "ReadOnlyExactFoundationalExportObjects",
    "DecryptOnlyExactFoundationalExportObjects",
  );
  const decrypt = statementBlock(
    addOn,
    "DecryptOnlyExactFoundationalExportObjects",
    "ListDataExports",
  );
  const listExports = statementBlock(
    addOn,
    "ListDataExports",
    "ReadOnlyThisDataExport",
  );
  const getExport = statementBlock(
    addOn,
    "ReadOnlyThisDataExport",
    null,
  );

  assert.match(list, /Action: s3:ListBucket/u);
  assert.match(
    list,
    /s3:prefix:[\s\S]*'\$\{ExportPrefix\}\/\$\{ExportName\}'[\s\S]*'\$\{ExportPrefix\}\/\$\{ExportName\}\/\*'/u,
  );
  assert.match(location, /Action: s3:GetBucketLocation/u);
  assert.match(
    location,
    /arn:\$\{AWS::Partition\}:s3:::\$\{DestinationBucket\}/u,
  );
  assert.deepEqual(
    listActions(objects, "Action"),
    ["s3:GetObject", "s3:GetObjectAttributes"],
  );
  assert.match(
    objects,
    /arn:\$\{AWS::Partition\}:s3:::\$\{DestinationBucket\}\/\$\{ExportPrefix\}\/\$\{ExportName\}\/\*/u,
  );
  assert.match(decrypt, /Action: kms:Decrypt/u);
  assert.match(
    decrypt,
    /BillingExportKey[\s\S]*ExistingBucketKmsKeyArn[\s\S]*kms:ViaService:[\s\S]*s3\.\$\{DestinationBucketRegion\}\.\$\{AWS::URLSuffix\}[\s\S]*kms:EncryptionContext:aws:s3:arn:[\s\S]*\$\{ExportPrefix\}\/\$\{ExportName\}\/\*/u,
  );
  assert.match(listExports, /Action: bcm-data-exports:ListExports/u);
  assert.match(listExports, /Resource: '\*'/u);
  assert.match(getExport, /Action: bcm-data-exports:GetExport/u);
  assert.match(
    getExport,
    /Fn::GetAtt:[\s\S]*- FoundationalCur2Export[\s\S]*- ExportArn/u,
  );
  assert.doesNotMatch(
    `${list}${location}${objects}${decrypt}${listExports}${getExport}`,
    /CreateExport|UpdateExport|DeleteExport|s3:PutObject|s3:DeleteObject|kms:(?:Encrypt|GenerateDataKey|ReEncrypt\w*|CreateGrant)(?:\s|$)|Action:\s*['"]?\*['"]?/u,
  );
  assert.doesNotMatch(
    objects,
    /s3:::\$\{DestinationBucket\}\/\*['"]?$/mu,
  );
});
