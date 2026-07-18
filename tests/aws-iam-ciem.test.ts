import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAwsIamCiem,
  principalAllows,
  type AwsIamCiemReport,
  type IamPrincipal,
  type IamStatement,
} from "../lib/aws-iam-ciem.ts";

function allow(actions: readonly string[], resources: readonly string[] = ["*"], conditionPresent?: boolean): IamStatement {
  return { effect: "Allow", actions, resources, ...(conditionPresent === undefined ? {} : { conditionPresent }) };
}
function deny(actions: readonly string[], resources: readonly string[] = ["*"]): IamStatement {
  return { effect: "Deny", actions, resources };
}
function principal(ref: string, statements: IamPrincipal["statements"], over: Partial<IamPrincipal> = {}): IamPrincipal {
  return { ref, kind: "role", statements, ...over };
}
function find(report: AwsIamCiemReport, ref: string) {
  return report.principals.find((result) => result.ref === ref);
}

test("Deny subtracts a matching Allow at action granularity", () => {
  const report = buildAwsIamCiem({
    principals: [principal("p", [allow(["s3:GetObject", "s3:PutObject"]), deny(["s3:PutObject"])])],
  });
  const p = find(report, "p");
  assert.equal(p?.resolution, "resolved");
  assert.deepEqual(p?.effectiveAllowed, ["s3:GetObject"]);
  assert.deepEqual(p?.deniedActions, ["s3:PutObject"]);
  assert.equal(principalAllows(p!, "s3:PutObject"), false);
  assert.equal(principalAllows(p!, "s3:GetObject"), true);
});

test("a Deny wildcard (s3:*) removes the covered concrete Allow", () => {
  const report = buildAwsIamCiem({
    principals: [principal("p", [allow(["s3:GetObject"]), deny(["s3:*"])])],
  });
  const p = find(report, "p");
  assert.deepEqual(p?.effectiveAllowed, []);
  assert.equal(p?.flags.dataAccess, false);
  assert.equal(p?.riskScore, 0);
});

test("a Deny of a concrete action does NOT strip a broader wildcard Allow", () => {
  const report = buildAwsIamCiem({
    principals: [principal("p", [allow(["s3:*"]), deny(["s3:DeleteObject"])])],
  });
  const p = find(report, "p");
  // The broad grant survives: partial denial of a wildcard is not expanded.
  assert.deepEqual(p?.effectiveAllowed, ["s3:*"]);
  assert.equal(p?.flags.wildcardAction, true);
  assert.equal(p?.flags.dataAccess, true);
});

test("'*' on '*' is adminLike and lights every derived flag", () => {
  const report = buildAwsIamCiem({ principals: [principal("root", [allow(["*"], ["*"])])] });
  const p = find(report, "root");
  assert.equal(p?.flags.adminLike, true);
  assert.equal(p?.flags.privilegeEscalation, true);
  assert.equal(p?.flags.dataAccess, true);
  assert.equal(p?.flags.wildcardAction, true);
  assert.equal(p?.riskScore, 220);
  assert.ok(p?.matchedEscalationActions.includes("iam:PassRole"));
  assert.ok(p?.matchedEscalationActions.includes("sts:AssumeRole"));
  assert.equal(report.totals.adminLike, 1);
});

test("'*' action on a scoped resource is not adminLike", () => {
  const report = buildAwsIamCiem({
    principals: [principal("scoped", [allow(["*"], ["arn:aws:s3:::bucket/*"])])],
  });
  const p = find(report, "scoped");
  assert.equal(p?.flags.adminLike, false);
  assert.equal(p?.flags.wildcardAction, true);
});

test("a privilege-escalation action (iam:PassRole) is detected", () => {
  const report = buildAwsIamCiem({
    principals: [principal("p", [allow(["iam:PassRole"], ["arn:aws:iam::1:role/app"])])],
  });
  const p = find(report, "p");
  assert.equal(p?.flags.privilegeEscalation, true);
  assert.deepEqual(p?.matchedEscalationActions, ["iam:PassRole"]);
  assert.equal(p?.flags.adminLike, false);
  assert.equal(p?.riskScore, 60);
  assert.equal(report.totals.privilegeEscalation, 1);
});

