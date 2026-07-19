import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CMDB_QUERY_MAX_LIMIT, runCmdbQuery, validateCmdbQuery, type CmdbQueryResource } from "../lib/cmdb-query.ts";

function resource(overrides: Partial<CmdbQueryResource>): CmdbQueryResource {
  return {
    resourceKey: "aws.ec2.instance/i-1",
    service: "ec2",
    resourceType: "aws.ec2.instance",
    regionKey: "us-east-1",
    name: "api-gateway",
    state: "running",
    arn: "arn:aws:ec2:us-east-1:1:instance/i-1",
    nativeId: "i-1",
    tags: { env: "prod" },
    configuration: { publicIp: "3.3.3.3", ports: [{ port: 443, open: true }], encrypted: false },
    ...overrides,
  };
}

const FLEET: readonly CmdbQueryResource[] = [
  resource({}),
  resource({ resourceKey: "aws.s3.bucket/b-1", service: "s3", resourceType: "aws.s3.bucket", nativeId: "b-1", name: "billing-exports", state: null, tags: { env: "prod", owner: "payments" }, configuration: { encrypted: true, versioning: "Enabled" } }),
  resource({ resourceKey: "aws.ec2.instance/i-2", nativeId: "i-2", name: "batch-runner", regionKey: "eu-west-1", tags: {}, configuration: { publicIp: null, ports: [], encrypted: true } }),
];

describe("validateCmdbQuery", () => {
  it("accepts a well-formed query and applies the default limit", () => {
    const { query, errors } = validateCmdbQuery({ predicates: [{ kind: "field", field: "service", op: "eq", value: "ec2" }] });
    assert.deepEqual(errors, []);
    assert.equal(query?.combine, "and");
    assert.equal(query?.limit, 100);
  });

  it("rejects unknown fields, bad ops, deep paths and empty predicate lists with explicit errors", () => {
    assert.match(String(validateCmdbQuery({ predicates: [] }).errors[0]), /non-empty/);
    assert.match(String(validateCmdbQuery({ predicates: [{ kind: "field", field: "password", op: "eq", value: "x" }] }).errors[0]), /queryable field/);
    assert.match(String(validateCmdbQuery({ predicates: [{ kind: "config", path: "a.b.c.d.e.f.g.h.i", op: "eq", value: 1 }] }).errors[0]), /maximum depth/);
    assert.match(String(validateCmdbQuery({ predicates: [{ kind: "tag", key: "env", op: "regex", value: ".*" }] }).errors[0]), /not valid/);
    assert.match(String(validateCmdbQuery({ combine: "xor", predicates: [{ kind: "field", field: "service", op: "eq", value: "s3" }] }).errors[0]), /combine/);
  });

  it("caps limit at the maximum instead of rejecting", () => {
    const { query } = validateCmdbQuery({ predicates: [{ kind: "field", field: "service", op: "eq", value: "s3" }], limit: 99999 });
    assert.equal(query?.limit, CMDB_QUERY_MAX_LIMIT);
  });
});

describe("runCmdbQuery", () => {
  it("matches scalar fields case-insensitively", () => {
    const { query } = validateCmdbQuery({ predicates: [{ kind: "field", field: "service", op: "eq", value: "EC2" }] });
    const result = runCmdbQuery(FLEET, query!);
    assert.deepEqual(result.matched.map((r) => r.nativeId), ["i-1", "i-2"]);
    assert.equal(result.evaluated, 3);
  });

  it("supports tag exists/missing and value predicates", () => {
    const owner = validateCmdbQuery({ predicates: [{ kind: "tag", key: "owner", op: "exists" }] }).query!;
    assert.deepEqual(runCmdbQuery(FLEET, owner).matched.map((r) => r.nativeId), ["b-1"]);
    const untagged = validateCmdbQuery({ predicates: [{ kind: "tag", key: "env", op: "missing" }] }).query!;
    assert.deepEqual(runCmdbQuery(FLEET, untagged).matched.map((r) => r.nativeId), ["i-2"]);
  });

  it("resolves config paths including array indexes, booleans and numeric comparisons", () => {
    const openPort = validateCmdbQuery({ predicates: [{ kind: "config", path: "ports.0.port", op: "gt", value: 400 }] }).query!;
    assert.deepEqual(runCmdbQuery(FLEET, openPort).matched.map((r) => r.nativeId), ["i-1"]);
    const unencrypted = validateCmdbQuery({ predicates: [{ kind: "config", path: "encrypted", op: "eq", value: false }] }).query!;
    assert.deepEqual(runCmdbQuery(FLEET, unencrypted).matched.map((r) => r.nativeId), ["i-1"]);
    const missing = validateCmdbQuery({ predicates: [{ kind: "config", path: "versioning", op: "missing" }] }).query!;
    assert.deepEqual(runCmdbQuery(FLEET, missing).matched.map((r) => r.nativeId), ["i-1", "i-2"]);
  });

  it("combines with or, and discloses truncation honestly", () => {
    const orQuery = validateCmdbQuery({ combine: "or", limit: 1, predicates: [
      { kind: "field", field: "service", op: "eq", value: "s3" },
      { kind: "field", field: "regionKey", op: "eq", value: "eu-west-1" },
    ] }).query!;
    const result = runCmdbQuery(FLEET, orQuery);
    assert.equal(result.totalMatched, 2);
    assert.equal((result.matched).length, 1);
    assert.equal(result.truncated, true);
  });

  it("never treats a null scalar as a silent match for positive ops", () => {
    const stateEq = validateCmdbQuery({ predicates: [{ kind: "field", field: "state", op: "eq", value: "running" }] }).query!;
    assert.deepEqual(runCmdbQuery(FLEET, stateEq).matched.map((r) => r.nativeId), ["i-1", "i-2"]);
  });
});
