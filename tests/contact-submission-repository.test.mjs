import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { Miniflare } from "miniflare";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const runtimeMigrations = await import("../db/runtime-migrations.ts");
const {
  ContactSubmissionRepository,
  ContactSubmissionRepositoryError,
  parseContactSubmission,
} = await import("../db/contact-submission-repository.ts");
const {
  deliverContactSubmission,
  resolveContactRecipient,
  DEFAULT_CONTACT_RECIPIENT,
} = await import("../lib/contact-delivery.ts");

async function withDatabase(run) {
  const miniflare = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    compatibilityDate: "2026-05-22",
    d1Databases: { DB: `sutra-contact-${crypto.randomUUID()}` },
    d1Persist: false,
  });
  try {
    const database = await miniflare.getD1Database("DB");
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(database);
    await run(new ContactSubmissionRepository(database), database);
  } finally {
    await miniflare.dispose();
  }
}

const VALID = { name: "Ada Lovelace", email: "ada@example.com", company: "Analytical", message: "We run 3 AWS accounts and an EKS cluster." };

test("parse accepts a well-formed submission and normalizes optional company", () => {
  const parsed = parseContactSubmission(VALID);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.drop, false);
  assert.deepEqual(parsed.value, { name: "Ada Lovelace", email: "ada@example.com", company: "Analytical", message: "We run 3 AWS accounts and an EKS cluster." });
  const noCompany = parseContactSubmission({ name: "Ada", email: "ada@example.com", message: "hi" });
  assert.equal(noCompany.ok, true);
  assert.equal(noCompany.value.company, null);
});

test("parse rejects missing/invalid fields, unknown keys, and oversized values", () => {
  const cases = [
    { name: "", email: "ada@example.com", message: "hi" }, // empty name
    { name: "Ada", email: "not-an-email", message: "hi" }, // bad email
    { name: "Ada", email: "ada@example.com", message: "" }, // empty message
    { name: "Ada", email: "ada@example.com", message: "x".repeat(2001) }, // message too long
    { name: "x".repeat(201), email: "ada@example.com", message: "hi" }, // name too long
    { name: "Ada", email: "ada@example.com", message: "hi", surprise: "extra" }, // unknown key
    "not an object",
    null,
    ["array"],
  ];
  for (const bad of cases) {
    assert.equal(parseContactSubmission(bad).ok, false, `expected reject: ${JSON.stringify(bad)}`);
  }
});

test("parse silently drops a submission whose honeypot is filled", () => {
  const parsed = parseContactSubmission({ ...VALID, website: "http://spam.example" });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.drop, true);
  // An empty honeypot is a normal human submission.
  assert.equal(parseContactSubmission({ ...VALID, website: "" }).drop, false);
});

test("0036 migration applies; an accepted submission persists and reads back", async () => {
  await withDatabase(async (repo, database) => {
    const parsed = parseContactSubmission(VALID);
    assert.equal(parsed.ok, true);
    const id = await repo.record({ ...parsed.value, sourceIp: "203.0.113.7", recipient: DEFAULT_CONTACT_RECIPIENT, delivered: false });
    assert.match(id, /^contact_[a-f0-9]{32}$/u);
    const row = await database.prepare("SELECT name, email, company, message, source_ip, recipient, delivered FROM contact_submissions WHERE id = ?").bind(id).first();
    assert.equal(row.name, "Ada Lovelace");
    assert.equal(row.recipient, DEFAULT_CONTACT_RECIPIENT);
    assert.equal(row.delivered, 0);
  });
});

test("markDelivered flips a reserved row's delivered flag (record-before-deliver)", async () => {
  await withDatabase(async (repo, database) => {
    const parsed = parseContactSubmission(VALID);
    // Reserve the row first with delivered = 0, as the route now does.
    const id = await repo.record({ ...parsed.value, sourceIp: "203.0.113.7", recipient: DEFAULT_CONTACT_RECIPIENT, delivered: false });
    let row = await database.prepare("SELECT delivered FROM contact_submissions WHERE id = ?").bind(id).first();
    assert.equal(row.delivered, 0);
    // A confirmed delivery flips the flag on the already-persisted row.
    await repo.markDelivered(id);
    row = await database.prepare("SELECT delivered FROM contact_submissions WHERE id = ?").bind(id).first();
    assert.equal(row.delivered, 1);
    // A malformed id never touches storage.
    await assert.rejects(
      repo.markDelivered("not-a-contact-id"),
      (error) => error instanceof ContactSubmissionRepositoryError,
    );
  });
});

