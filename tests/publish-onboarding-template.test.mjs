import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  LIVE_AWS_TEMPLATE_PUBLISH_ACKNOWLEDGEMENT,
  attestBucketIsEmpty,
  isExactMissingBucketError,
  isExactMissingBucketTagSetError,
  publishOnboardingTemplate,
  validateTemplatePublishEnvironment,
} from "../scripts/publish-onboarding-template.mjs";

const root = resolve(import.meta.dirname, "..");
const ACCOUNT_ID = "111122223333";
const OPERATOR_PROFILE = "sutra-msp-operator";
const SSO_LOGIN_PROFILE = "sutra-identity-center";

function environment(overrides = {}) {
  return {
    SUTRA_LIVE_AWS_TEMPLATE_ACK: LIVE_AWS_TEMPLATE_PUBLISH_ACKNOWLEDGEMENT,
    AWS_PROFILE: OPERATOR_PROFILE,
    AWS_REGION: "us-east-1",
    ...overrides,
  };
}

function validatedProfileSource() {
  return {
    selectedProfile: OPERATOR_PROFILE,
    chain: [OPERATOR_PROFILE, SSO_LOGIN_PROFILE],
    terminal: "sso",
    configFile: "/safe/config",
    credentialsFile: "/safe/credentials",
  };
}

test("template publication requires explicit commercial-Region SSO configuration", () => {
  assert.deepEqual(validateTemplatePublishEnvironment(environment()), {
    profile: "sutra-msp-operator",
    region: "us-east-1",
    configuredBucket: undefined,
  });
  assert.throws(
    () => validateTemplatePublishEnvironment(environment({ SUTRA_LIVE_AWS_TEMPLATE_ACK: undefined })),
    /SUTRA_LIVE_AWS_TEMPLATE_ACK/u,
  );
  assert.throws(
    () => validateTemplatePublishEnvironment(environment({ AWS_SECRET_ACCESS_KEY: "must-not-leak" })),
    (error) => error instanceof Error && error.message.includes("AWS_SECRET_ACCESS_KEY") && !error.message.includes("must-not-leak"),
  );
  assert.throws(
    () => validateTemplatePublishEnvironment(environment({ AWS_REGION: "us-gov-west-1" })),
    /commercial AWS Regions only/u,
  );
  assert.throws(
    () => validateTemplatePublishEnvironment(environment({ SUTRA_TEMPLATE_BUCKET: "dotted.bucket" })),
    /valid lowercase S3 bucket name/u,
  );
  assert.throws(
    () => validateTemplatePublishEnvironment(environment({ AWS_ENDPOINT_URL_S3: "https://attacker.invalid" })),
    (error) => error instanceof Error && error.message.includes("AWS_ENDPOINT_URL_S3") && !error.message.includes("attacker.invalid"),
  );
});

test("publisher distinguishes exact AWS absence evidence and exact empty buckets", () => {
  assert.equal(isExactMissingBucketError(new Error(
    "aws exited 255: An error occurred (404) when calling the HeadBucket operation: Not Found",
  )), true);
  assert.equal(isExactMissingBucketError(new Error("AccessDenied")), false);
  assert.equal(isExactMissingBucketTagSetError(new Error(
    "aws exited 255: An error occurred (NoSuchTagSet) when calling the GetBucketTagging operation: The TagSet does not exist",
  )), true);
  assert.doesNotThrow(() => attestBucketIsEmpty(
    JSON.stringify({ KeyCount: 0, IsTruncated: false }),
    JSON.stringify({ IsTruncated: false }),
  ));
  assert.throws(() => attestBucketIsEmpty(
    JSON.stringify({ KeyCount: 1, Contents: [{ Key: "unknown" }] }),
    JSON.stringify({}),
  ), /unless it is empty/u);
});

