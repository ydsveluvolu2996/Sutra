import assert from "node:assert/strict";
import test from "node:test";

import {
  AWS_ORGANIZATIONS_TAXONOMY_OPERATIONS,
  OrganizationsTaxonomyCollectionError,
  canonicalOrganizationsTaxonomyJson,
  collectSignedOrganizationsTaxonomy,
  type OrganizationsTaxonomyReader,
  type OrganizationsTaxonomySigner,
} from "../src/aws-organizations-taxonomy-runner.js";

const MANAGEMENT_ACCOUNT_ID = "111111111111";
const SIGNER_KEY_ID =
  "arn:aws:kms:ap-south-1:999999999999:key/11111111-2222-3333-4444-555555555555";
const NOW = new Date("2026-08-02T01:02:03.000Z");
const SCOPE = Object.freeze({
  organizationId: "org_sutra",
  customerId: "customer_acme",
  connectionId: "conn_11111111111111111111111111111111",
});
const CREDENTIALS = Object.freeze({
  accessKeyId: "ASIAEXAMPLE",
  secretAccessKey: "not-a-real-secret",
  sessionToken: "not-a-real-session",
  expiration: new Date("2026-08-02T02:02:03.000Z"),
});

function reader(
  pages: readonly {
    readonly token?: string;
    readonly accounts: readonly {
      readonly Id: string;
      readonly State: "ACTIVE" | "CLOSED" | "PENDING_ACTIVATION" | "PENDING_CLOSURE" | "SUSPENDED";
      readonly Name?: string;
      readonly Email?: string;
    }[];
  }[],
  managementAccountId = MANAGEMENT_ACCOUNT_ID,
): OrganizationsTaxonomyReader {
  let cursor = 0;
  return {
    describeOrganization: async () => ({
      Organization: { Id: "o-abcdefghij", MasterAccountId: managementAccountId },
    }),
    listAccounts: async (input) => {
      const page = pages[cursor];
      assert.ok(page);
      assert.equal(input.MaxResults, 20);
      assert.equal(input.NextToken, cursor === 0 ? undefined : pages[cursor - 1]?.token);
      cursor += 1;
      return { Accounts: [...page.accounts], ...(page.token === undefined ? {} : { NextToken: page.token }) };
    },
  };
}

function signer(
  capture?: { digest?: Uint8Array },
  keyId = SIGNER_KEY_ID,
): OrganizationsTaxonomySigner {
  return {
    signSha256Digest: async (digest) => {
      if (capture !== undefined) capture.digest = new Uint8Array(digest);
      return { keyId, signature: new Uint8Array(384).fill(7) };
    },
  };
}

function options(
  source: OrganizationsTaxonomyReader,
  signing: OrganizationsTaxonomySigner = signer(),
) {
  return {
    scope: SCOPE,
    managementAccountId: MANAGEMENT_ACCOUNT_ID,
    partition: "aws" as const,
    credentials: CREDENTIALS,
    signerKeyId: SIGNER_KEY_ID,
    reader: source,
    signer: signing,
    now: () => NOW,
  };
}

test("captures every page, sorts accounts and excludes provider labels", async () => {
  const result = await collectSignedOrganizationsTaxonomy(options(reader([
    {
      token: "page-two",
      accounts: [{
        Id: "222222222222",
        State: "SUSPENDED",
        Name: "must not cross boundary",
        Email: "must-not-cross@example.invalid",
      }],
    },
    { accounts: [{ Id: MANAGEMENT_ACCOUNT_ID, State: "ACTIVE" }] },
  ])));

  assert.equal(result.schemaVersion, "sutra.aws-organizations-taxonomy.signed.v1");
  assert.equal(result.pagesExhausted, true);
  assert.deepEqual(result.operations, AWS_ORGANIZATIONS_TAXONOMY_OPERATIONS);
  assert.deepEqual(result.accounts, [
    { accountId: MANAGEMENT_ACCOUNT_ID, state: "ACTIVE" },
    { accountId: "222222222222", state: "SUSPENDED" },
  ]);
  assert.equal(JSON.stringify(result).includes("must not cross"), false);
  assert.equal(JSON.stringify(result).includes("example.invalid"), false);
  assert.match(result.contentSha256, /^[a-f0-9]{64}$/u);
  assert.equal(result.signature.algorithm, "AWS_KMS_RSASSA_PSS_SHA_256");
  assert.equal(result.signature.signerKeyId, SIGNER_KEY_ID);
  assert.match(result.signature.value, /^[A-Za-z0-9_-]+$/u);
});

test("uses Account.State and preserves all official lifecycle states", async () => {
  const result = await collectSignedOrganizationsTaxonomy(options(reader([{
    accounts: [
      { Id: MANAGEMENT_ACCOUNT_ID, State: "ACTIVE" },
      { Id: "222222222222", State: "CLOSED" },
      { Id: "333333333333", State: "PENDING_ACTIVATION" },
      { Id: "444444444444", State: "PENDING_CLOSURE" },
      { Id: "555555555555", State: "SUSPENDED" },
    ],
  }])));
  assert.deepEqual(result.accounts.map((account) => account.state), [
    "ACTIVE", "CLOSED", "PENDING_ACTIVATION", "PENDING_CLOSURE", "SUSPENDED",
  ]);
});

