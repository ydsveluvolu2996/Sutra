import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Capability } from "../lib/auth-policy.ts";
import { groupContainsActiveItem, navGroups, visibleNavigation } from "../app/components/navigation-config.ts";

const allCapabilities = new Set<Capability>([
  "workspace:read",
  "customer:create",
  "connection:read",
  "connection:manage",
  "sync:run",
  "finding:manage",
  "export:read",
]);

describe("grouped workspace navigation", () => {
  it("presents the customer-facing product areas in a stable order", () => {
    assert.deepEqual(navGroups.map((group) => group.label), [
      "Overview",
      "Onboarding",
      "CMDB",
      "Security",
      "Compliance",
      "FinOps",
      "Operations",
    ]);
    assert.deepEqual(
      visibleNavigation(allCapabilities).find((group) => group.key === "security")?.items.map((item) => item.label),
      ["Posture findings", "Vulnerability & exposure", "Security events", "Remediation cases"],
    );
  });

  it("requires both customer creation and connection management for account onboarding", () => {
    const readerCapabilities = new Set<Capability>(["workspace:read", "connection:read", "export:read"]);
    const readerItems = visibleNavigation(readerCapabilities).flatMap((group) => group.items);

    assert.equal(readerItems.some((item) => item.href === "/onboard"), false);
    assert.equal(readerItems.some((item) => item.href === "/onboard#connection-lifecycle"), true);
    assert.equal(readerItems.some((item) => item.href === "/operations"), false);
  });

  it("identifies the active group without broadening route access", () => {
    const security = navGroups.find((group) => group.key === "security");
    assert.ok(security);
    assert.equal(groupContainsActiveItem(security, "vulnerabilities"), true);
    assert.equal(groupContainsActiveItem(security, "costs"), false);
  });
});
