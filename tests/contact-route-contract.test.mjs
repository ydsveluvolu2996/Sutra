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
  // The global cap is tightened to a sane backstop (60/min).
  assert.match(route, /MAX_GLOBAL_PER_WINDOW = 60/u);
});

test("contact route only trusts cf-connecting-ip and never the spoofable x-forwarded-for", () => {
  // The rate-limit bucket key comes ONLY from the Cloudflare edge header.
  assert.match(route, /cf-connecting-ip/u);
  // A client-supplied x-forwarded-for must NOT be READ as a bucket key, or a
  // spoofer could mint unlimited independent buckets. (An explanatory comment
  // may still name the header; what matters is that it is never fetched.)
  assert.doesNotMatch(route, /\.get\(\s*["']x-forwarded-for/u);
  // Absent the trusted header, everything collapses to one shared bucket.
  assert.match(route, /UNATTRIBUTED_SOURCE|"unattributed"/u);
});

test("contact route records BEFORE delivering, then flips the delivered flag", () => {
  assert.match(route, /resolveContactRecipient\(deliveryEnv\)/u);
  assert.match(route, /deliverContactSubmission\(/u);
  assert.match(route, /repository\.record\(/u);
  assert.match(route, /markDelivered\(id\)/u);
  // The row is reserved (delivered: false) before the outbound delivery, so the
  // rate-limit counts include in-flight submissions (TOCTOU close).
  assert.ok(
    route.indexOf("repository.record(") < route.indexOf("deliverContactSubmission("),
    "record() must be called before deliverContactSubmission()",
  );
  assert.match(route, /delivered: false/u);
  // No mailto/placeholder leakage in the endpoint.
  assert.doesNotMatch(route, /mailto:/u);
  assert.doesNotMatch(route, /hello@sutra/u);
});