test("signs exactly the SHA-256 digest of the canonical unsigned capture", async () => {
  const observed: { digest?: Uint8Array } = {};
  const result = await collectSignedOrganizationsTaxonomy(options(
    reader([{ accounts: [{ Id: MANAGEMENT_ACCOUNT_ID, State: "ACTIVE" }] }]),
    signer(observed),
  ));
  const unsigned = {
    schemaVersion: result.schemaVersion,
    scope: result.scope,
    partition: result.partition,
    managementAccountId: result.managementAccountId,
    awsOrganizationId: result.awsOrganizationId,
    collectedAtIso: result.collectedAtIso,
    pagesExhausted: result.pagesExhausted,
    operations: result.operations,
    accounts: result.accounts,
  };
  const expected = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalOrganizationsTaxonomyJson(unsigned)),
  ));
  assert.deepEqual(observed.digest, expected);
  assert.equal(result.contentSha256, Buffer.from(expected).toString("hex"));
});

test("rejects pagination token replay", async () => {
  await assert.rejects(
    collectSignedOrganizationsTaxonomy(options(reader([
      { token: "same-token", accounts: [{ Id: MANAGEMENT_ACCOUNT_ID, State: "ACTIVE" }] },
      { token: "same-token", accounts: [] },
    ]))),
    (error: unknown) => error instanceof OrganizationsTaxonomyCollectionError
      && error.code === "PAGINATION_REPLAYED",
  );
});

test("rejects duplicate accounts and malformed provider account states", async () => {
  for (const source of [
    reader([{
      accounts: [
        { Id: MANAGEMENT_ACCOUNT_ID, State: "ACTIVE" },
        { Id: MANAGEMENT_ACCOUNT_ID, State: "ACTIVE" },
      ],
    }]),
    {
      describeOrganization: async () => ({
        Organization: { Id: "o-abcdefghij", MasterAccountId: MANAGEMENT_ACCOUNT_ID },
      }),
      listAccounts: async () => ({
        Accounts: [{ Id: MANAGEMENT_ACCOUNT_ID, State: "UNKNOWN" as "ACTIVE" }],
      }),
    },
  ]) {
    await assert.rejects(
      collectSignedOrganizationsTaxonomy(options(source)),
      (error: unknown) => error instanceof OrganizationsTaxonomyCollectionError
        && error.code === "PROVIDER_RESPONSE_INVALID",
    );
  }
});

test("rejects a non-management anchor and a missing active management account", async () => {
  await assert.rejects(
    collectSignedOrganizationsTaxonomy(options(reader(
      [{ accounts: [{ Id: MANAGEMENT_ACCOUNT_ID, State: "ACTIVE" }] }],
      "999999999999",
    ))),
    (error: unknown) => error instanceof OrganizationsTaxonomyCollectionError
      && error.code === "PROVIDER_RESPONSE_INVALID",
  );
  await assert.rejects(
    collectSignedOrganizationsTaxonomy(options(reader([{
      accounts: [{ Id: MANAGEMENT_ACCOUNT_ID, State: "SUSPENDED" }],
    }]))),
    (error: unknown) => error instanceof OrganizationsTaxonomyCollectionError
      && error.code === "PROVIDER_RESPONSE_INVALID",
  );
});

test("enforces account, page, output and KMS identity limits", async () => {
  const cases = [
    {
      extra: { maximumAccounts: 1 },
      source: reader([{
        accounts: [
          { Id: MANAGEMENT_ACCOUNT_ID, State: "ACTIVE" },
          { Id: "222222222222", State: "ACTIVE" },
        ],
      }]),
      signing: signer(),
      code: "ACCOUNT_LIMIT_REACHED",
    },
    {
      extra: { maximumPages: 1 },
      source: reader([
        { token: "next", accounts: [{ Id: MANAGEMENT_ACCOUNT_ID, State: "ACTIVE" }] },
        { accounts: [] },
      ]),
      signing: signer(),
      code: "PAGE_LIMIT_REACHED",
    },
    {
      extra: { maximumOutputBytes: 1 },
      source: reader([{ accounts: [{ Id: MANAGEMENT_ACCOUNT_ID, State: "ACTIVE" }] }]),
      signing: signer(),
      code: "OUTPUT_SIZE_LIMIT_REACHED",
    },
    {
      extra: {},
      source: reader([{ accounts: [{ Id: MANAGEMENT_ACCOUNT_ID, State: "ACTIVE" }] }]),
      signing: signer(observedNone(), SIGNER_KEY_ID.replace("5555", "6666")),
      code: "SIGNING_FAILED",
    },
  ] as const;
  for (const item of cases) {
    await assert.rejects(
      collectSignedOrganizationsTaxonomy({
        ...options(item.source, item.signing),
        ...item.extra,
      }),
      (error: unknown) => error instanceof OrganizationsTaxonomyCollectionError
        && error.code === item.code,
    );
  }
});

test("rejects unsupported partitions before making provider calls", async () => {
  let called = false;
  const source: OrganizationsTaxonomyReader = {
    describeOrganization: async () => {
      called = true;
      return {};
    },
    listAccounts: async () => {
      called = true;
      return {};
    },
  };
  await assert.rejects(
    collectSignedOrganizationsTaxonomy({
      ...options(source),
      partition: "aws-us-gov",
    }),
    (error: unknown) => error instanceof OrganizationsTaxonomyCollectionError
      && error.code === "UNSUPPORTED_PARTITION",
  );
  assert.equal(called, false);
});

function observedNone(): { digest?: Uint8Array } {
  return {};
}
