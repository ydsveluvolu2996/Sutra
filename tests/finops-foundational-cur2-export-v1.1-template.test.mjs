import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const v1 = await readFile(
  new URL(
    "../infrastructure/finops-foundational-cur2-export-v1.yaml",
    import.meta.url,
  ),
  "utf8",
);
const revision = await readFile(
  new URL(
    "../infrastructure/finops-foundational-cur2-export-v1.1.yaml",
    import.meta.url,
  ),
  "utf8",
);
const runbook = await readFile(
  new URL(
    "../docs/finops-foundational-cur2-export.md",
    import.meta.url,
  ),
  "utf8",
);
const reviewedCeilings = {
  "standard-2026-08.1": await readFile(
    new URL(
      "../infrastructure/customer-onboarding-role-standard-2026-08.1.yaml",
      import.meta.url,
    ),
    "utf8",
  ),
  "standard-2026-08.12": await readFile(
    new URL(
      "../infrastructure/customer-onboarding-role-standard-2026-08.12.yaml",
      import.meta.url,
    ),
    "utf8",
  ),
};
const currentDefault = await readFile(
  new URL(
    "../infrastructure/customer-onboarding-role.yaml",
    import.meta.url,
  ),
  "utf8",
);
const publicDefault = await readFile(
  new URL(
    "../public/sutra-customer-onboarding-role.yaml",
    import.meta.url,
  ),
  "utf8",
);

// The revision may change nothing but the base-pack acceptance gate: every
// grant, resource, name, and binding stays byte-identical to the immutable v1
// contract, which the runtime pins as foundational-cur2-export-v1 throughout.
const ADD_ON_EXPORT_READS = [
  "s3:ListBucket",
  "s3:GetBucketLocation",
  "s3:GetObject",
  "s3:GetObjectAttributes",
  "kms:Decrypt",
  "bcm-data-exports:ListExports",
  "bcm-data-exports:GetExport",
];

