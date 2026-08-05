import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const wrapper = new URL("../scripts/cfn-lint.mjs", import.meta.url);

function finding(message, filename, policyField = "Action") {
  return {
    Filename: filename,
    Level: "Warning",
    Location: { Path: ["Resources", "Role", "Properties", policyField] },
    Message: message,
    Rule: { Id: "W3037" },
  };
}

async function fixture(source) {
  const directory = await mkdtemp(join(tmpdir(), "sutra-cfn-lint-"));
  const executable = join(directory, "cfn-lint");
  const template = join(directory, "template.yaml");
  await writeFile(
    executable,
    "#!/bin/sh\nprintf '%s' \"$SUTRA_TEST_CFN_FINDINGS\"\nexit \"${SUTRA_TEST_CFN_EXIT:-0}\"\n",
    "utf8",
  );
  await chmod(executable, 0o700);
  await writeFile(template, source, "utf8");
  return { directory, executable, template };
}

function run(input, findings, exitCode = 4) {
  return spawnSync(process.execPath, [wrapper.pathname, input.template], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${input.directory}${delimiter}${process.env.PATH ?? ""}`,
      SUTRA_TEST_CFN_FINDINGS: JSON.stringify(findings),
      SUTRA_TEST_CFN_EXIT: String(exitCode),
    },
  });
}

test("wrapper suppresses only the exact documented Bedrock catalog lag", async (context) => {
  const input = await fixture(
    "Action:\n  - bedrock:GetAccountDataRetention\n",
  );
  context.after(() => rm(input.directory, { recursive: true, force: true }));
  const result = run(input, [
    finding(
      "'getaccountdataretention' is not one of ['getguardrail']",
      input.template,
    ),
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /suppressed 1 documented Bedrock catalog false positive/u);
});

test("wrapper keeps every other IAM action finding release-blocking", async (context) => {
  const input = await fixture(
    "Action:\n  - bedrock:GetAccountDataRetention\n  - bedrock:DefinitelyNotAnAwsAction\n",
  );
  context.after(() => rm(input.directory, { recursive: true, force: true }));
  const result = run(input, [
    finding(
      "'getaccountdataretention' is not one of ['getguardrail']",
      input.template,
    ),
    finding(
      "'definitelynotanawsaction' is not one of ['getguardrail']",
      input.template,
    ),
  ]);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /getaccountdataretention/u);
  assert.match(result.stderr, /definitelynotanawsaction/u);
});

test("wrapper refuses the exception when the exact action is absent", async (context) => {
  const input = await fixture("Action:\n  - bedrock:GetGuardrail\n");
  context.after(() => rm(input.directory, { recursive: true, force: true }));
  const result = run(input, [
    finding(
      "'getaccountdataretention' is not one of ['getguardrail']",
      input.template,
    ),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /getaccountdataretention/u);
});
