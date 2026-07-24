import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [
  loginPage,
  loginRoute,
  contactForm,
  contactRoute,
  invitationPage,
  invitationRoute,
  configRoute,
  deploymentSecurity,
  productionCompose,
  bootstrap,
  releaseUpdate,
] = await Promise.all([
  read("../app/login/page.tsx"),
  read("../app/api/auth/login/route.ts"),
  read("../app/contact/contact-form.tsx"),
  read("../app/api/contact/route.ts"),
  read("../app/accept-invite/page.tsx"),
  read("../app/api/auth/invitations/accept/route.ts"),
  read("../app/api/turnstile/config/route.ts"),
  read("../lib/deployment-security.ts"),
  read("../deploy/ec2/compose.prod.yaml"),
  read("../deploy/ec2/bootstrap.sh"),
  read("../deploy/ec2/release-update.sh"),
]);

test("login, contact and invitation acceptance render a fixed-action Turnstile widget", () => {
  assert.match(loginPage, /TURNSTILE_ACTIONS\.login/u);
  assert.match(contactForm, /TURNSTILE_ACTIONS\.contact/u);
  assert.match(invitationPage, /TURNSTILE_ACTIONS\.acceptInvitation/u);
  for (const page of [loginPage, contactForm, invitationPage]) {
    assert.match(page, /<TurnstileWidget/u);
    assert.match(page, /turnstileToken/u);
    assert.match(page, /turnstileReady/u);
  }
});

test("all three unauthenticated mutations require server-side Siteverify before the protected operation", () => {
  assert.match(loginRoute, /verifyTurnstileToken\(/u);
  assert.match(loginRoute, /TURNSTILE_ACTIONS\.login/u);
  assert.ok(
    loginRoute.indexOf("verifyTurnstileToken(") <
      loginRoute.indexOf("loginLocalUser("),
  );

  assert.match(contactRoute, /verifyTurnstileToken\(/u);
  assert.match(contactRoute, /TURNSTILE_ACTIONS\.contact/u);
  assert.ok(
    contactRoute.indexOf("verifyTurnstileToken(") <
      contactRoute.indexOf("repository.record("),
  );

  assert.match(invitationRoute, /verifyTurnstileToken\(/u);
  assert.match(invitationRoute, /TURNSTILE_ACTIONS\.acceptInvitation/u);
  assert.ok(
    invitationRoute.indexOf("verifyTurnstileToken(") <
      invitationRoute.indexOf("acceptPasswordInvitation("),
  );
});

test("the public config endpoint returns only browser-safe configuration and is preview-allowlisted", () => {
  assert.match(configRoute, /turnstileClientConfiguration\(/u);
  assert.doesNotMatch(configRoute, /SUTRA_TURNSTILE_SECRET_KEY/u);
  assert.match(deploymentSecurity, /"\/api\/turnstile\/config"/u);
});

test("the EC2 runtime requires real keys and permanently disables the development bypass", () => {
  assert.match(productionCompose, /SUTRA_TURNSTILE_ENABLED: "true"/u);
  assert.match(productionCompose, /SUTRA_TURNSTILE_DEV_BYPASS: "false"/u);
  assert.match(productionCompose, /SUTRA_TURNSTILE_SITE_KEY: \$\{SUTRA_TURNSTILE_SITE_KEY:\?/u);
  assert.match(productionCompose, /SUTRA_TURNSTILE_SECRET_KEY: \$\{SUTRA_TURNSTILE_SECRET_KEY:\?/u);
  assert.match(bootstrap, /Replace both Cloudflare Turnstile placeholders/u);
  assert.match(bootstrap, /Turnstile site and secret keys must be distinct/u);
  assert.match(bootstrap, /Turnstile test site keys are forbidden/u);
  assert.match(bootstrap, /Turnstile test secret keys are forbidden/u);
  assert.match(
    releaseUpdate,
    /fetch_public "\/api\/turnstile\/config" "turnstile-config" 3/u,
  );
  assert.match(
    releaseUpdate,
    /\{\\"enabled\\":true,\\"siteKey\\":\\"\$turnstile_site_key\\"\}/u,
  );
});