test("publisher creates a private-list/public-object versioned bucket and verifies exact bytes", async () => {
  const calls = [];
  let headCalls = 0;
  const template = await readFile(resolve(root, "public/sutra-customer-role-live-demo.yaml"));
  const runCommand = async (command, args, options) => {
    calls.push({
      kind: "run",
      command,
      args,
      profile: options.environment.AWS_PROFILE,
      endpointKeys: Object.keys(options.environment).filter((key) => key.startsWith("AWS_ENDPOINT_URL")),
    });
  };
  const captureCommand = async (command, args, options) => {
    calls.push({
      kind: "capture",
      command,
      args,
      profile: options.environment.AWS_PROFILE,
      endpointKeys: Object.keys(options.environment).filter((key) => key.startsWith("AWS_ENDPOINT_URL")),
    });
    if (args[0] === "sts") {
      return JSON.stringify({
        Account: ACCOUNT_ID,
        Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_Admin_abc/session`,
      });
    }
    if (args[0] === "s3api" && args[1] === "head-bucket") {
      headCalls += 1;
      if (headCalls === 1) {
        throw new Error(
          "aws exited 255: An error occurred (404) when calling the HeadBucket operation: Not Found",
        );
      }
      return "";
    }
    if (args[0] === "s3api" && args[1] === "put-object") {
      return JSON.stringify({
        VersionId: "immutable-version-1",
        ChecksumSHA256: createHash("sha256").update(template).digest("base64"),
      });
    }
    return "";
  };
  const result = await publishOnboardingTemplate({
    environment: environment({ AWS_ENDPOINT_URL: "", AWS_ENDPOINT_URL_S3: "" }),
    root,
    runCommand,
    captureCommand,
    validateProfile: async () => validatedProfileSource(),
    fetchTemplate: async () => new Response(template, { status: 200 }),
  });

  assert.equal(result.accountId, ACCOUNT_ID);
  assert.match(result.url, /^https:\/\/sutra-onboarding-111122223333-us-east-1\.s3\.us-east-1\.amazonaws\.com\/templates\//u);
  assert.equal(new URL(result.url).searchParams.get("versionId"), "immutable-version-1");
  const login = calls.find((call) => call.args[0] === "sso" && call.args[1] === "login");
  assert.equal(login?.args[login.args.indexOf("--profile") + 1], SSO_LOGIN_PROFILE);
  assert.equal(login?.profile, SSO_LOGIN_PROFILE);
  assert.ok(calls.some((call) =>
    call.kind === "capture" && call.args[0] === "sts" && call.profile === OPERATOR_PROFILE
  ));
  assert.ok(calls.some((call) => call.args[0] === "s3api" && call.args[1] === "create-bucket"));
  assert.equal(headCalls, 2);
  assert.equal(calls.every((call) => call.endpointKeys.length === 0), true);
  const taggingCall = calls.find((call) => call.args[1] === "put-bucket-tagging");
  assert.ok(taggingCall);
  assert.deepEqual(JSON.parse(taggingCall.args[taggingCall.args.indexOf("--tagging") + 1]), {
    TagSet: [
      { Key: "sutra:managed-by", Value: "template-publisher-v1" },
      { Key: "sutra:purpose", Value: "customer-role-quick-create" },
    ],
  });
  assert.ok(calls.some((call) => call.args[1] === "put-bucket-versioning"));
  const publicAccess = calls.find((call) => call.args[1] === "put-public-access-block");
  assert.ok(publicAccess?.args.includes("BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false"));
  const policyCall = calls.find((call) => call.args[1] === "put-bucket-policy");
  const policy = JSON.parse(policyCall.args[policyCall.args.indexOf("--policy") + 1]);
  assert.deepEqual(policy.Statement[0].Action, ["s3:GetObject", "s3:GetObjectVersion"]);
  assert.equal(policy.Statement[0].Resource, `arn:aws:s3:::${result.bucket}/${result.objectKey}`);
  assert.equal(JSON.stringify(policy).includes("s3:ListBucket"), false);
  assert.ok(calls.some((call) => call.kind === "capture" && call.args[1] === "put-object"));
  for (const call of calls.filter((candidate) =>
    candidate.args[0] === "s3api" && candidate.args[1] !== "create-bucket"
  )) {
    assert.equal(
      call.args[call.args.indexOf("--expected-bucket-owner") + 1],
      ACCOUNT_ID,
      `${call.args[1]} must bind the expected bucket owner`,
    );
  }
});

test("publisher refuses an unmarked pre-existing bucket before any bucket mutation", async () => {
  const calls = [];
  const captureCommand = async (command, args) => {
    calls.push({ kind: "capture", command, args });
    if (args[0] === "sts") {
      return JSON.stringify({
        Account: ACCOUNT_ID,
        Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_Admin_abc/session`,
      });
    }
    if (args[1] === "head-bucket") return "";
    if (args[1] === "get-bucket-tagging") return JSON.stringify({ TagSet: [] });
    return "";
  };
  const runCommand = async (command, args) => {
    calls.push({ kind: "run", command, args });
  };

  await assert.rejects(
    publishOnboardingTemplate({
      environment: environment({ SUTRA_TEMPLATE_BUCKET: "existing-shared-bucket" }),
      root,
      runCommand,
      captureCommand,
      validateProfile: async () => validatedProfileSource(),
    }),
    /Refusing to modify an existing S3 bucket without the Sutra purpose marker/u,
  );
  assert.equal(
    calls.some((call) => call.kind === "run" && call.args[0] === "s3api"),
    false,
  );
});

