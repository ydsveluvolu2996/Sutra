import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { navGroups, visibleNavigation } from "../app/components/navigation-config.ts";
import {
  KUBERNETES_SECTION_KEYS,
  KUBERNETES_SECTIONS,
  kubernetesSection,
} from "../app/kubernetes/kubernetes-sections.ts";
import type { Capability } from "../lib/auth-policy.ts";

describe("enterprise Kubernetes submenu contract", () => {
  it("defines every customer-requested workspace route once", () => {
    assert.deepEqual(KUBERNETES_SECTION_KEYS, [
      "clusters",
      "namespaces",
      "workloads",
      "images",
      "exposure",
      "rbac",
      "network",
      "runtime",
      "compliance",
      "policies",
      "scan-history",
      "coverage",
    ]);
    assert.equal(new Set(KUBERNETES_SECTIONS.map((section) => section.key)).size, KUBERNETES_SECTIONS.length);
    assert.equal(kubernetesSection("runtime")?.title, "Runtime security");
    assert.equal(kubernetesSection("not-a-section"), null);
  });

  it("exposes every section through capability-gated grouped navigation", () => {
    const group = navGroups.find((candidate) => candidate.key === "kubernetes");
    assert.ok(group);
    for (const section of KUBERNETES_SECTIONS) {
      assert.equal(
        group.items.some((item) => item.href === `/kubernetes/${section.key}`),
        true,
        `missing ${section.key}`,
      );
    }
    const reader = new Set<Capability>(["workspace:read", "connection:read"]);
    const visible = visibleNavigation(reader).find((candidate) => candidate.key === "kubernetes");
    assert.ok(visible);
    assert.equal(visible.items.some((item) => item.href === "/kubernetes/onboard"), false);
    assert.equal(visible.items.some((item) => item.href === "/kubernetes/workloads"), true);
  });
});
