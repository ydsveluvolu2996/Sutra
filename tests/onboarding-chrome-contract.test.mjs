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

test("the onboarding sidebar narrows presentation only and keeps Home reachable", () => {
  assert.match(shell, /onboardingGuiding \? \(\s*\n\s*<aside className="sidebar sidebar-onboarding">/u);
  // Home stays a real, scoped workspace link.
  assert.match(shell, /nav-groups-onboarding[\s\S]{0,600}scopedWorkspaceHref\("\/dashboard", selectedConnectionId\)/u);
  // Capability gating is documented as untouched -- presentation only.
  assert.match(shell, /narrows presentation only/u);
});

test("the trial badge renders from the session plan and only for trial", () => {
  assert.match(shell, /organizationPlan=\{session\.organization\.plan\}/u);
  assert.match(accountMenu, /organizationPlan === "trial" \? <span className="account-plan-badge">Trial<\/span> : null/u);
});
