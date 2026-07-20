import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("../app/api/contact/route.ts", import.meta.url), "utf8");
const deploymentSecurity = await readFile(new URL("../lib/deployment-security.ts", import.meta.url), "utf8");

test("contact route is force-dynamic and PUBLIC (no session requirement)", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.doesNotMatch(route, /requireApiSession/u);
  // The path is on the public preview allowlist alongside /contact.
  assert.match(deploymentSecurity, /"\/contact", "\/api\/contact"/u);
});

test("contact route reads a bounded body, validates, and answers with json/error helpers", () => {
  assert.match(route, /readBoundedJson\(request, MAX_BODY_BYTES\)/u);
  assert.match(route, /parseContactSubmission\(body\)/u);
  assert.match(route, /return jsonResponse\(\{ ok: true \}\)/u);
  assert.match(route, /return errorResponse\(error\)/u);
  // Invalid input becomes a 400 via the INVALID_INPUT code path.
  assert.match(route, /code: "INVALID_INPUT"/u);
});

test("contact route drops honeypot hits silently with a 200", () => {
  // When parse flags a drop, the route returns ok WITHOUT persisting.
  assert.match(route, /parsed\.ok && parsed\.drop/u);
  assert.match(route, /return jsonResponse\(\{ ok: true \}\);/u);
});

test("contact route enforces a durable per-source + global rate window (429)", () => {
  assert.match(route, /countRecentForSource\(ip, since\)/u);
  assert.match(route, /countRecentGlobal\(since\)/u);
  assert.match(route, /MAX_PER_SOURCE_PER_WINDOW/u);
  assert.match(route, /MAX_GLOBAL_PER_WINDOW/u);
  assert.match(route, /status: 429/u);
  // Source IP comes from the edge headers, never from the JSON body.
  assert.match(route, /cf-connecting-ip/u);
  assert.match(route, /x-forwarded-for/u);
});

test("contact route persists every accepted lead and routes to a resolved recipient", () => {
  assert.match(route, /resolveContactRecipient\(deliveryEnv\)/u);
  assert.match(route, /deliverContactSubmission\(/u);
  assert.match(route, /repository\.record\(/u);
  // No mailto/placeholder leakage in the endpoint.
  assert.doesNotMatch(route, /mailto:/u);
  assert.doesNotMatch(route, /hello@sutra/u);
});