test("privilege escalation is found through a service wildcard (iam:*)", () => {
  const report = buildAwsIamCiem({ principals: [principal("p", [allow(["iam:*"])])] });
  const p = find(report, "p");
  assert.equal(p?.flags.privilegeEscalation, true);
  assert.ok(p?.matchedEscalationActions.includes("iam:CreatePolicyVersion"));
  assert.ok(p?.matchedEscalationActions.includes("iam:PassRole"));
});

test("sts:AssumeRole counts as escalation only against a broad resource", () => {
  const broad = buildAwsIamCiem({ principals: [principal("b", [allow(["sts:AssumeRole"], ["*"])])] });
  assert.equal(find(broad, "b")?.flags.privilegeEscalation, true);
  assert.ok(find(broad, "b")?.matchedEscalationActions.includes("sts:AssumeRole"));

  const scoped = buildAwsIamCiem({
    principals: [principal("s", [allow(["sts:AssumeRole"], ["arn:aws:iam::1:role/specific"])])],
  });
  const s = find(scoped, "s");
  assert.equal(s?.flags.privilegeEscalation, false);
  assert.deepEqual(s?.matchedEscalationActions, []);
  assert.deepEqual(s?.effectiveAllowed, ["sts:AssumeRole"]);
});

test("lambda:CreateFunction is escalation only when combined with iam:PassRole", () => {
  const alone = buildAwsIamCiem({
    principals: [principal("l", [allow(["lambda:CreateFunction"], ["*"])])],
  });
  assert.equal(find(alone, "l")?.flags.privilegeEscalation, false);

  const combo = buildAwsIamCiem({
    principals: [principal("l", [allow(["lambda:CreateFunction", "iam:PassRole"], ["*"])])],
  });
  const c = find(combo, "l");
  assert.equal(c?.flags.privilegeEscalation, true);
  assert.ok(c?.matchedEscalationActions.includes("lambda:CreateFunction+iam:PassRole"));
});

test("data-access actions across s3, secrets, dynamodb and rds are detected", () => {
  const report = buildAwsIamCiem({
    principals: [principal("p", [allow(["s3:GetObject", "secretsmanager:GetSecretValue", "dynamodb:Query", "rds-db:connect"])])],
  });
  const p = find(report, "p");
  assert.equal(p?.flags.dataAccess, true);
  assert.deepEqual(p?.matchedDataActions, ["dynamodb:Query", "rds-db:connect", "s3:GetObject", "secretsmanager:GetSecretValue"]);
  assert.equal(p?.flags.privilegeEscalation, false);
  assert.equal(p?.riskScore, 35);
});

test("a principal with no statements is unresolved, never an empty allow set", () => {
  const report = buildAwsIamCiem({
    principals: [principal("empty", []), principal("missing", null)],
  });
  for (const ref of ["empty", "missing"]) {
    const p = find(report, ref);
    assert.equal(p?.resolution, "unresolved");
    assert.equal(p?.effectiveAllowed, null);
    assert.equal(p?.deniedActions, null);
    assert.equal(p?.flags.adminLike, null);
    assert.equal(p?.flags.privilegeEscalation, null);
    assert.equal(p?.flags.dataAccess, null);
    assert.equal(p?.flags.wildcardAction, null);
    assert.equal(p?.riskScore, null);
    assert.equal(p?.rightSize.status, "unknown");
    assert.equal(p?.unresolvedReason, "policy statements not collected");
    // Honesty: an unresolved principal is not asserted allowed or denied anything.
    assert.equal(principalAllows(p!, "s3:GetObject"), null);
  }
  assert.equal(report.totals.unresolved, 2);
  assert.equal(report.totals.resolved, 0);
  assert.equal(report.totals.adminLike, 0);
});

test("collected-but-all-Deny is resolved with an empty allow set and false (not null) flags", () => {
  const report = buildAwsIamCiem({ principals: [principal("p", [deny(["s3:*"])])] });
  const p = find(report, "p");
  // Distinct from unresolved: we have evidence, and it grants nothing.
  assert.equal(p?.resolution, "resolved");
  assert.deepEqual(p?.effectiveAllowed, []);
  assert.deepEqual(p?.deniedActions, ["s3:*"]);
  assert.equal(p?.flags.adminLike, false);
  assert.equal(p?.flags.privilegeEscalation, false);
  assert.equal(p?.riskScore, 0);
});