test("publisher reuses only an owner-bound bucket with the exact Sutra purpose marker", async () => {
  const calls = [];
  const template = await readFile(resolve(root, "public/sutra-customer-role-live-demo.yaml"));
  const captureCommand = async (command, args) => {
    calls.push({ kind: "capture", command, args });
    if (args[0] === "sts") {
      return JSON.stringify({
        Account: ACCOUNT_ID,
        Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_Admin_abc/session`,
      });
    }
    if (args[1] === "head-bucket") return "";
    if (args[1] === "get-bucket-tagging") {
      return JSON.stringify({
        TagSet: [
          { Key: "sutra:managed-by", Value: "template-publisher-v1" },
          { Key: "sutra:purpose", Value: "customer-role-quick-create" },
          { Key: "owner", Value: "platform-team" },
        ],
      });
    }
    if (args[1] === "put-object") {
      return JSON.stringify({
        VersionId: "immutable-version-2",
        ChecksumSHA256: createHash("sha256").update(template).digest("base64"),
      });
    }
    return "";
  };
  const runCommand = async (command, args) => {
    calls.push({ kind: "run", command, args });
  };

  const result = await publishOnboardingTemplate({
    environment: environment({ SUTRA_TEMPLATE_BUCKET: "existing-sutra-bucket" }),
    root,
    runCommand,
    captureCommand,
    validateProfile: async () => validatedProfileSource(),
    fetchTemplate: async () => new Response(template, { status: 200 }),
  });

  assert.equal(new URL(result.url).searchParams.get("versionId"), "immutable-version-2");
  assert.equal(calls.some((call) => call.args[1] === "create-bucket"), false);
  assert.equal(calls.some((call) => call.args[1] === "put-bucket-tagging"), false);
  assert.ok(calls.some((call) => call.args[1] === "put-bucket-policy"));
});

test("publisher recovers its deterministic same-account bucket only when untagged and empty", async () => {
  const calls = [];
  const template = await readFile(resolve(root, "public/sutra-customer-role-live-demo.yaml"));
  const captureCommand = async (command, args) => {
    calls.push({ kind: "capture", command, args });
    if (args[0] === "sts") {
      return JSON.stringify({
        Account: ACCOUNT_ID,
        Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_Admin_abc/session`,
      });
    }
    if (args[1] === "head-bucket") return "";
    if (args[1] === "get-bucket-tagging") {
      throw new Error(
        "aws exited 255: An error occurred (NoSuchTagSet) when calling the GetBucketTagging operation: The TagSet does not exist",
      );
    }
    if (args[1] === "list-objects-v2") {
      return JSON.stringify({ KeyCount: 0, IsTruncated: false });
    }
    if (args[1] === "list-object-versions") {
      return JSON.stringify({ IsTruncated: false });
    }
    if (args[1] === "put-object") {
      return JSON.stringify({
        VersionId: "recovered-version",
        ChecksumSHA256: createHash("sha256").update(template).digest("base64"),
      });
    }
    return "";
  };
  const runCommand = async (command, args) => {
    calls.push({ kind: "run", command, args });
  };

  const result = await publishOnboardingTemplate({
    environment: environment(),
    root,
    runCommand,
    captureCommand,
    validateProfile: async () => validatedProfileSource(),
    fetchTemplate: async () => new Response(template, { status: 200 }),
  });

  assert.equal(result.bucket, `sutra-onboarding-${ACCOUNT_ID}-us-east-1`);
  assert.equal(calls.some((call) => call.args[1] === "create-bucket"), false);
  assert.ok(calls.some((call) => call.args[1] === "list-objects-v2"));
  assert.ok(calls.some((call) => call.args[1] === "list-object-versions"));
  assert.ok(calls.some((call) => call.kind === "run" && call.args[1] === "put-bucket-tagging"));
});

test("publisher fails closed on ambiguous absence and non-empty crash-recovery buckets", async (t) => {
  await t.test("ambiguous head error", async () => {
    const calls = [];
    await assert.rejects(publishOnboardingTemplate({
      environment: environment(),
      root,
      runCommand: async (command, args) => calls.push({ command, args }),
      captureCommand: async (_command, args) => {
        if (args[0] === "sts") {
          return JSON.stringify({
            Account: ACCOUNT_ID,
            Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_Admin_abc/session`,
          });
        }
        throw new Error("AccessDenied");
      },
      validateProfile: async () => validatedProfileSource(),
    }), /Unable to prove the template bucket is absent/u);
    assert.equal(calls.some((call) => call.args[1] === "create-bucket"), false);
  });

  await t.test("non-empty deterministic bucket", async () => {
    const calls = [];
    await assert.rejects(publishOnboardingTemplate({
      environment: environment(),
      root,
      runCommand: async (command, args) => calls.push({ kind: "run", command, args }),
      captureCommand: async (_command, args) => {
        if (args[0] === "sts") {
          return JSON.stringify({
            Account: ACCOUNT_ID,
            Arn: `arn:aws:sts::${ACCOUNT_ID}:assumed-role/AWSReservedSSO_Admin_abc/session`,
          });
        }
        if (args[1] === "head-bucket") return "";
        if (args[1] === "get-bucket-tagging") {
          throw new Error(
            "aws exited 255: An error occurred (NoSuchTagSet) when calling the GetBucketTagging operation: The TagSet does not exist",
          );
        }
        if (args[1] === "list-objects-v2") {
          return JSON.stringify({ KeyCount: 1, Contents: [{ Key: "unknown" }] });
        }
        if (args[1] === "list-object-versions") return JSON.stringify({ IsTruncated: false });
        return "";
      },
      validateProfile: async () => validatedProfileSource(),
    }), /unless it is empty/u);
    assert.equal(calls.some((call) => call.args[1] === "put-bucket-tagging"), false);
  });
});
