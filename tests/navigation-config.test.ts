import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Capability } from "../lib/auth-policy.ts";
import { groupContainsActiveItem, navGroups, visibleNavigation } from "../app/components/navigation-config.ts";

const allCapabilities = new Set<Capability>([
  "workspace:read",
  "membership:manage",
  "membership:manage:customer",
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
      ["Posture findings", "Finding exceptions", "Vulnerability & exposure", "Exploitability ranking", "Network exposure", "Registry inventory", "IaC scan", "Security events", "Cloud detections", "Remediation cases", "Case routing"],
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
        "Vulnerability management",
        "Software supply chain",
        "Exposure",
        "Issues",
        "Attack paths",
        "RBAC",
        "Effective permissions",
        "AWS IAM CIEM",
        "Network",
        "Runtime",
        "Drift",
        "Compliance",
        "Admission control",
        "Policies",
        "Scan history",
        "Coverage",
        "Inventory",
        "Security findings",
      ],
    );
    assert.deepEqual(
      visibleNavigation(allCapabilities).find((group) => group.key === "administration")?.items.map((item) => item.label),
      ["Settings", "Access & invitations", "Notification destinations"],
    );
  });

  it("sections cover every Kubernetes item exactly once (nothing hidden or duplicated)", () => {
    const kubernetes = navGroups.find((group) => group.key === "kubernetes");
    assert.ok(kubernetes?.sections, "the Kubernetes group defines display sections");
    const sectionKeys = kubernetes.sections.flatMap((section) => section.keys);
    // No duplicates across sections.
    assert.equal(sectionKeys.length, new Set(sectionKeys).size);
    // Exactly the set of item keys — every item is placed, none invented.
    assert.deepEqual(
      [...sectionKeys].sort(),
      [...kubernetes.items.map((item) => item.key)].sort(),
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