test("empty input yields no principals and no false findings", () => {
  const report = buildAwsIamCiem({ principals: [] });
  assert.deepEqual(report.principals, []);
  assert.equal(report.totals.principals, 0);
  assert.equal(report.totals.adminLike, 0);
  assert.equal(report.totals.unresolved, 0);
  assert.equal(report.schema, "sutra.aws-iam-ciem.v1");
  assert.match(report.disclaimer, /never assumed to hold no permissions/u);
});

test("conditions are surfaced but never evaluated", () => {
  const withCond = buildAwsIamCiem({
    principals: [principal("c", [allow(["s3:GetObject"], ["*"], true)])],
  });
  const c = find(withCond, "c");
  assert.equal(c?.conditions, "conditions not evaluated");
  assert.equal(c?.conditionalStatementCount, 1);
  // conditionPresent false / absent => no unevaluated condition flagged.
  const without = buildAwsIamCiem({
    principals: [principal("n", [allow(["s3:GetObject"], ["*"], false)])],
  });
  assert.equal(find(without, "n")?.conditions, "none-present");
  assert.equal(find(without, "n")?.conditionalStatementCount, 0);
});

test("right-size flags allowed-but-unused services only past 90 days", () => {
  const report = buildAwsIamCiem({
    principals: [principal("stale", [allow(["s3:GetObject", "dynamodb:Query"])])],
    lastAccessed: { stale: { serviceLastUsedDays: 120 } },
  });
  const p = find(report, "stale");
  assert.equal(p?.rightSize.status, "unused-candidate");
  assert.equal(p?.rightSize.serviceLastUsedDays, 120);
  assert.deepEqual(p?.rightSize.unusedServices, ["dynamodb", "s3"]);
  assert.equal(report.totals.rightSizeCandidates, 1);
});

test("right-size is unknown without last-used evidence and never assumes unused", () => {
  const report = buildAwsIamCiem({
    principals: [principal("p", [allow(["s3:GetObject"])])],
  });
  const p = find(report, "p");
  assert.equal(p?.rightSize.status, "unknown");
  assert.equal(p?.rightSize.serviceLastUsedDays, null);
  assert.deepEqual(p?.rightSize.unusedServices, []);
  assert.match(p?.rightSize.note ?? "", /unknown/u);

  // Explicit null evidence is also unknown, not unused.
  const nulled = buildAwsIamCiem({
    principals: [principal("p", [allow(["s3:GetObject"])])],
    lastAccessed: { p: { serviceLastUsedDays: null } },
  });
  assert.equal(find(nulled, "p")?.rightSize.status, "unknown");
});

test("right-size boundary: exactly 90 days is recently-used, 91 is a candidate", () => {
  const at90 = buildAwsIamCiem({
    principals: [principal("p", [allow(["s3:GetObject"])])],
    lastAccessed: { p: { serviceLastUsedDays: 90 } },
  });
  assert.equal(find(at90, "p")?.rightSize.status, "recently-used");

  const at91 = buildAwsIamCiem({
    principals: [principal("p", [allow(["s3:GetObject"])])],
    lastAccessed: { p: { serviceLastUsedDays: 91 } },
  });
  assert.equal(find(at91, "p")?.rightSize.status, "unused-candidate");
});

test("tenant scope is carried through per principal", () => {
  const report = buildAwsIamCiem({
    principals: [
      principal("t1", [allow(["s3:GetObject"])], { tenant: "acme" }),
      principal("t2", [allow(["s3:GetObject"])]),
    ],
  });
  assert.equal(find(report, "t1")?.tenant, "acme");
  assert.equal(find(report, "t2")?.tenant, null);
});

test("principals are ranked by risk with unresolved sorted last, and output is deterministic", () => {
  const build = () => buildAwsIamCiem({
    principals: [
      principal("low", [allow(["s3:GetObject"], ["arn:aws:s3:::b/x"])]),
      principal("unresolved", null),
      principal("admin", [allow(["*"], ["*"])], { kind: "user" }),
    ],
  });
  const report = build();
  assert.equal(report.principals[0]?.ref, "admin");
  assert.equal(report.principals[report.principals.length - 1]?.ref, "unresolved");
  assert.deepEqual(build(), report);
});
