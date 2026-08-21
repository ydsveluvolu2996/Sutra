import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [browser, rootPage, destinationPage, navigation] = await Promise.all([
  readFile(new URL("../app/cmdb/navigator/aws-navigator-browser.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/cmdb/navigator/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/cmdb/navigator/[...segments]/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/components/navigation-config.ts", import.meta.url), "utf8"),
]);

test("Navigator UI exposes category/service/type routes, scope, breadcrumbs, search, recent and pinned destinations", () => {
  assert.match(rootPage, /active="cmdb_navigator"/u);
  assert.match(destinationPage, /resolved\.segments/u);
  assert.match(navigation, /AWS Navigator/u);
  for (const token of ["navigator-breadcrumbs", "Region boundary", "Server-scoped search", "Pinned", "Recent", "Resource-type contract"]) {
    assert.match(browser, new RegExp(token, "u"));
  }
});

test("Navigator UI labels unavailable evidence instead of rendering a false zero", () => {
  assert.match(browser, /authoritativeCount !== null/u);
  assert.match(browser, /Last known/u);
  assert.match(browser, /not a current count/u);
  assert.match(browser, /Resource counts remain unavailable; they are not reported as zero/u);
  assert.match(browser, /observed in .* covered types/u);
});
