import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const { sessionTokenFromRequest } = await import("../lib/api-auth.ts");

test("forwarded identity and tenant headers cannot create a Sutra browser session", () => {
  const request = new Request("https://app.sutra.test/api/v1/portfolio", {
    headers: {
      authorization: `Bearer ${"a".repeat(64)}`,
      "cf-access-authenticated-user-email": "owner@attacker.invalid",
      "x-authenticated-user": "usr_attacker",
      "x-forwarded-email": "owner@attacker.invalid",
      "x-forwarded-user": "usr_attacker",
      "x-org-id": "org_victim",
      "x-customer-id": "cust_victim",
      "x-role": "org_owner",
    },
  });
  assert.equal(sessionTokenFromRequest(request), null);
});

test("only the exact high-entropy session cookie is considered identity material", () => {
  const valid = "A".repeat(43);
  assert.equal(sessionTokenFromRequest(new Request("https://app.sutra.test", {
    headers: { cookie: `identity=usr_attacker; organization=org_victim; sutra_session=${valid}` },
  })), valid);
  for (const cookie of [
    "sutra_session=short",
    `SUTRA_SESSION=${valid}`,
    `sutra-session=${valid}`,
    `sutra_session=${"!".repeat(43)}`,
  ]) {
    assert.equal(sessionTokenFromRequest(new Request("https://app.sutra.test", {
      headers: { cookie },
    })), null);
  }
});

test("the every-request auth boundary resolves identity only through session lookup", async () => {
  const source = await readFile(new URL("../lib/api-auth.ts", import.meta.url), "utf8");
  const boundary = source.slice(
    source.indexOf("export async function requireApiSession"),
    source.indexOf("export function assertSessionCapability"),
  );
  assert.match(boundary, /!\["GET", "HEAD", "OPTIONS"\]\.includes\(request\.method\.toUpperCase\(\)\)/u);
  assert.match(boundary, /assertSameOrigin\(request, configuredPublicOrigin\(\)\)/u);
  assert.match(boundary, /sessionTokenFromRequest\(request\)/u);
  assert.match(boundary, /getLocalSession\(/u);
  assert.doesNotMatch(
    boundary,
    /x-(?:authenticated|forwarded)-(?:user|email)|cf-access-authenticated-user-email|x-org-id|x-customer-id|x-role/iu,
  );
});
