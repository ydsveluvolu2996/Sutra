// In-repo help-center content. Every entry is authored copy shipped with the
// build — the docs browser never fetches anything external. Each `href` points
// at a real, existing in-app route (validated by tests/docs-page-contract) so
// the documentation can never link a customer to a screen that does not exist.

export interface DocLink {
  readonly label: string;
  /** Internal app route. Must resolve to a real page. */
  readonly href: string;
  readonly description: string;
}

export interface DocSection {
  /** Anchor id used for in-page navigation (#id). */
  readonly id: string;
  readonly eyebrow: string;
  readonly title: string;
  /** One or more short intro paragraphs. */
  readonly intro: readonly string[];
  /** Optional read-only / trust reassurance rendered as a trust strip. */
  readonly trust?: string;
  /** Feature entries, each mapped to a live route. */
  readonly links: readonly DocLink[];
  /** Optional plain-text notes (bulleted) that are not navigable. */
  readonly notes?: readonly string[];
}

export const docsIntro = {
  eyebrow: "Help center",
  title: "Sutra documentation",
  lede:
    "Everything you need to connect an account, understand what Sutra collects, " +
    "and get value from each workspace. Sutra is a read-only-by-default CNAPP for " +
    "managed service providers: it observes your AWS and Kubernetes estate and never " +
    "changes it, apart from one opt-in scan that can only create snapshots it tags " +
    "itself and can never delete anything.",
} as const;

