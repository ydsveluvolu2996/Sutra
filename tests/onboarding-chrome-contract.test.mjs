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

test("the progress strip stays trial-scoped and never runs on unknown progress", () => {
  // The strip is the trial workspace manager's guided journey, so it stays
  // keyed to that capability, the plan, and known-and-incomplete progress:
  // null (unknown) shows the normal shell.
  assert.match(shell, /const onboardingGuiding = canManageWorkspace\s*\n\s*&& session\.organization\.plan === "trial"\s*\n\s*&& onboardingProgress !== null\s*\n\s*&& !onboardingProgress\.completed/u);
  // A disabled hook fetches nothing at all.
  assert.match(hook, /if \(!enabled\) return undefined;/u);
  // Unknown stays unknown -- a failed read never overwrites known progress.
  assert.match(hook, /loaded !== null\) setProgress\(loaded\)/u);
});

test("the hard gate is about having connected, not about the plan or the goals", () => {
  // A user who can manage their scoped connections has nothing in the
  // dashboards to show before connecting, so the gate is capability-bound and
  // plan-independent rather than trial-only.
  assert.match(shell, /const onboardingUnconnected = canManageConnections\s*\n\s*&& onboardingProgress !== null\s*\n\s*&& !onboardingProgress\.steps\.connect/u);
  assert.doesNotMatch(shell, /onboardingUnconnected[^\n]*plan === "trial"/u);
  // Gating on full completion instead would lock an established workspace out
  // of its own dashboards for never having picked a goal or a name.
  assert.doesNotMatch(shell, /const onboardingUnconnected[^\n]*\.completed/u);
  // Unknown progress gates nothing: the flag requires a non-null read first.
  assert.match(shell, /onboardingProgress !== null\s*\n\s*&& !onboardingProgress\.steps\.connect/u);
});

test("the strip renders the three reference steps in order and hides when complete", () => {
  assert.match(strip, /Choose your goals[\s\S]*Share the name[\s\S]*Connect your infrastructure/u);
  assert.match(strip, /if \(progress\.completed\) return null;/u);
  // Done steps show the check; the first not-done step is current.
  assert.match(strip, /STEPS\.find\(\(step\) => !progress\.steps\[step\.key\]\)/u);
  assert.match(strip, /aria-current=\{current \? "step" : undefined\}/u);
});

test("the onboarding sidebar scopes workspace steps and offers no dashboard destination", () => {
  assert.match(shell, /onboardingUnconnected \? \(\s*\n\s*<aside className="sidebar sidebar-onboarding">/u);
  const start = shell.indexOf('className="nav-groups nav-groups-onboarding"');
  assert.ok(start > 0, "the onboarding sidebar must render its own nav group");
  const nav = shell.slice(start, shell.indexOf("</nav>", start));
  assert.match(nav, /\/welcome#goals[\s\S]*\/welcome#name[\s\S]*\/welcome#connect/u);
  assert.match(nav, /\{canManageWorkspace \? <Link[^>]*href="\/welcome#goals"[^>]*>Choose your goals<\/Link> : null\}/u);
  assert.match(nav, /\{canManageWorkspace \? <Link[^>]*href="\/welcome#name"[^>]*>Share the name<\/Link> : null\}/u);
  // The dashboards this workspace has not unlocked are not linked to.
  assert.doesNotMatch(nav, /scopedWorkspaceHref|\/dashboard/u);
  // Capability gating is documented as untouched -- presentation only.
  assert.match(shell, /narrows presentation only/u);
});

test("a workspace that has not connected anything cannot open the rest of the app", () => {
  // Anything outside the onboarding surface is sent back to the flow, and the
  // gated page never paints while that redirect is in flight.
  assert.match(shell, /const onboardingGated = onboardingUnconnected && !isOnboardingSurface\(pathname\)/u);
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
