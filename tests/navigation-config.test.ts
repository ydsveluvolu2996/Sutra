import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Capability } from "../lib/auth-policy.ts";
import { groupContainsActiveItem, navGroups, visibleNavigation } from "../app/components/navigation-config.ts";

const allCapabilities = new Set<Capability>([
  "workspace:read",
  "membership:manage",
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
      "Kubernetes",
      "Security",
      "Compliance",
      "FinOps",
      "Operations",
      "Administration",
    ]);
    assert.deepEqual(
      visibleNavigation(allCapabilities).find((group) => group.key === "security")?.items.map((item) => item.label),
      ["Posture findings", "Vulnerability & exposure", "Security events", "Remediation cases"],
    );
    assert.deepEqual(
      visibleNavigation(allCapabilities).find((group) => group.key === "kubernetes")?.items.map((item) => item.label),
      [
        "Cluster overview",
        "Fleet health",
        "Posture trends",
        "Onboard cluster",
        "Clusters",
        "Namespaces",
        "Workloads",
        "Images & vulnerabilities",
        "Vulnerability updates",
        "Software supply chain",
        "Exposure",
        "Issues",
        "Attack paths",
        "RBAC",
        "Effective permissions",
        "Network",
        "Runtime",
        "Drift",
        "Compliance",
        "Admission control",
        "Policies",
        "Scan history",
        "Coverage",
      ],
    );
    assert.deepEqual(
      visibleNavigation(allCapabilities).find((group) => group.key === "administration")?.items.map((item) => item.label),
      ["Settings", "Access & invitations", "Notification destinations"],
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
