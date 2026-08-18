import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const [login, styles, federation] = await Promise.all([
  readFile(resolve(root, "app/login/page.tsx"), "utf8"),
  readFile(resolve(root, "app/globals.css"), "utf8"),
  readFile(resolve(root, "app/api/auth/federation/route.ts"), "utf8"),
]);

test("sign-in uses the Sutra split composition and exactly three original value statements", () => {
  for (const statement of [
    "Discover your cloud estate automatically.",
    "Manage and explore AWS assets from one CMDB.",
    "Onboard clients with least-privilege access.",
  ]) assert.match(login, new RegExp(statement.replaceAll(".", "\\."), "u"));
  assert.match(login, /Full-viewport|auth-page/u);
  assert.match(styles, /\.auth-page\s*\{[^}]*grid-template-columns/u);
  assert.match(styles, /@media \(max-width: 860px\)[\s\S]*\.auth-page/u);
  assert.match(styles, /:focus-visible/u);
  assert.match(login, /See your cloud estate as one connected system\./u);
  assert.match(login, /className="auth-brand-lede"/u);
});

test("Google is first, has its mark, and receives the exact Continue label", () => {
  assert.match(login, /provider\.id !== "google"/u);
  assert.match(login, /className="auth-provider-mark"/u);
  assert.match(login, /Continue with \{provider\.label\}/u);
  assert.match(login, /auth-provider-primary/u);
  assert.match(login, /Other enterprise options/u);
  assert.match(federation, /if \(id === "google"\) return "Google"/u);
  assert.match(federation, /if \(left\.id === "google"\) return -1/u);
});

test("hosted identity never renders the local password form for visual parity", () => {
  const hostedStart = login.indexOf('mode === "hosted"');
  const bootstrapStart = login.indexOf('mode === "bootstrap"', hostedStart);
  const hosted = login.slice(hostedStart, bootstrapStart);
  assert.match(hosted, /<h2>Sign in to Sutra<\/h2>/u);
  assert.match(hosted, /federation\?\.providers\.map/u);
  assert.doesNotMatch(hosted, /autoComplete="current-password"/u);
  assert.match(login.slice(bootstrapStart), /autoComplete="current-password"/u);
});

test("mobile keeps branding and Google-capable provider controls without horizontal scrolling", () => {
  assert.match(styles, /@media \(max-width: 860px\)[\s\S]*\.auth-brand-panel/u);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.auth-form-card/u);
  assert.match(styles, /\.auth-provider-mark/u);
  assert.match(styles, /\.auth-provider-action:focus-visible/u);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*\.auth-assurances\s*\{[^}]*display:\s*none/u);
  assert.match(styles, /\.auth-page\s*\{[^}]*overflow-x:\s*clip/u);
});
