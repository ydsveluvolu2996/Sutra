import assert from "node:assert/strict";
import test from "node:test";

import {
  HostedCredentialKmsConfigurationError,
  hostedCredentialKmsConfiguration,
} from "../src/hosted-credential-kms-client.js";

const ACCOUNT = "738663485493";
const REGION = "ap-south-1";
const KEY = `arn:aws:kms:${REGION}:${ACCOUNT}:key/2f5c9f2e-9a1f-4c2e-9a1f-1b2c3d4e5f60`;

test("an unset CMK leaves static-credential storage disabled rather than degraded", () => {
  // This is the important case. The broker must refuse static-credential
  // connections outright when it has no customer-credential CMK; the failure
  // mode to avoid is sealing customer key material under the shared
  // application registry key and looking healthy while doing it.
  assert.deepEqual(hostedCredentialKmsConfiguration(ACCOUNT, REGION, {}), {});
  assert.deepEqual(
    hostedCredentialKmsConfiguration(ACCOUNT, REGION, {
      SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN: "   ",
    }),
    {},
  );
});

test("a configured CMK yields both halves together", () => {
  const resolved = hostedCredentialKmsConfiguration(ACCOUNT, REGION, {
    SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN: KEY,
  });
  assert.equal(resolved.credentialKeyArn, KEY);
  assert.notEqual(resolved.credentialKms, undefined);
  // HostedPostgresState rejects a half-configured pair, so both must arrive or
  // neither. Nothing here may return one alone.
  assert.equal(
    (resolved.credentialKms === undefined) === (resolved.credentialKeyArn === undefined),
    true,
  );
});

test("a malformed ARN is refused rather than passed to KMS", () => {
  for (const value of [
    "not-an-arn",
    `arn:aws:kms:${REGION}:${ACCOUNT}:alias/sutra-credentials`,
    `arn:aws:kms:${REGION}:${ACCOUNT}:key/short`,
    `arn:aws:s3:::${ACCOUNT}`,
    // Whitespace inside the ARN is not trimmable and must not slip through.
    KEY.replace(":key/", ":key /"),
  ]) {
    assert.throws(
      () => hostedCredentialKmsConfiguration(ACCOUNT, REGION, {
        SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN: value,
      }),
      HostedCredentialKmsConfigurationError,
      value,
    );
  }
  // Surrounding whitespace is trimmed, not rejected: a value pasted into a
  // deployment secret commonly carries a trailing newline.
  assert.equal(
    hostedCredentialKmsConfiguration(ACCOUNT, REGION, {
      SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN: `\n${KEY} `,
    }).credentialKeyArn,
    KEY,
  );
});

test("the CMK must stay inside the broker workload account and region", () => {
  // A key in another account or region would look configured while placing
  // customer secrets outside the boundary the collector is trusted within.
  const otherAccount = `arn:aws:kms:${REGION}:111122223333:key/2f5c9f2e-9a1f-4c2e-9a1f-1b2c3d4e5f60`;
  const otherRegion = `arn:aws:kms:us-east-1:${ACCOUNT}:key/2f5c9f2e-9a1f-4c2e-9a1f-1b2c3d4e5f60`;
  for (const value of [otherAccount, otherRegion]) {
    assert.throws(
      () => hostedCredentialKmsConfiguration(ACCOUNT, REGION, {
        SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN: value,
      }),
      /workload account and region/u,
      value,
    );
  }
  // A region that merely starts with the broker's region must not pass either.
  assert.throws(
    () => hostedCredentialKmsConfiguration("7386634854931", REGION, {
      SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN: KEY,
    }),
    HostedCredentialKmsConfigurationError,
  );
});

test("the customer-credential CMK is never the taxonomy signing key", () => {
  // That key signs Sutra's own attestations. Sharing one key across both would
  // put two unrelated blast radiuses behind one grant and one rotation.
  assert.throws(
    () => hostedCredentialKmsConfiguration(ACCOUNT, REGION, {
      SUTRA_HOSTED_CREDENTIAL_KMS_KEY_ARN: KEY,
      SUTRA_TA_TAXONOMY_SIGNING_KEY_ARN: KEY,
    }),
    /must not be the taxonomy signing key/u,
  );
});

test("the KMS client is not constructed until a credential operation runs", async () => {
  const { HostedCredentialKmsClient } = await import(
    "../src/hosted-credential-kms-client.js"
  );
  const client = new HostedCredentialKmsClient(REGION);
  // A broker that never registers a static-credential connection must not open
  // a KMS client, resolve credentials, or hold a socket for one.
  assert.equal(
    Reflect.get(client as unknown as Record<string, unknown>, "client"),
    null,
  );
  client.destroy();
});