function section(templateText, name) {
  const lines = templateText.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${name}:`));
  assert.ok(start >= 0, `${name} section must exist`);
  let end = start + 1;
  while (end < lines.length && !/^[A-Za-z]/u.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

function stripBlock(sectionText, key) {
  const lines = sectionText.split("\n");
  const start = lines.findIndex((line) => line === `  ${key}:`);
  assert.ok(start >= 0, `${key} block must exist to be stripped`);
  let end = start + 1;
  while (
    end < lines.length
    && (lines[end].trim() === "" || lines[end].search(/\S/u) > 2)
  ) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

function block(sectionText, key) {
  const lines = sectionText.split("\n");
  const start = lines.findIndex((line) => line === `  ${key}:`);
  assert.ok(start >= 0, `${key} block must exist`);
  let end = start + 1;
  while (
    end < lines.length
    && (lines[end].trim() === "" || lines[end].search(/\S/u) > 2)
  ) end += 1;
  return lines.slice(start, end).join("\n");
}

function splitDenyCeiling(templateText) {
  const lines = templateText.split("\n");
  const sid = lines.findIndex((line) =>
    /^\s*-\s*Sid:\s*DenyUnimplementedActions\s*$/u.test(line),
  );
  assert.ok(sid >= 0, "the base role must carry a DenyUnimplementedActions ceiling");
  const listStart = lines.findIndex(
    (line, index) => index > sid && /^\s*NotAction:\s*$/u.test(line),
  );
  assert.ok(listStart > sid, "the ceiling must be expressed as a NotAction allowlist");
  const indent = lines[listStart].search(/\S/u);
  let end = listStart + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() !== "" && line.search(/\S/u) <= indent) break;
    end += 1;
  }
  return {
    ceiling: lines.slice(listStart, end).join("\n"),
    rest: [...lines.slice(0, listStart), ...lines.slice(end)].join("\n"),
  };
}

test("the revision accepts exactly the two enumerated reviewed ceilings", () => {
  const pack = block(section(revision, "Parameters"), "BaseCollectorPermissionPackVersion");
  const allowed = [...pack.matchAll(/^\s+- (standard-[0-9.-]+)\s*$/gmu)]
    .map((match) => match[1]);
  assert.deepEqual(allowed, ["standard-2026-08.1", "standard-2026-08.12"]);
  assert.match(pack, /Default: standard-2026-08\.12/u);
  assert.doesNotMatch(revision, /standard-2026-07\.4/u);
  const rules = section(revision, "Rules");
  assert.match(
    block(rules, "RequireReviewedReadCeiling"),
    /Fn::Or:[\s\S]*Fn::Equals:[\s\S]*Ref: BaseCollectorPermissionPackVersion[\s\S]*- standard-2026-08\.1\n[\s\S]*Fn::Equals:[\s\S]*Ref: BaseCollectorPermissionPackVersion[\s\S]*- standard-2026-08\.12\n/u,
  );
  // Exact enumeration only — no lexical comparison or permissive matching.
  assert.doesNotMatch(pack, /AllowedPattern|standard-\*|standard-2026-08\.\[/u);
});

test("the revision changes nothing but the acceptance gate", () => {
  assert.equal(section(revision, "Resources"), section(v1, "Resources"));
  assert.equal(section(revision, "Conditions"), section(v1, "Conditions"));
  assert.equal(section(revision, "Metadata"), section(v1, "Metadata"));
  assert.equal(
    stripBlock(section(revision, "Parameters"), "BaseCollectorPermissionPackVersion"),
    stripBlock(section(v1, "Parameters"), "BaseCollectorPermissionPackVersion"),
  );
  assert.equal(
    stripBlock(section(revision, "Rules"), "RequireReviewedReadCeiling"),
    stripBlock(section(v1, "Rules"), "RejectCurrentReadCeiling"),
  );
  assert.equal(
    stripBlock(
      stripBlock(section(revision, "Outputs"), "RequiredBasePermissionPackVersion"),
      "TemplateRevision",
    ),
    stripBlock(section(v1, "Outputs"), "RequiredBasePermissionPackVersion"),
  );
});

test("the contract identity the runtime pins is unchanged", () => {
  assert.match(revision, /Contract: foundational-cur2-export-v1\./u);
  assert.match(
    section(revision, "Outputs"),
    /TemplateContractVersion:[\s\S]*?Value: foundational-cur2-export-v1\n/u,
  );
  assert.match(
    section(revision, "Outputs"),
    /TemplateRevision:[\s\S]*?Value: foundational-cur2-export-v1\.1\n/u,
  );
  assert.match(
    section(revision, "Outputs"),
    /RequiredBasePermissionPackVersion:[\s\S]*?Value:\n\s+Ref: BaseCollectorPermissionPackVersion/u,
  );
  assert.match(revision, /PolicyName: SutraFoundationalCur2ReadV1/u);
  assert.match(
    revision,
    /ExportName:[\s\S]*?Default: sutra_foundational_cur2_v1\n/u,
  );
});

test("both enumerated ceilings permit the seven reads without granting them", () => {
  for (const [version, role] of Object.entries(reviewedCeilings)) {
    assert.match(role, new RegExp(`Value: ${version.replace(".", "\\.")}`, "u"));
    const { ceiling, rest } = splitDenyCeiling(role);
    for (const action of ADD_ON_EXPORT_READS) {
      assert.match(
        ceiling,
        new RegExp(`^\\s*-\\s*${action}\\s*$`, "mu"),
        `${version} must ceiling-permit ${action}`,
      );
      assert.doesNotMatch(
        rest,
        new RegExp(action, "u"),
        `${version} must not grant ${action} itself`,
      );
    }
  }
  // The deployable defaults still pin the accepted default and declare the
  // unchanged v1 add-on contract.
  for (const deployable of [currentDefault, publicDefault]) {
    assert.match(deployable, /Value: standard-2026-08\.12/u);
    assert.match(deployable, /FoundationalFinopsAddOn: foundational-cur2-export-v1\n/u);
  }
});

test("the runbook records the successor revision and keeps launch gated", () => {
  assert.match(runbook, /finops-foundational-cur2-export-v1\.1\.yaml/u);
  assert.match(runbook, /successor revision/u);
  assert.match(runbook, /Publish-before-application release order/u);
});
