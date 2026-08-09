import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

/**
 * Duplicate mapping keys in a compose file are accepted silently by lax YAML
 * parsers and rejected by the strict Go parser docker compose uses -- so the
 * defect passes every CI job and then fails on the production host at deploy
 * time. Release run 21 (2026-08-09) failed exactly this way:
 * SUTRA_HOSTED_SELF_SERVE_SIGNUP defined at lines 116 and 169.
 *
 * This is a structural scan, not a YAML parser: within one mapping block
 * (consecutive `key:` lines at the same indentation under the same parent),
 * a repeated key is a failure. That is precisely the shape docker compose
 * rejects, and it needs no YAML dependency.
 */
function duplicateKeys(source) {
  const duplicates = [];
  // Stack of { indent, keys } for open mapping blocks.
  const stack = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const match = /^( *)(- )?([A-Za-z0-9_.-]+):(?: |$)/u.exec(line);
    if (match === null) continue;
    // A list-item line starts a fresh sibling scope; treat its key indent as
    // the dash position plus two so sibling list entries do not collide.
    const indent = match[1].length + (match[2] === undefined ? 0 : 2);
    const key = match[3];
    while (stack.length > 0 && stack[stack.length - 1].indent > indent) stack.pop();
    if (stack.length === 0 || stack[stack.length - 1].indent < indent) {
      stack.push({ indent, keys: new Map() });
    }
    const block = stack[stack.length - 1];
    // A list dash resets the sibling block: `- name:` twice is two entries.
    if (match[2] !== undefined) block.keys.clear();
    if (block.keys.has(key)) {
      duplicates.push({ key, line: index + 1, firstLine: block.keys.get(key) });
    } else {
      block.keys.set(key, index + 1);
    }
  }
  return duplicates;
}

for (const file of ["deploy/ec2/compose.prod.yaml", "compose.yaml"]) {
  test(`${file} defines every mapping key exactly once`, async () => {
    const source = await readFile(resolve(root, file), "utf8");
    const duplicates = duplicateKeys(source);
    assert.deepEqual(
      duplicates,
      [],
      duplicates.map((d) => `${d.key} at line ${d.line} already defined at line ${d.firstLine}`).join("; "),
    );
  });
}

test("the scanner itself catches the release-21 defect shape", () => {
  const broken = [
    "services:",
    "  app:",
    "    environment:",
    "      SUTRA_HOSTED_SELF_SERVE_SIGNUP: ${SUTRA_HOSTED_SELF_SERVE_SIGNUP:-false}",
    "      SUTRA_OTHER: value",
    '      SUTRA_HOSTED_SELF_SERVE_SIGNUP: "false"',
  ].join("\n");
  const found = duplicateKeys(broken);
  assert.equal(found.length, 1);
  assert.equal(found[0].key, "SUTRA_HOSTED_SELF_SERVE_SIGNUP");
  // Same key at a DIFFERENT nesting level is legal and must not be flagged.
  const nested = [
    "services:",
    "  app:",
    "    environment:",
    "      KEY: a",
    "  worker:",
    "    environment:",
    "      KEY: b",
  ].join("\n");
  assert.deepEqual(duplicateKeys(nested), []);
});
