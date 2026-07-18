import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseFalcoRuntimePayload } from "../lib/falco-runtime-boundary.ts";
import { FALCO_PRIORITIES, projectFalcoTimeline } from "../lib/falco-runtime-types.ts";

const clusterId = `kcluster_${"a".repeat(48)}`;
const pack = await readFile(new URL("../deploy/policies/falco/sutra-runtime-rules.yaml", import.meta.url), "utf8");

// Split the file into per-rule blocks (each starts with "- rule:").
const blocks = pack.split(/^- rule:/mu).slice(1).map((block) => `- rule:${block}`);
function field(block: string, key: string): string | null {
  const match = block.match(new RegExp(`^\\s*(?:- )?${key}:\\s*(.+)$`, "mu"));
  return match ? match[1].trim() : null;
}

test("the pack defines a meaningful set of curated rules", () => {
  assert.ok(blocks.length >= 6, `expected at least 6 rules, found ${blocks.length}`);
});

test("every rule uses a priority Sutra recognizes and has a condition and output", () => {
  for (const block of blocks) {
    const rule = field(block, "rule");
    const priority = field(block, "priority");
    assert.ok(rule && rule.length > 0, "rule has a name");
    assert.ok(priority !== null, `${rule ?? "rule"} has a priority`);
    assert.ok(
      (FALCO_PRIORITIES as readonly string[]).includes(priority.toLowerCase()),
      `${rule}: priority "${priority}" is not one of ${FALCO_PRIORITIES.join(", ")}`,
    );
    assert.ok(/^\s*condition:/mu.test(block), `${rule} has a condition`);
    assert.ok(/^\s*output:/mu.test(block), `${rule} has an output`);
  }
});

test("no rule output relies on fields the ingestion boundary drops", () => {
  // Detail intent must live in the rule name; outputs must not depend on raw
  // command lines, environment, or event payloads (all stripped at ingestion).
  for (const block of blocks) {
    const output = field(block, "output") ?? "";
    for (const dropped of ["proc.cmdline", "proc.env", "evt.arg.data", "%output"]) {
      assert.ok(!output.includes(dropped), `${field(block, "rule")}: output must not reference ${dropped}`);
    }
  }
});

test("each rule name + priority survives the ingestion boundary as a finding", () => {
  for (const block of blocks) {
    const rule = field(block, "rule") as string;
    const priority = (field(block, "priority") as string).toLowerCase();
    const body = Buffer.from(JSON.stringify({
      rule,
      priority: priority.charAt(0).toUpperCase() + priority.slice(1),
      time: "2026-07-18T00:00:00.000000Z",
      source: "syscall",
      output_fields: {
        "k8s.ns.name": "payments",
        "k8s.pod.name": "api-1",
        "container.name": "api",
        "proc.name": "sh",
        "evt.type": "execve",
      },
    }));
    const [event] = parseFalcoRuntimePayload({ clusterId, body });
    assert.equal(event.rule, rule, `${rule} passes through verbatim`);
    assert.ok((FALCO_PRIORITIES as readonly string[]).includes(event.priority));
    // The rule name becomes the finding title and drives a containment plan.
    const timeline = projectFalcoTimeline(event);
    assert.equal(timeline.title, rule);
    assert.ok(["low", "medium", "high", "critical"].includes(timeline.containment.severity));
  }
});
