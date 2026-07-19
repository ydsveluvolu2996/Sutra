import assert from "node:assert/strict";
import test from "node:test";

import { buildAwsIamCiem } from "../lib/aws-iam-ciem.ts";
import { deriveAwsIamPrincipals } from "../lib/aws-iam-ciem-evidence.ts";
import type { JsonValue } from "../lib/pilot-types.ts";

interface Resource {
  readonly resourceKey: string;
  readonly service: string;
  readonly resourceType: string;
  readonly arn: string | null;
  readonly name: string | null;
  readonly configuration: Readonly<Record<string, JsonValue>>;
}

function resource(partial: Partial<Resource> & { resourceKey: string }): Resource {
  return {
    service: "iam",
    resourceType: "AWS::IAM::Role",
    arn: null,
    name: null,
    configuration: {},
    ...partial,
  };
}

test("extracts IAM roles and users with their policy statements", () => {
  const input = deriveAwsIamPrincipals([
    resource({
      resourceKey: "r1",
      arn: "arn:aws:iam::111:role/admin",
      configuration: {
        policyDocument: { Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }] },
      },
    }),
    resource({
      resourceKey: "r2",
      service: "iam",
      resourceType: "AWS::IAM::User",
      arn: "arn:aws:iam::111:user/ci",
      configuration: {
        statements: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: ["arn:aws:s3:::b/*"] }],
      },
    }),
    resource({ resourceKey: "r3", service: "ec2", resourceType: "AWS::EC2::Instance" }),
  ]);
  assert.equal(input.principals.length, 2);
  assert.equal(input.principals[0]?.kind, "role");
  assert.equal(input.principals[1]?.kind, "user");

  const report = buildAwsIamCiem(input);
  const admin = report.principals.find((p) => p.ref === "arn:aws:iam::111:role/admin");
  assert.equal(admin?.resolution, "resolved");
  assert.equal(admin?.flags.adminLike, true);
  const ci = report.principals.find((p) => p.ref === "arn:aws:iam::111:user/ci");
  assert.equal(ci?.flags.dataAccess, true);
});

test("a role with no collected policy is unresolved, never assumed empty", () => {
  const input = deriveAwsIamPrincipals([
    resource({ resourceKey: "r1", arn: "arn:aws:iam::111:role/mystery" }),
  ]);
  assert.equal(input.principals[0]?.statements, null);
  const report = buildAwsIamCiem(input);
  assert.equal(report.principals[0]?.resolution, "unresolved");
  assert.equal(report.principals[0]?.effectiveAllowed, null);
  assert.equal(report.principals[0]?.flags.adminLike, null);
});

test("Deny is subtracted and condition presence is carried through (not evaluated)", () => {
  const input = deriveAwsIamPrincipals([
    resource({
      resourceKey: "r1",
      arn: "arn:aws:iam::111:role/scoped",
      configuration: {
        policyDocument: {
          Statement: [
            { Effect: "Allow", Action: ["s3:GetObject", "s3:DeleteObject"], Resource: ["*"], Condition: { StringEquals: { "aws:username": "x" } } },
            { Effect: "Deny", Action: ["s3:DeleteObject"], Resource: ["*"] },
          ],
        },
      },
    }),
  ]);
  const stmts = input.principals[0]?.statements;
  assert.ok(stmts && stmts.length === 2);
  assert.equal(stmts[0]?.conditionPresent, true);
  const report = buildAwsIamCiem(input);
  const p = report.principals[0];
  assert.equal(p?.conditions, "conditions not evaluated");
  // the explicit s3:DeleteObject Allow is fully covered by the Deny, so it must
  // not survive; the sibling s3:GetObject grant does.
  assert.equal(p?.matchedDataActions.includes("s3:DeleteObject"), false);
  assert.equal(p?.matchedDataActions.includes("s3:GetObject"), true);
});

test("last-used evidence drives right-sizing; absence stays unknown", () => {
  const withUsage = deriveAwsIamPrincipals([
    resource({
      resourceKey: "r1",
      arn: "arn:aws:iam::111:role/stale",
      configuration: {
        serviceLastUsedDays: 200,
        policyDocument: { Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: ["*"] }] },
      },
    }),
  ]);
  assert.equal(withUsage.lastAccessed?.["arn:aws:iam::111:role/stale"]?.serviceLastUsedDays, 200);
  assert.equal(buildAwsIamCiem(withUsage).principals[0]?.rightSize.status, "unused-candidate");

  const noUsage = deriveAwsIamPrincipals([
    resource({
      resourceKey: "r1",
      arn: "arn:aws:iam::111:role/live",
      configuration: { policyDocument: { Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: ["*"] }] } },
    }),
  ]);
  assert.equal(buildAwsIamCiem(noUsage).principals[0]?.rightSize.status, "unknown");
});

test("no IAM resources yields no principals (honest empty, not an error)", () => {
  const input = deriveAwsIamPrincipals([resource({ resourceKey: "r1", service: "s3", resourceType: "AWS::S3::Bucket" })]);
  assert.equal(input.principals.length, 0);
  assert.equal(buildAwsIamCiem(input).totals.principals, 0);
});
