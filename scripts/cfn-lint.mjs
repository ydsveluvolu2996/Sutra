import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const templatePaths = process.argv.slice(2);
if (templatePaths.length === 0) {
  process.stderr.write("Usage: node scripts/cfn-lint.mjs <template> [...template]\n");
  process.exit(2);
}

const result = spawnSync("cfn-lint", ["--format", "json", ...templatePaths], {
  cwd: process.cwd(),
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

if (result.error !== undefined) {
  process.stderr.write(`Unable to execute cfn-lint: ${result.error.message}\n`);
  process.exit(2);
}

let findings;
try {
  findings = result.stdout.trim().length === 0 ? [] : JSON.parse(result.stdout);
} catch {
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  process.stderr.write("cfn-lint did not return valid JSON.\n");
  process.exit(2);
}

if (!Array.isArray(findings)) {
  process.stderr.write("cfn-lint returned an unexpected result.\n");
  process.exit(2);
}

/**
 * cfn-lint 1.46.0 predates the Bedrock account data-retention API. AWS
 * documents `bedrock:GetAccountDataRetention`, but W3037 still rejects it.
 * Suppress only that exact action on the exact reported source line; every
 * other IAM-action warning remains release-blocking.
 */
function isDocumentedBedrockRetentionFalsePositive(finding) {
  if (
    finding?.Rule?.Id !== "W3037" ||
    typeof finding.Message !== "string" ||
    !finding.Message.startsWith("'getaccountdataretention' is not one of") ||
    typeof finding.Filename !== "string"
  ) {
    return false;
  }
  const policyField = finding?.Location?.Path?.at?.(-1);
  if (policyField !== "Action" && policyField !== "NotAction") return false;
  try {
    const source = readFileSync(resolve(finding.Filename), "utf8");
    // W3037 reports the containing Action/NotAction block rather than the
    // individual list item's line, so validate the exact token in that file.
    return /^\s*-\s+bedrock:GetAccountDataRetention\s*$/mu.test(source);
  } catch {
    return false;
  }
}

const remaining = findings.filter((finding) => !isDocumentedBedrockRetentionFalsePositive(finding));
const suppressed = findings.length - remaining.length;

if (remaining.length > 0) {
  process.stderr.write(`${JSON.stringify(remaining, null, 2)}\n`);
  process.exit(1);
}

process.stdout.write(
  `CloudFormation lint passed for ${templatePaths.length} template(s)` +
  `${suppressed > 0 ? `; suppressed ${suppressed} documented Bedrock catalog false positive(s)` : ""}.\n`,
);
