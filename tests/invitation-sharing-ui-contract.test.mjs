import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const [access, sharing, styles] = await Promise.all([
  readFile(resolve(root, "app/access/access-browser.tsx"), "utf8"),
  readFile(resolve(root, "app/access/invitation-sharing.ts"), "utf8"),
  readFile(resolve(root, "app/globals.css"), "utf8"),
]);

function styleRuleBody(selector) {
  const marker = `${selector} {`;
  const start = styles.indexOf(marker);
  assert.notEqual(start, -1, `missing CSS rule for ${selector}`);
  const bodyStart = start + marker.length;
  const end = styles.indexOf("}", bodyStart);
  assert.notEqual(end, -1, `unterminated CSS rule for ${selector}`);
  return styles.slice(bodyStart, end);
}

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

test("Access records use dedicated shrinkable desktop grids instead of the generic table tracks", () => {
  assert.match(access, /data-table access-data-table access-session-table/u);
  assert.match(access, /data-row access-session-row/u);
  assert.match(access, /data-table access-data-table access-invitation-table/u);
  assert.match(access, /data-row access-invitation-row/u);
  assert.match(access, /access-session-table" role="table"/u);
  assert.match(access, /access-invitation-table" role="table"/u);
  assert.match(access, /role="columnheader"/u);
  assert.match(access, /role="cell"/u);
  assert.doesNotMatch(access, /gridTemplateColumns/u, "Access row geometry belongs in responsive CSS, not inline styles");

  const sessionTracks = styleRuleBody(".access-session-row");
  const invitationTracks = styleRuleBody(".access-invitation-row");
  assert.equal([...sessionTracks.matchAll(/minmax\(/gu)].length, 5);
  assert.equal([...invitationTracks.matchAll(/minmax\(/gu)].length, 6);
  assert.match(sessionTracks, /minmax\(0,/u);
  assert.match(invitationTracks, /minmax\(0,/u);
  assert.match(styleRuleBody(".access-data-table"), /overflow-x:\s*auto;/u);
  assert.match(styles, /\.access-data-table \.data-row\s*\{\s*min-width:\s*0;/u);
  assert.match(styleRuleBody(".access-data-cell"), /min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/u);
  assert.match(styleRuleBody(".access-row-actions"), /display:\s*flex;[^}]*flex-wrap:\s*wrap;/u);
  assert.match(
    styles,
    /\.access-data-table \.primary-cell strong,\s*\.access-data-table \.primary-cell small\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/u,
    "both primary and secondary identifiers must wrap inside their own track",
  );
});

test("Access records become labeled cards when their panel narrows without dropping data or actions", () => {
  const compactStart = styles.indexOf("@container access-table (max-width: 860px)");
  const narrowStart = styles.indexOf("@container access-table (max-width: 520px)");
  assert.notEqual(compactStart, -1);
  assert.ok(narrowStart > compactStart);
  const compact = styles.slice(compactStart, narrowStart);
  const narrow = styles.slice(narrowStart);

  assert.match(styles, /\.access-table-panel\s*\{[^}]*container-name:\s*access-table;[^}]*container-type:\s*inline-size;/u);
  assert.match(compact, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/u);
  assert.match(compact, /\.access-data-cell::before\s*\{[^}]*content:\s*attr\(data-label\);/u);
  assert.match(compact, /\.access-data-table \.data-header\s*\{[^}]*clip-path:\s*inset\(50%\);/u);
  assert.doesNotMatch(compact, /\.access-data-table \.data-header\s*\{[^}]*display:\s*none;/u);
  assert.match(compact, /\.access-record-identity,\s*\.access-session-activity,\s*\.access-row-actions\s*\{\s*grid-column:\s*1 \/ -1;/u);
  assert.match(narrow, /grid-template-columns:\s*minmax\(0,\s*1fr\);/u);
  assert.match(narrow, /\.access-data-table \.access-data-cell\s*\{\s*grid-column:\s*1;/u);
  assert.match(narrow, /\.access-row-actions \.button\s*\{\s*flex:\s*1 1 140px;/u);

  for (const label of ["User / session", "Identity source", "Last verified activity", "Email", "Role / scope", "Delivery", "Expiry", "Actions"]) {
    assert.match(access, new RegExp(`data-label=["']${label.replace("/", "\\/")}["']`, "u"));
  }
  assert.match(access, /access-row-actions[^>]*>[\s\S]*?revokeSession\(managed\)/u);
  assert.match(access, /access-row-actions[^>]*>[\s\S]*?resend\(invitation\)[\s\S]*?revoke\(invitation\.id\)/u);
});
