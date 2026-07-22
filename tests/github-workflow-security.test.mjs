import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const workflowDirectory = new URL("../.github/workflows/", import.meta.url);

function workflowFiles() {
  return readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => ({
      name,
      source: readFileSync(new URL(name, workflowDirectory), "utf8"),
    }));
}

function runScripts(source) {
  const lines = source.split("\n");
  const scripts = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*(.*)$/u);
    if (!match) {
      continue;
    }

    const indentation = match[1].length;
    const declaration = match[2].trim();
    if (declaration && declaration !== "|" && declaration !== ">") {
      scripts.push(declaration);
      continue;
    }

    const block = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === "") {
        block.push(line);
        continue;
      }

      const lineIndentation = line.length - line.trimStart().length;
      if (lineIndentation <= indentation) {
        break;
      }
      block.push(line);
    }
    scripts.push(block.join("\n"));
  }

  return scripts;
}

test("third-party GitHub Actions are pinned to immutable commit SHAs", () => {
  for (const workflow of workflowFiles()) {
    const uses = [...workflow.source.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map(
      (match) => match[1],
    );

    for (const action of uses) {
      if (action.startsWith("./") || action.startsWith("docker://")) {
        continue;
      }
      assert.match(
        action,
        /^[^@]+@[0-9a-f]{40}$/u,
        `${workflow.name} must pin ${action} to a full commit SHA`,
      );
    }
  }
});

test("workflow inputs are never interpolated directly into shell scripts", () => {
  for (const workflow of workflowFiles()) {
    for (const script of runScripts(workflow.source)) {
      assert.doesNotMatch(
        script,
        /\$\{\{\s*inputs\./u,
        `${workflow.name} must pass inputs through environment variables and validate them`,
      );
    }
  }
});

test("CI runs slow gates independently and aggregates them fail-closed", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

  assert.match(ci, /^\s{2}quality:\s*$/mu);
  assert.match(ci, /^\s{2}integration:\s*$/mu);
  assert.match(ci, /^\s{2}build:\s*$/mu);
  assert.match(ci, /^\s{2}release-gate:\s*$/mu);
  assert.match(ci, /needs: \[quality, integration, build\]/u);
  assert.match(ci, /if: \$\{\{ always\(\) \}\}/u);
  assert.match(ci, /QUALITY_RESULT: \$\{\{ needs\.quality\.result \}\}/u);
  assert.match(ci, /INTEGRATION_RESULT: \$\{\{ needs\.integration\.result \}\}/u);
  assert.match(ci, /BUILD_RESULT: \$\{\{ needs\.build\.result \}\}/u);
  assert.match(ci, /test "\$QUALITY_RESULT" = success/u);
  assert.match(ci, /test "\$INTEGRATION_RESULT" = success/u);
  assert.match(ci, /test "\$BUILD_RESULT" = success/u);
});

test("the in-cluster security gate runs with an immutable root filesystem", () => {
  const manifest = readFileSync(
    new URL("../deploy/ci/kubernetes-gate-job.yaml", import.meta.url),
    "utf8",
  );

  assert.match(manifest, /readOnlyRootFilesystem:\s*true/u);
  assert.doesNotMatch(manifest, /readOnlyRootFilesystem:\s*false/u);
  assert.doesNotMatch(
    manifest,
    /\bapt-get\b/u,
    "a read-only gate must not attempt to mutate the base image",
  );
});
