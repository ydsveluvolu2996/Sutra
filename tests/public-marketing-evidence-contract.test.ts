import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "..");

describe("public marketing evidence contract", () => {
  it("uses source-readiness previews instead of fabricated customer records", async () => {
    const landing = await readFile(path.join(root, "app/components/landing-zone.tsx"), "utf8");

    assert.match(landing, /No sample records/u);
    assert.match(landing, /No sample counts/u);
    assert.match(landing, /persisted from a successful collection or import/u);
    assert.doesNotMatch(landing, /data-n=/u);
    assert.doesNotMatch(landing, /security-graph · live/u);
    assert.doesNotMatch(landing, /CVE-20\d{2}-\d+/u);
    assert.doesNotMatch(landing, /api-gateway|payments-sa|batch-runner|northstar-admin|bluepeak-viewer/iu);
    assert.doesNotMatch(landing, /SEC-\d+|INC\d+|\$\d{1,3},\d{3}|path confirmed/u);
    assert.doesNotMatch(landing, /pvRows\([^)]*,\s*\[\s*\{/u);
  });

  it("labels live, configuration-dependent, and planned capability boundaries", async () => {
    const landing = await readFile(path.join(root, "app/components/landing-zone.tsx"), "utf8");
    const capabilityCodes = [...landing.matchAll(/\{ code: "([A-Z]+)"/gu)].map((match) => match[1]);
    const readinessBlock = /const CAPABILITY_READINESS[\s\S]*?\n\};/u.exec(landing)?.[0] ?? "";

    assert.ok(capabilityCodes.length > 0);
    for (const code of capabilityCodes) {
      assert.match(readinessBlock, new RegExp(`\\b${code}:\\s*"`), `${code} has no readiness label`);
    }
    assert.match(landing, /Live after AWS connection/u);
    assert.match(landing, /Operator configured/u);
    assert.match(landing, /Azure · GCP<em>planned<\/em>/u);
    assert.match(landing, /Planned providers stay labelled planned/u);
    assert.doesNotMatch(landing, /Every capability below is live|Every Sutra behavior above is live/u);
  });

  it("does not publish unsupported deployment or commercial commitments", async () => {
    const landing = await readFile(path.join(root, "app/components/landing-zone.tsx"), "utf8");

    assert.match(landing, /A separated service architecture/u);
    assert.match(landing, /pricing are confirmed through a commercial review/u);
    assert.doesNotMatch(landing, /A production architecture/u);
    assert.doesNotMatch(landing, /monthly:\s*\d+|two months free|17% off|\/mo/u);
  });

  it("presents About as an enterprise product without an early-stage qualifier", async () => {
    const about = await readFile(path.join(root, "app/about/page.tsx"), "utf8");

    assert.doesNotMatch(about, /Sutra is early/iu);
    assert.match(about, /Azure and Google Cloud remain planned/u);
    assert.match(about, /report their own configuration readiness/u);
  });
});
