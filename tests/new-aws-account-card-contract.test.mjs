import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const source = await readFile(resolve(root, "app/onboard/onboard-account.tsx"), "utf8");

/**
 * The connection form is shaped after a reference onboarding card: one titled
 * card carrying Account Name, an "Authenticate using" tab pair, External ID,
 * Role ARN with template links, and Partition, closed by "Select another cloud
 * provider" and "Continue".
 *
 * These tests pin the shape so a later edit cannot quietly reintroduce the
 * scrolling multi-section form -- and, more importantly, pin the two places
 * where Sutra deliberately departs from the reference, so neither departure can
 * be "fixed" by someone matching the screenshot more closely than the trust
 * model allows.
 */
test("the form is one card with the reference fields in the reference order", () => {
  assert.match(source, /className="onboard-form aws-account-card"/u);
  assert.match(source, /<h2 className="aws-account-card-title">New AWS Account<\/h2>/u);
  const start = source.indexOf('className="onboard-form aws-account-card"');
  const card = source.slice(start, source.indexOf("</form>", start));
  const order = ["Account Name", "AWS account ID", "Authenticate using", "External ID", "Role ARN (CloudFormation stack output parameter)", "Partition", "Advanced options"];
  let cursor = 0;
  for (const field of order) {
    const at = card.indexOf(field, cursor);
    assert.ok(at > -1, `${field} must appear in the card, after ${order[order.indexOf(field) - 1] ?? "the start"}`);
    cursor = at;
  }
  // Both authentication tabs are still offered.
  assert.match(card, /IAM Role/u);
  assert.match(card, /Access & Secret Keys/u);
});

test("the card closes with the reference actions and no other primary control", () => {
  assert.match(source, /className="aws-account-card-actions"[\s\S]{0,300}Select another cloud provider/u);
  assert.match(source, /Select another cloud provider<\/a>[\s\S]{0,900}: "Continue"\}<\/button>/u);
  // "Select another cloud provider" goes back to the hub, not to a dead anchor.
  assert.match(source, /href="\/welcome#connect">Select another cloud provider/u);
});

test("the External ID is server-minted, never an input and never reshuffled", () => {
  // The reference makes this an editable field with a shuffle button. Sutra
  // binds the value to the customer and account server-side and discloses it
  // once, so the field states that instead of accepting a value.
  assert.match(source, /<span>External ID<\/span>/u);
  assert.match(source, /copy-field-pending">Generated when you continue/u);
  const start = source.indexOf("<span>External ID</span>");
  const field = source.slice(start, source.indexOf("</label>", start));
  // No input to type into and no control to re-roll the value with.
  assert.doesNotMatch(field, /<input|<button/u);
  assert.doesNotMatch(source, /regenerateExternalId|setExternalId\(/u);
  // The one-time disclosure and the refusal to rotate both survive.
  assert.match(source, /never reshuffled on a connection that already has a registered role/u);
  assert.match(source, /ExternalId rotation is intentionally unavailable/u);
});

test("the template links appear under Role ARN and only when they are real", () => {
  assert.match(source, /Use <a href=\{quickLaunchUrl\}[^>]*>this pre-generated template<\/a> for quicker stack creation OR download <a href=\{AWS_CUSTOMER_ROLE_TEMPLATE_PATH\} download>this template<\/a> to create the stack manually/u);
  // No quick-create URL (non-commercial partition, missing public template, or
  // a closed handoff) degrades to the manual download rather than a dead link.
  assert.match(source, /quickLaunchUrl === null\s*\n?\s*\? <>Download <a href=\{AWS_CUSTOMER_ROLE_TEMPLATE_PATH\} download>this template<\/a>/u);
  // The customer-managed path deploys no Sutra stack, so it offers no stack link.
  assert.match(source, /createdRoleMode === "sutra_template" \? \(\s*\n\s*<p className="onboard-template-links">/u);
});

test("the depth the reference has no room for is collapsed, not deleted", () => {
  const start = source.indexOf('<details className="onboard-advanced">');
  assert.ok(start > 0, "advanced options must be a real disclosure, not a separate page");
  const advanced = source.slice(start, source.indexOf("</details>", start));
  // The grant-path choice, the region scope and the connector scope all remain
  // reachable; only their prominence changed.
  assert.match(advanced, /How will the customer grant access\?/u);
  assert.match(advanced, /legend="Connector scope"/u);
  assert.match(advanced, /Region coverage/u);
});

test("a finished connection stops being a wizard", () => {
  // Setup completion is derived from the trust actually being live, not from
  // clicking through the steps.
  assert.match(source, /const connectionSetupComplete = liveConnection !== null\s*\n\s*&& \(liveConnection\.status === "active" \|\| liveConnection\.status === "disabled"\)/u);
  // The step rail is wayfinding for work in progress, so it goes away.
  assert.match(source, /connectionSetupComplete \? null : <WizardStepRail/u);
  // What replaces it is a plain statement of fact plus the next real action --
  // connecting another account -- not a stalled "Step 2 of 4".
  assert.match(source, /className="onboard-connected" role="status"/u);
  assert.match(source, /is connected to AWS<\/h2>/u);
  assert.match(source, /<ConnectProviderGrid heading="Connect another cloud account"/u);
});

test("the deployment and lifecycle surface is collapsed, never deleted", () => {
  // Both connection kinds route their dense surface through one wrapper that
  // collapses once setup is done, so nothing is removed or moved off the page.
  assert.equal([...source.matchAll(/<ConnectionWorkArea collapsed=\{connectionSetupComplete\}>/gu)].length, 2);
  assert.equal([...source.matchAll(/<\/ConnectionWorkArea>/gu)].length, 2);
  assert.match(source, /if \(!collapsed\) return <>\{children\}<\/>/u);
  assert.match(source, /Connection details and trust lifecycle/u);
  // The things an operator still needs after setup remain reachable inside it.
  for (const kept of [
    "Exact collector principal",
    "Control or remove collector access",
    "Offboard AWS trust",
    "ExternalId handoff is closed",
  ]) {
    assert.ok(source.includes(kept), `${kept} must survive the collapse`);
  }
});