test("record rejects a malformed submission before any write", async () => {
  await withDatabase(async (repo, database) => {
    await assert.rejects(
      repo.record({ name: "Ada", email: "bad", company: null, message: "hi", sourceIp: "203.0.113.7", recipient: DEFAULT_CONTACT_RECIPIENT, delivered: false }),
      (error) => error instanceof ContactSubmissionRepositoryError && error.code === "INVALID_INPUT",
    );
    const count = await database.prepare("SELECT COUNT(*) AS total FROM contact_submissions").first();
    assert.equal(Number(count.total), 0);
  });
});

test("rate-window counters isolate per source and roll off with the window", async () => {
  await withDatabase(async (repo) => {
    const base = 1_000_000_000_000;
    const parsed = parseContactSubmission(VALID);
    for (let i = 0; i < 5; i++) {
      await repo.record({ ...parsed.value, sourceIp: "198.51.100.9", recipient: DEFAULT_CONTACT_RECIPIENT, delivered: false }, base + i);
    }
    await repo.record({ ...parsed.value, sourceIp: "203.0.113.1", recipient: DEFAULT_CONTACT_RECIPIENT, delivered: false }, base + 10);

    // Within the last-minute window, the flooding source shows all 5.
    assert.equal(await repo.countRecentForSource("198.51.100.9", base), 5);
    assert.equal(await repo.countRecentForSource("203.0.113.1", base), 1);
    // Global ceiling sees every persisted row.
    assert.equal(await repo.countRecentGlobal(base), 6);
    // A window that starts after the writes counts none (roll-off).
    assert.equal(await repo.countRecentForSource("198.51.100.9", base + 100), 0);
  });
});

test("delivery is honest: no transport => delivered=false, webhook 2xx => delivered=true", async () => {
  const payload = { name: "Ada", email: "ada@example.com", company: null, message: "hi", sourceIp: "203.0.113.7", submittedAt: new Date(0).toISOString() };

  // No transport configured — never claims an email was sent.
  const none = await deliverContactSubmission(DEFAULT_CONTACT_RECIPIENT, payload, {});
  assert.deepEqual(none, { delivered: false, transport: "none" });

  // Webhook returns 2xx -> delivered true, and receives the recipient + lead.
  let seen = null;
  const okFetch = async (url, init) => { seen = { url, body: JSON.parse(init.body) }; return new Response("", { status: 202 }); };
  const ok = await deliverContactSubmission(DEFAULT_CONTACT_RECIPIENT, payload, { SUTRA_CONTACT_WEBHOOK_URL: "https://hook.example/contact" }, okFetch);
  assert.deepEqual(ok, { delivered: true, transport: "webhook" });
  assert.equal(seen.url, "https://hook.example/contact");
  assert.equal(seen.body.recipient, DEFAULT_CONTACT_RECIPIENT);
  assert.equal(seen.body.submission.email, "ada@example.com");

  // Non-2xx or a thrown fetch -> delivered false (persistence still happens upstream).
  const bad = await deliverContactSubmission(DEFAULT_CONTACT_RECIPIENT, payload, { SUTRA_CONTACT_WEBHOOK_URL: "https://hook.example/contact" }, async () => new Response("", { status: 500 }));
  assert.equal(bad.delivered, false);
  const threw = await deliverContactSubmission(DEFAULT_CONTACT_RECIPIENT, payload, { SUTRA_CONTACT_WEBHOOK_URL: "https://hook.example/contact" }, async () => { throw new Error("network"); });
  assert.equal(threw.delivered, false);

  // A non-HTTPS webhook is ignored (no plaintext exfiltration of leads).
  const insecure = await deliverContactSubmission(DEFAULT_CONTACT_RECIPIENT, payload, { SUTRA_CONTACT_WEBHOOK_URL: "http://hook.example/contact" });
  assert.equal(insecure.transport, "none");
});

test("recipient resolves to the configured address or the documented default", () => {
  assert.equal(resolveContactRecipient({}), DEFAULT_CONTACT_RECIPIENT);
  assert.equal(resolveContactRecipient({ SUTRA_CONTACT_RECIPIENT: "team@sutra.example" }), "team@sutra.example");
  // An invalid override falls back rather than routing a lead nowhere.
  assert.equal(resolveContactRecipient({ SUTRA_CONTACT_RECIPIENT: "not-an-email" }), DEFAULT_CONTACT_RECIPIENT);
});