export const docsSections: readonly DocSection[] = [
  {
    id: "getting-started",
    eyebrow: "Start here",
    title: "Getting started & onboarding",
    intro: [
      "Onboarding takes three steps: create a customer workspace, connect that " +
        "customer's AWS account through a read-only IAM trust role, and invite the " +
        "teammates who need access. Sutra never asks for AWS keys — access is granted " +
        "by a CloudFormation-deployed role that you own and can revoke at any time.",
      "Each connection gets a unique platform-generated ExternalId and a specific " +
        "vendor collector principal, so only your Sutra workspace can assume the role, " +
        "and only from the expected identity.",
    ],
    trust:
      "Read-only by default. Onboarding provisions a customer-owned IAM role scoped to " +
      "read/describe/list permissions. Sutra assumes it to collect metadata and never " +
      "holds long-lived credentials. Agentless disk scanning is a separate stack " +
      "parameter, off unless you enable it.",
    links: [
      {
        label: "Onboard a client",
        href: "/onboard/client",
        description:
          "Guided flow to stand up a new customer workspace and its first read-only connection.",
      },
      {
        label: "Add an AWS account",
        href: "/onboard",
        description:
          "Deploy the customer-owned IAM trust role (CloudFormation quick-create) and validate the connection.",
      },
      {
        label: "Customers & accounts",
        href: "/customers",
        description: "See every customer workspace, its connected accounts, and collection status.",
      },
      {
        label: "Connection health",
        href: "/onboard#connection-lifecycle",
        description: "Confirm the trust role is reachable, and revoke or clean up a connection when offboarding.",
      },
      {
        label: "Invite your team",
        href: "/access",
        description:
          "Send single-use, MFA-enforced invitations and assign customer-scoped roles.",
      },
    ],
    notes: [
      "MFA is required for every operator before any workspace data loads.",
      "Roles are customer-scoped: a member only ever sees the customers they are granted.",
    ],
  },
  {
    id: "core-concepts",
    eyebrow: "Understand the model",
    title: "Core concepts",
    intro: [
      "The CMDB is the normalized, timestamped inventory of everything Sutra has " +
        "collected — resources, tags, relationships, and how they change over time. " +
        "Findings are evidence-backed configuration checks evaluated against that " +
        "inventory; each one records the resource, the rule, and the observation behind it.",
      "Evidence honesty is a core principle: every screen labels the active evidence " +
        "source, missing telemetry is always reported as not configured, partial, or " +
        "stale, and simulated fixture results are never presented as real AWS observations.",
    ],
    links: [
      {
        label: "Executive dashboard",
        href: "/dashboard",
        description: "The cross-workspace summary of posture, coverage, and open findings.",
      },
      {
        label: "Resource inventory (CMDB)",
        href: "/cmdb",
        description: "Browse and query the normalized inventory with saved queries and annotations.",
      },
      {
        label: "Posture findings",
        href: "/findings",
        description: "Evidence-backed configuration checks with the exact observation behind each result.",
      },
    ],
  },
  {
    id: "trust-read-only",
    eyebrow: "Trust",
    title: "What Sutra can and cannot do in your account",
    intro: [
      "Sutra is built to observe, not to act. Collection uses read/describe/list AWS " +
        "APIs and cluster-bound read paths only, and access is always through a role " +
        "you own and can revoke.",
      "There is exactly one exception, and it is off unless you turn it on. Agentless " +
        "disk scanning needs an EBS snapshot to read a volume without installing an " +
        "agent, so enabling it grants CreateSnapshot and CreateTags — nothing else. " +
        "Snapshots must carry the sutra-agentless tag at creation, can only be shared " +
        "with Sutra's own scan account, and cannot touch your existing snapshots or " +
        "backups.",
      "Sutra can never delete anything. The role carries an explicit IAM deny on " +
        "DeleteSnapshot, DeleteVolume, DetachVolume, ModifyVolume, TerminateInstances, " +
        "StopInstances, RebootInstances, DeregisterImage and DeleteTags — a deny that " +
        "cannot be overridden by any later grant. Because Sutra cannot reap the " +
        "snapshots it creates, the same template installs a Data Lifecycle Manager " +
        "policy in your account to do it. Sutra reports what is still outstanding so " +
        "the cost is visible; you own the cleanup.",
      "Where Sutra helps you remediate — for example patch management — it generates a " +
        "runbook for you to run yourself in your own change process. It never executes " +
        "the command for you.",
    ],
    trust:
      "You stay in control: the trust role is read-only unless you opt into agentless " +
      "scanning, uses a unique ExternalId, and can be revoked instantly. Even with " +
      "agentless enabled, no destructive action is reachable. Lambda function listing " +
      "is intentionally excluded because it can expose environment-variable values.",
    links: [
      {
        label: "Add an AWS account",
        href: "/onboard",
        description: "Review the exact permissions in the IAM trust role before you deploy it.",
      },
      {
        label: "Patch management",
        href: "/patch",
        description: "The clearest example of report-and-generate-only: Sutra reports and generates, never runs.",
      },
    ],
  },
  {
    id: "cmdb",
    eyebrow: "Inventory",
    title: "CMDB, dependencies & custom assets",
    intro: [
      "The CMDB gives you a normalized, timestamped inventory across accounts with tags, " +
        "relationships, collection coverage, and data freshness. Change history records " +
        "how each resource has evolved, and the dependency view maps the relationships " +
        "between resources.",
      "Custom assets let you import and track things Sutra does not collect natively, so " +
        "your CMDB reflects your whole estate, not just what the collectors see.",
    ],
    links: [
      {
        label: "Resource inventory",
        href: "/cmdb",
        description: "Query normalized resources, save queries, and annotate records.",
      },
      {
        label: "Change history",
        href: "/changes",
        description: "Timestamped record of how resources have changed between snapshots.",
      },
      {
        label: "Dependencies",
        href: "/cmdb/dependencies",
        description: "Explore resource-to-resource relationships across the inventory.",
      },
      {
        label: "Custom assets",
        href: "/cmdb/assets",
        description: "Import and manage assets outside the native collectors so your CMDB is complete.",
      },
    ],
  },
  {
    id: "finops",
    eyebrow: "Cost",
    title: "FinOps & cost management",
    intro: [
      "The cost workspace turns tenant-scoped Cost Explorer, CUR 2.0 and FOCUS 1.0 " +
        "evidence into actionable savings. It surfaces rightsizing candidates, idle and " +
        "waste spend, cost trends and forecasts, budget and anomaly signals, tag " +
        "governance, realized savings, allocation, and unit economics.",
      "Customer showback breaks spend down per customer for MSP billing conversations, " +
        "and the report builder assembles executive reports you can export to CSV or PDF " +
        "and deliver on a schedule.",
    ],
    links: [
      {
        label: "AWS costs",
        href: "/costs",
        description:
          "Rightsizing, idle/waste spend, trends & forecast, budgets, anomalies, tag governance, realized savings, allocation, and unit economics.",
      },
      {
        label: "Customer showback",
        href: "/costs/showback",
        description: "Per-customer cost breakdown for MSP showback and billing.",
      },
      {
        label: "Executive reports",
        href: "/reports",
        description: "Prebuilt executive summaries of posture and cost.",
      },
      {
        label: "Report builder",
        href: "/reports/builder",
        description: "Assemble custom reports, export to CSV/PDF, and schedule delivery.",
      },
    ],
  },
  {
    id: "vulnerabilities",
    eyebrow: "Exposure",
    title: "Vulnerability management",
    intro: [
      "Vulnerability & exposure ranks CVEs against your inventory and prioritizes them " +
        "by real-world exploitability, so your team works the vulnerabilities that " +
        "actually matter first. Registry inventory tracks container images, network " +
        "exposure highlights internet-reachable resources, and IaC scanning catches " +
        "misconfigurations before they ship.",
    ],
    links: [
      {
        label: "Vulnerability & exposure",
        href: "/vulnerabilities",
        description: "CVEs mapped to affected resources with severity and exposure context.",
      },
      {
        label: "Exploitability ranking",
        href: "/vulnerabilities/exploitability",
        description: "Prioritize by exploitability signals instead of raw CVSS alone.",
      },
      {
        label: "Registry inventory",
        href: "/registry/inventory",
        description: "Container images and their vulnerability posture.",
      },
      {
        label: "Network exposure",
        href: "/network-exposure",
        description: "Which resources are reachable from the internet and how.",
      },
      {
        label: "IaC scan",
        href: "/iac-scan",
        description: "Scan infrastructure-as-code for misconfigurations before deployment.",
      },
    ],
  },
  {
    id: "detections-cases",
    eyebrow: "Detect & respond",
    title: "Security events, detections & cases",
    intro: [
      "Sutra normalizes bounded CloudTrail LookupEvents into security events and cloud " +
        "detections, then lets you turn findings into remediation cases with routing to " +
        "your ticketing system. Findings you accept as risk are tracked as " +
        "approval-controlled exceptions rather than silently hidden.",
    ],
    links: [
      {
        label: "Security events",
        href: "/security-events",
        description: "Normalized CloudTrail activity for review.",
      },
      {
        label: "Cloud detections",
        href: "/cloud-detections",
        description: "Detections derived from collected cloud activity.",
      },
      {
        label: "Remediation cases",
        href: "/cases",
        description: "Track finding-backed remediation work with signed Jira/ServiceNow sync.",
      },
      {
        label: "Case routing",
        href: "/cases/routing",
        description: "Preview tenant-scoped owner, team, and destination routing without changing a case.",
      },
      {
        label: "Finding exceptions",
        href: "/findings/exceptions",
        description: "Approval-controlled, time-bound acceptance of risk — never a silent mute.",
      },
    ],
  },
  {
    id: "compliance",
    eyebrow: "Compliance",
    title: "Compliance",
    intro: [
      "Compliance posture scores your estate against a framework and shows the passing, " +
        "failing, and not-applicable controls with the evidence behind each result. " +
        "Frameworks map your posture to standards, and the control library is the catalog " +
        "of checks Sutra evaluates.",
    ],
    trust:
      "Evidence-backed: every control result is traceable to the collected observation, " +
      "and licensed-content frameworks are clearly gated rather than implied.",
    links: [
      {
        label: "Compliance posture",
        href: "/compliance",
        description: "Framework score with per-control pass/fail/exception evidence and CSV/JSON export.",
      },
      {
        label: "Compliance frameworks",
        href: "/compliance-frameworks",
        description: "The frameworks Sutra assesses and maps posture against.",
      },
      {
        label: "Control library",
        href: "/controls",
        description: "The catalog of controls and what each one checks.",
      },
    ],
  },
  {
    id: "kubernetes",
    eyebrow: "Kubernetes",
    title: "Kubernetes security",
    intro: [
      "The Kubernetes workspace (EKS-first private beta) covers cluster inventory and " +
        "fleet health, image and workload vulnerabilities, software supply chain, posture " +
        "trends and compliance, admission control, RBAC and effective permissions, AWS " +
        "IAM CIEM, network and runtime signals, and attack paths.",
      "Real evidence is ingested through cluster-bound paths from Trivy Operator, Falco, " +
        "Kyverno and Cilium/Hubble; anything not configured is reported as such rather " +
        "than assumed clean.",
    ],
    links: [
      {
        label: "Cluster overview",
        href: "/kubernetes",
        description: "Start here for cluster inventory and posture at a glance.",
      },
      {
        label: "Onboard a cluster",
        href: "/kubernetes/onboard",
        description: "Connect an EKS cluster through the cluster-bound ingestion path.",
      },
      {
        label: "Fleet health",
        href: "/kubernetes/fleet",
        description: "Health and coverage across all connected clusters.",
      },
      {
        label: "Images & vulnerabilities",
        href: "/kubernetes/images",
        description: "Image inventory and CVE posture from Trivy Operator.",
      },
      {
        label: "Vulnerability management",
        href: "/kubernetes/vulnerability-management",
        description: "Prioritize and track cluster vulnerabilities.",
      },
      {
        label: "Software supply chain",
        href: "/kubernetes/supply-chain",
        description: "SBOM and supply-chain trust for cluster images.",
      },
      {
        label: "Attack paths",
        href: "/kubernetes/attack-paths",
        description: "Chained exposure across identity, network, and workloads.",
      },
      {
        label: "AWS IAM CIEM",
        href: "/kubernetes/iam",
        description: "Effective cloud entitlements tied to cluster identities.",
      },
      {
        label: "Compliance",
        href: "/kubernetes/compliance",
        description: "Cluster posture against Kubernetes benchmarks.",
      },
      {
        label: "Admission control",
        href: "/kubernetes/admission",
        description: "Kyverno-backed admission policy governance.",
      },
    ],
  },
  {
    id: "alerts",
    eyebrow: "Notify",
    title: "Alerts & notifications",
    intro: [
      "Alerts watch your posture and cost signals and notify you when something crosses " +
        "a threshold. Notification destinations let you decide where those alerts land.",
    ],
    links: [
      {
        label: "Alerts",
        href: "/alerts",
        description: "Define and review alerting on posture and cost metrics.",
      },
      {
        label: "Notification destinations",
        href: "/settings/notifications",
        description: "Configure where alerts and reports are delivered.",
      },
    ],
  },
  {
    id: "patch",
    eyebrow: "Patch",
    title: "Patch management (read-only, generate-only)",
    intro: [
      "Patch management reports patch-compliance posture for SSM-managed EC2 instances " +
        "from the read-only Systems Manager patch state Sutra collects. For any " +
        "non-compliant instance it generates a remediation runbook — the exact command " +
        "for you to run in your own maintenance window.",
    ],
    trust:
      "Read-only & generate-only. Sutra uses three read-only SSM Describe APIs and never " +
      "runs a command in your environment. Instances with no collected patch state are " +
      "shown as not assessed — never assumed compliant.",
    links: [
      {
        label: "Patch management",
        href: "/patch",
        description: "Patch-compliance posture and generated remediation runbooks you run yourself.",
      },
    ],
  },
  {
    id: "operations",
    eyebrow: "Operate",
    title: "Operations & roadmap",
    intro: [
      "The operations workspace shows collection runs so you can see when data was last " +
        "gathered and whether a run needs attention. The product roadmap shares what is " +
        "shipping next.",
    ],
    links: [
      {
        label: "Collection runs",
        href: "/operations",
        description: "History and status of collection jobs across your connections.",
      },
      {
        label: "Product roadmap",
        href: "/roadmap",
        description: "What Sutra is building next.",
      },
    ],
  },
  {
    id: "public-api",
    eyebrow: "Integrate",
    title: "Public API & SDKs",
    intro: [
      "The versioned, scoped public API (base URL /api/public/v1) exposes reads for " +
        "resources, findings, cases, snapshots, compliance and vulnerabilities, plus a " +
        "scoped write to update case status. It uses cursor pagination, idempotency keys " +
        "on writes, per-token quotas, and structured errors.",
      "Create a service-account token under Settings, then authenticate with " +
        "Authorization: Bearer sutra_pat_… — the secret is shown once and stored only as " +
        "a hash. Tokens are bound to one organization and customer, and revocation takes " +
        "effect immediately. Official Python and TypeScript SDKs are available under the " +
        "clients directory of the repository.",
    ],
    trust:
      "Tenant-scoped: every API query is bound to the token's organization and customer, " +
      "so the API can never expose another tenant's rows. The OpenAPI spec is served at " +
      "/api/public/v1/openapi.json.",
    links: [
      {
        label: "Settings — Public API tokens",
        href: "/settings",
        description: "Mint, scope, and revoke service-account tokens (requires connection:manage).",
      },
    ],
    notes: [
      "Reads return { data, page.next }; pass ?cursor= to continue, ?limit= 1–100.",
      "Writes require an Idempotency-Key header; replaying a key with a different body is a 409.",
      "Quota is 120 requests/minute per token; over-quota returns 429 with retry-after: 60.",
    ],
  },
] as const;
