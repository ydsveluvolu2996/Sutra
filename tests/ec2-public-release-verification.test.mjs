import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const releaseUpdate = await readFile(
  new URL("../deploy/ec2/release-update.sh", import.meta.url),
  "utf8",
);

test("EC2 release retries Cloudflare indexable-body convergence without weakening checks", () => {
  assert.match(releaseUpdate, /require_indexable_body_match\(\)/u);
  assert.match(
    releaseUpdate,
    /for \(\(content_attempt = 1; content_attempt <= 3; content_attempt \+= 1\)\)/u,
  );
  assert.match(releaseUpdate, /fetch_public "\$path" "\$label" 3/u);
  assert.match(releaseUpdate, /require_indexable_response "\$path"/u);
  assert.match(releaseUpdate, /"Sitemap: \$PUBLIC_ORIGIN\/sitemap\.xml"/u);
  assert.match(releaseUpdate, /"<loc>\$PUBLIC_ORIGIN\/<\/loc>"/u);
  assert.match(releaseUpdate, /The public robots\.txt does not advertise the canonical sitemap/u);
  assert.match(releaseUpdate, /The public sitemap does not contain the canonical site origin/u);
});
