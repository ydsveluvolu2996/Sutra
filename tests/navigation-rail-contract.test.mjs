import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { navGroups } from "../app/components/navigation-config.ts";

/**
 * The collapsed icon rail must stay a *mode* of the grouped navigation, never a
 * replacement for it.
 *
 * Sutra carries over a hundred destinations across eight groups where the
 * reference console it borrows from has about nine top-level entries. A rail
 * that stood on its own would therefore have to drop most of the product, and
 * the failure would be silent: the shell still renders, the operator simply
 * cannot reach a page any more. These assertions are what makes that loud.
 */

const [shell, icons] = await Promise.all([
  readFile(new URL("../app/components/app-shell.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/components/nav-icon.tsx", import.meta.url), "utf8"),
]);

const GROUP_KEYS = navGroups.map((group) => group.key);

test("every nav group has a rail glyph and a rail tone", () => {
  // A group missing from either map would render an undefined glyph rather than
  // failing, so exhaustiveness is checked against the live group list instead
  // of a hard-coded count.
  const iconBlock = icons.match(/const GROUP_ICON[^{]*\{([\s\S]*?)\n\};/u)?.[1];
  const toneBlock = icons.match(/const GROUP_TONE[^{]*\{([\s\S]*?)\n\};/u)?.[1];
  assert.ok(iconBlock, "GROUP_ICON must be declared as data");
  assert.ok(toneBlock, "GROUP_TONE must be declared as data");
  for (const key of GROUP_KEYS) {
    assert.match(iconBlock, new RegExp(`\\b${key}:`, "u"), `${key} has no rail glyph`);
    assert.match(toneBlock, new RegExp(`\\b${key}:`, "u"), `${key} has no rail tone`);
  }
});

test("the rail is driven by the same capability-filtered groups as the expanded nav", () => {
  // allVisibleNav is visibleNavigation(capabilities). Passing anything else --
  // a literal list, navGroups directly -- would let the rail show a group the
  // operator cannot open, or hide one they can.
  assert.match(shell, /<NavigationRail[\s\S]*?groups=\{allVisibleNav\}/u);
  assert.match(shell, /const allVisibleNav = visibleNavigation\(capabilitySet\)/u);
});

test("the flyout renders the same link component as the expanded nav", () => {
  // One NavItemLink, used by both. A second copy could drift, and the drift
  // least likely to be noticed is a flyout that stops marking the active page.
  assert.equal([...shell.matchAll(/function NavItemLink\(/gu)].length, 1);
  const railFlyout = shell.match(/nav-rail-flyout-items[\s\S]*?<\/div>/u)?.[0];
  assert.ok(railFlyout, "the flyout must list the group's items");
  assert.match(railFlyout, /<NavItemLink/u);
  assert.match(shell, /const renderItem[\s\S]{0,200}<NavItemLink/u);
});

test("the flyout lists a group's complete item set", () => {
  // Any slice, filter or cap here would drop destinations from the only path
  // that reaches them while the rail is collapsed.
  const railFlyout = shell.match(/nav-rail-flyout-items[\s\S]*?<\/div>/u)?.[0] ?? "";
  assert.match(railFlyout, /open\.items\.map\(/u);
  assert.doesNotMatch(railFlyout, /\.slice\(|\.filter\(|\.splice\(/u);
});

test("collapsing is reversible from the rail itself", () => {
  // Without a control on the rail, an operator who collapses the nav has no way
  // back except clearing site data.
  assert.match(shell, /onExpand=\{\(\) => setRail\(false\)\}/u);
  assert.match(shell, /className="nav-rail-expand"/u);
  assert.match(shell, /className="nav-collapse"/u);
  assert.match(shell, /Expand navigation/u);
});

test("the rail preference cannot break the shell when storage is unavailable", () => {
  // Private mode, a full quota and disabled storage all throw. Navigation must
  // still render, so every access is guarded and the failure reads as expanded.
  assert.match(shell, /function readRailPreference[\s\S]*?catch \{\s*return false;/u);
  assert.match(shell, /function writeRailPreference[\s\S]*?catch \{/u);
  // Read through the external-store hook, not seeded by an effect: the server
  // has no localStorage, so an effect-seeded value contradicts its own markup.
  assert.match(shell, /useSyncExternalStore\(subscribeRailPreference, readRailPreference, \(\) => false\)/u);
});

test("the mobile drawer still lists every group and item", () => {
  // The drawer is the small-screen path and is independent of the rail. It must
  // keep enumerating groups and items rather than deferring to the rail.
  const drawer = shell.match(/mobile-nav-panel[\s\S]*?<\/nav>/u)?.[0];
  assert.ok(drawer, "the mobile drawer must survive");
  assert.match(drawer, /visibleNav\.map\(\(group\)/u);
  assert.match(drawer, /group\.items\.map\(\(item\)/u);
});
