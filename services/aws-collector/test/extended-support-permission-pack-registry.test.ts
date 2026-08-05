import assert from "node:assert/strict";
import test from "node:test";

import { parsePersistedConnection } from "../src/local-registry.js";
import { EXTENDED_SUPPORT_PERMISSION_PACK_VERSION } from "../src/types.js";

test("encrypted and hosted registry parsing accepts the immutable .8.6 successor", () => {
  const parsed = parsePersistedConnection({
    tenantId: "org_extended",
    connectionId: `conn_${"a".repeat(32)}`,
    expectedAccountId: "111122223333",
    partition: "aws",
    roleArn: "arn:aws:iam::111122223333:role/sutra/SutraCollectorRole",
    externalId: "extended-support-external-id-0123456789",
    status: "ACTIVE",
    sessionNamePrefix: "sutra-",
    enabledRegions: ["us-east-1"],
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    permissionPackVersion: EXTENDED_SUPPORT_PERMISSION_PACK_VERSION,
    roleProvisioningMode: "sutra_template",
    expectedRolePath: "/sutra/",
    expectedRoleName: "SutraCollectorRole",
  });
  assert.equal(parsed.permissionPackVersion, EXTENDED_SUPPORT_PERMISSION_PACK_VERSION);
  assert.equal(parsed.status, "ACTIVE");
});
