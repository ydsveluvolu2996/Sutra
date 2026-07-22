import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const [access, sharing] = await Promise.all([
  readFile(resolve(root, "app/access/access-browser.tsx"), "utf8"),
  readFile(resolve(root, "app/access/invitation-sharing.ts"), "utf8"),
]);

test("invitation UI distinguishes provider acceptance from inbox delivery", () => {
  assert.match(access, /provider accepted this message/iu);
  assert.match(access, /not inbox delivery/iu);
  assert.match(access, /No automatic email was sent/iu);
  assert.match(access, /delivery\.status/iu);
  assert.doesNotMatch(access, /email (?:was )?delivered successfully/iu);
});

test("one-time links have explicit copy, share, email-draft and dismissal actions", () => {
  assert.match(access, /copyInvitationUrl/u);
  assert.match(access, /shareInvitation/u);
  assert.match(access, /invitationEmailHref/u);
  assert.match(access, /Dismiss link/u);
  assert.match(access, /setOneTimeInvitation\(null\)/u);
  assert.match(sharing, /temporary\.remove\(\)/u);
});

test("resend uses a sticky idempotency key and never leaves an old token visible", () => {
  assert.match(access, /Idempotency-Key/u);
  assert.match(access, /resendOperations\.current/u);
  assert.match(access, /\/api\/v1\/invitations\/\$\{encodeURIComponent\(invitation\.id\)\}\/resend/u);
  assert.match(access, /may be invalidated by[\s\S]*setOneTimeInvitation/iu);
  assert.match(access, /will reuse its idempotency key/iu);
});

test("resend clears consumed MFA before an ambiguous delivery and preserves replay state", () => {
  const resendStart = access.indexOf("async function resend(");
  const resendEnd = access.indexOf("async function revoke(", resendStart);
  assert.notEqual(resendStart, -1);
  assert.notEqual(resendEnd, -1);
  const resend = access.slice(resendStart, resendEnd);
  const stepUp = resend.indexOf("await stepUpIfProvided();");
  const clearTotp = resend.indexOf('setTotpCode("");', stepUp);
  const rememberOperation = resend.indexOf("resendOperations.current.set", clearTotp);
  const deliveryAttempt = resend.indexOf("attemptedDelivery = true", rememberOperation);
  const readResponse = resend.indexOf("await readAuthResponse", deliveryAttempt);
  const forgetOperation = resend.indexOf("resendOperations.current.delete", readResponse);

  assert.ok(stepUp >= 0 && stepUp < clearTotp, "MFA must succeed before its code is cleared");
  assert.ok(clearTotp < rememberOperation, "the consumed code must clear before delivery can become ambiguous");
  assert.ok(rememberOperation < deliveryAttempt, "the replay key must be retained before sending");
  assert.ok(deliveryAttempt < readResponse && readResponse < forgetOperation,
    "the replay key must be deleted only after a readable successful response");
});

test("initial creation uses a sticky request-bound idempotency key", () => {
  assert.match(access, /creationOperation\.current\?\.bodyJson === bodyJson/u);
  assert.match(access, /creationOperation\.current = operation/u);
  assert.match(access, /"Idempotency-Key": operation\.key/u);
  assert.match(access, /will reuse its idempotency key and will not create or email a duplicate/iu);
  assert.match(access, /previous creation was confirmed without creating or emailing a duplicate/iu);
  assert.match(
    access,
    /await postAuth\("\/api\/auth\/mfa\/step-up", \{ code: totpCode \}\);\s*\/\/[\s\S]*?setTotpCode\(""\);/u,
    "a consumed MFA code is cleared before the ambiguous invitation request",
  );
});

test("assigned-customer invitations always submit an exact customer identifier", () => {
  assert.match(access, /selectedCustomerRequired \? \{ customerId \} : \{\}/u);
  assert.match(access, /Assigned customer/u);
  assert.match(access, /This invitation creates access only to the selected customer/u);
});

test("expired invitations can be renewed without creating a conflicting duplicate", () => {
  assert.match(access, /invitation\.status === "pending" \|\| invitation\.status === "expired"/u);
  assert.match(access, /Renew invitation/u);
});
