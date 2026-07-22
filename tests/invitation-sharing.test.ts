import assert from "node:assert/strict";
import test from "node:test";
import {
  copyInvitationUrl,
  invitationEmailHref,
  shareInvitation,
} from "../app/access/invitation-sharing.ts";

const details = {
  activationUrl: "https://www.sutracmdb.com/accept-invite?token=single-use-secret",
  email: "client@example.com",
  expiresAt: "2026-07-23T12:00:00.000Z",
};

test("email sharing opens a draft and never claims the message was sent", () => {
  const href = invitationEmailHref(details);
  const parsed = new URL(href);
  assert.equal(parsed.protocol, "mailto:");
  assert.equal(decodeURIComponent(parsed.pathname), details.email);
  assert.equal(parsed.searchParams.get("subject"), "Your secure Sutra invitation");
  assert.match(parsed.searchParams.get("body") ?? "", /single-use/u);
  assert.match(parsed.searchParams.get("body") ?? "", /single-use-secret/u);
  assert.doesNotMatch(parsed.searchParams.get("body") ?? "", /was sent|delivered successfully/iu);
});

test("copy prefers the asynchronous Clipboard API", async () => {
  let copied = "";
  await copyInvitationUrl(details.activationUrl, {
    clipboard: { writeText: async (value) => { copied = value; } },
  }, undefined);
  assert.equal(copied, details.activationUrl);
});

test("copy uses and then removes a local-demo fallback", async () => {
  let selected = false;
  let removed = false;
  let appended = false;
  const temporary = {
    value: "",
    style: {},
    setAttribute() {},
    select() { selected = true; },
    remove() { removed = true; },
  };
  const documentLike = {
    body: { appendChild() { appended = true; } },
    createElement() { return temporary; },
    execCommand(command: string) { return command === "copy"; },
  };
  await copyInvitationUrl(details.activationUrl, undefined, documentLike as never);
  assert.equal(temporary.value, details.activationUrl);
  assert.equal(appended, true);
  assert.equal(selected, true);
  assert.equal(removed, true);
});

test("native sharing reports completion, cancellation and unsupported browsers", async () => {
  let sharedUrl = "";
  assert.equal(await shareInvitation(details, {
    share: async (data) => { sharedUrl = data.url; },
  }), "shared");
  assert.equal(sharedUrl, details.activationUrl);

  assert.equal(await shareInvitation(details, {
    share: async () => { throw { name: "AbortError" }; },
  }), "cancelled");
  assert.equal(await shareInvitation(details, {}), "unsupported");
});
