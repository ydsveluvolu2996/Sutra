import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

const [shell, strip, hook, accountMenu] = await Promise.all([
  readFile(resolve(root, "app/components/app-shell.tsx"), "utf8"),
  readFile(resolve(root, "app/components/onboarding-strip.tsx"), "utf8"),
  readFile(resolve(root, "app/components/use-onboarding.ts"), "utf8"),
  readFile(resolve(root, "app/components/account-menu.tsx"), "utf8"),
]);

test("the guided chrome applies only to trial workspaces and never to unknown progress", () => {
  // The hook is enabled by the org plan, not by a guess.
  assert.match(shell, /useOnboarding\(session\.organization\.plan === "trial"\)/u);
  // Guiding requires known-and-incomplete progress: null (unknown) shows the
  // normal shell, and a completed flow removes the chrome entirely.
  assert.match(shell, /onboarding\.progress !== null\s*\n\s*&& !onboarding\.progress\.completed/u);
  // A disabled hook fetches nothing at all.
  assert.match(hook, /if \(!enabled\) return undefined;/u);
  // Unknown stays unknown -- a failed read never overwrites known progress.
  assert.match(hook, /loaded !== null\) setProgress\(loaded\)/u);
});

test("the strip renders the three reference steps in order and hides when complete", () => {
  assert.match(strip, /Choose your goals[\s\S]*Share the name[\s\S]*Connect your infrastructure/u);
  assert.match(strip, /if \(progress\.completed\) return null;/u);
  // Done steps show the check; the first not-done step is current.
  assert.match(strip, /STEPS\.find\(\(step\) => !progress\.steps\[step\.key\]\)/u);
  assert.match(strip, /aria-current=\{current \? "step" : undefined\}/u);
});

test("the onboarding sidebar offers the three steps and no dashboard destination", () => {
  assert.match(shell, /onboardingGuiding \? \(\s*\n\s*<aside className="sidebar sidebar-onboarding">/u);
  const start = shell.indexOf('className="nav-groups nav-groups-onboarding"');
  assert.ok(start > 0, "the onboarding sidebar must render its own nav group");
  const nav = shell.slice(start, shell.indexOf("</nav>", start));
  assert.match(nav, /\/welcome#goals[\s\S]*\/welcome#name[\s\S]*\/welcome#connect/u);
  // The dashboards this workspace has not unlocked are not linked to.
  assert.doesNotMatch(nav, /scopedWorkspaceHref|\/dashboard/u);
  // Capability gating is documented as untouched -- presentation only.
  assert.match(shell, /narrows presentation only/u);
});

test("an unfinished trial workspace cannot open the rest of the app", () => {
  // Anything outside the onboarding surface is sent back to the flow, and the
  // gated page never paints while that redirect is in flight.
  assert.match(shell, /const onboardingGated = onboardingGuiding && !isOnboardingSurface\(pathname\)/u);
  assert.match(shell, /if \(!onboardingGated\) return;\s*\n\s*window\.location\.replace\("\/welcome"\)/u);
  assert.match(shell, /onboardingGated\s*\n?\s*\? <div className="loading-state"/u);
  // The gate is presentation, not authorization, and says so.
  assert.match(shell, /still server-authorized by its own capability check/u);
  // A customer inside the flow can still reach their access, settings and help.
  const start = shell.indexOf("ONBOARDING_SURFACE_PREFIXES");
  const allowed = shell.slice(start, shell.indexOf("] as const)", start));
  for (const prefix of ["/welcome", "/onboard", "/access", "/settings", "/contact"]) {
    assert.match(allowed, new RegExp(`"${prefix}"`, "u"));
  }
  assert.doesNotMatch(allowed, /"\/dashboard"|"\/cmdb"|"\/costs"/u);
});

test("the trial badge renders from the session plan and only for trial", () => {
  assert.match(shell, /organizationPlan=\{session\.organization\.plan\}/u);
  assert.match(accountMenu, /organizationPlan === "trial" \? <span className="account-plan-badge">Trial<\/span> : null/u);
});
