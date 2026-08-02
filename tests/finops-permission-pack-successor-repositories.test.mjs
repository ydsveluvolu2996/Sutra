import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));
const migrations = await import("../db/runtime-migrations.ts");
const { ExtendedSupportRuntimeRepository } = await import(
  "../db/finops-extended-support-runtime-repository.ts");
const {
  AwsSupportCasesRuntimeRepository,
  AwsSupportCasesRuntimeRepositoryError,
} = await import("../db/finops-aws-support-cases-runtime-repository.ts");
const { AwsHealthRuntimeRepository } = await import(
  "../db/finops-aws-health-runtime-repository.ts");
const { ResilienceVueRuntimeRepository } = await import(
  "../db/finops-resilience-vue-runtime-repository.ts");
const { DcfRuntimeRepository } = await import(
  "../db/finops-dcf-runtime-repository.ts");

const ORG = "org_pack_successors";
const CUSTOMER = "customer_pack_successors";
const PACKS = [
  "standard-2026-08.6",
  "standard-2026-08.7",
  "standard-2026-08.8",
  "standard-2026-08.9",
  "standard-2026-08.10",
  "standard-2026-08.11",
  "standard-2026-08.90",
];
const CONNECTIONS = PACKS.map((_, index) => `conn_${(index + 1).toString(16).repeat(32)}`);

test("runtime repositories accept only explicit .8.6-.8.11 successor chains", async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default{fetch(){return new Response('ok')}}",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `permission-pack-successors-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    migrations.resetRuntimeSchemaCacheForTests();
    await migrations.ensureRuntimeSchema(database);
    await database.batch([
      database.prepare(
        "INSERT INTO organizations(id,slug,name,status)VALUES(?,'pack-successors','Pack Successors','active')",
      ).bind(ORG),
      database.prepare(
        "INSERT INTO customers(id,org_id,slug,name,status)VALUES(?,?,'pack-successors','Pack Successors','active')",
      ).bind(CUSTOMER, ORG),
      ...PACKS.map((permissionPack, index) => database.prepare(`INSERT INTO aws_connections(
        id,org_id,customer_id,source_kind,partition,aws_account_id,role_arn,
        external_id_ciphertext,external_id_key_version,permission_pack_version,status,
        enabled_regions_json
      )VALUES(?,?,?,'aws_trust_role','aws',?,?,'ct','v1',?,'active','["us-east-1"]')`).bind(
        CONNECTIONS[index], ORG, CUSTOMER, String(111122223330 + index).padStart(12, "0"),
        `arn:aws:iam::${String(111122223330 + index).padStart(12, "0")}:role/sutra/SutraCollectorRole`,
        permissionPack,
      )),
      database.prepare("UPDATE aws_connections SET permission_pack_version='standard-2026-08.10' WHERE id IN (?,?,?)")
        .bind(CONNECTIONS[4],CONNECTIONS[5],CONNECTIONS[6]),
      ...[4,5,6].map((index) => database.prepare(`INSERT INTO finops_dcf_module_bindings(
        org_id,customer_id,connection_id,module_id,module_name,source_id,region,state_machine_arn,
        enabled,expected_cadence_minutes,verified_at)VALUES(?,?,?,'cur','CUR','aws_cur2_data_export',
        'us-east-1',?,1,60,?)`).bind(ORG,CUSTOMER,CONNECTIONS[index],
        `arn:aws:states:us-east-1:${String(111122223330 + index).padStart(12, "0")}:stateMachine:CID-CUR`,
        1785542400000)),
      database.prepare("UPDATE aws_connections SET permission_pack_version='standard-2026-08.11' WHERE id=?")
        .bind(CONNECTIONS[5]),
      database.prepare("UPDATE aws_connections SET permission_pack_version='standard-2026-08.90' WHERE id=?")
        .bind(CONNECTIONS[6]),
    ]);

    const ids = (values) => values.map((value) => value.connectionId).sort();
    assert.deepEqual(ids(await new ExtendedSupportRuntimeRepository(database)
      .listEligibleScopes()), CONNECTIONS.slice(0, 6));
    assert.deepEqual(ids(await new AwsHealthRuntimeRepository(database)
      .listEligibleScopes()), CONNECTIONS.slice(2, 6));
    assert.deepEqual(ids(await new ResilienceVueRuntimeRepository(database)
      .listEligibleScopes()), CONNECTIONS.slice(3, 6));
    assert.deepEqual(ids(await new DcfRuntimeRepository(database)
      .listEligibleScopes()), CONNECTIONS.slice(4, 6));

    const support = new AwsSupportCasesRuntimeRepository(database);
    for (const connectionId of CONNECTIONS.slice(1, 6)) {
      assert.equal((await support.loadScope({
        organizationId: ORG,
        customerId: CUSTOMER,
        connectionId,
      })).parentConnectionId, connectionId);
    }
    for (const connectionId of [CONNECTIONS[0], ...CONNECTIONS.slice(6)]) {
      await assert.rejects(
        support.loadScope({ organizationId: ORG, customerId: CUSTOMER, connectionId }),
        (error) => error instanceof AwsSupportCasesRuntimeRepositoryError
          && error.code === "SCOPE_NOT_FOUND",
      );
    }
  } finally {
    await miniflare.dispose();
  }
});
