# CloudAware-informed AWS product map for Sutra

**Captured:** 2026-08-21 (Asia/Kolkata)
**Purpose:** product discovery and implementation planning, not a parity or certification claim.
**Scope:** CloudAware's visible product shell, AWS onboarding, AWS Navigator, CMDB resource model, administration, modules, workflows, and the corresponding Sutra source gaps.

## Method and evidence boundary

The signed-in CloudAware trial was inspected read-only through the user's Chrome session. No account, credential, subscription, token, policy, tag, integration, or CloudAware setting was created or changed. Public CloudAware documentation was opened from the product's Documentation control and used to fill in flows that an empty trial cannot demonstrate.

The trial has no connected AWS account, so all observed inventory counts were zero. Navigation, forms, resource-type catalogs, documented workflows, and empty-state behavior are direct observations; populated resource details, live graphs, active findings, ticketing, alert delivery, write actions, and performance at scale remain unverified.

Evidence labels used in this pack:

- **Observed:** visible in the signed-in application.
- **Documented:** stated in CloudAware's public documentation reached from the application.
- **Sutra source:** verified in the local Sutra repository.
- **Inference:** a proposed Sutra behavior or implementation decision, not a CloudAware fact.

No CloudAware source code, private API, cookies, local storage, credentials, or proprietary visual assets were inspected. Sutra should reproduce the useful information architecture and workflows in its own design system, not clone CloudAware's branding or implementation.

## Research pack

1. [Product shell and navigation](01-product-shell-and-navigation.md)
2. [AWS onboarding and administration](02-aws-onboarding-and-administration.md)
3. [AWS service and resource catalog](03-aws-service-and-resource-catalog.md)
4. [Modules and operating model](04-modules-and-operating-model.md)
5. [Sutra capability and gap analysis](05-sutra-gap-analysis.md)
6. [Implementation roadmap](06-implementation-roadmap.md)

Raw enumerations:

- [`raw/aws-navigator-routes.json`](raw/aws-navigator-routes.json): 18 AWS categories and 114 service destinations captured from the signed-in Navigator.
- [`raw/aws-resource-coverage.txt`](raw/aws-resource-coverage.txt): 978 documented AWS CMDB object types.
- [`raw/aws-taggable-resource-types.txt`](raw/aws-taggable-resource-types.txt): 317 AWS resource types exposed by the signed-in Tag Analyzer.

Graphify outputs are generated under `graphify-out/` in this directory. They are planning aids; the Markdown evidence above remains the human-reviewed source.

## Primary reference pages

- <https://docs.cloudaware.com/quick-start/get-started/>
- <https://docs.cloudaware.com/integrations/aws/>
- <https://docs.cloudaware.com/integrations/aws/setup/>
- <https://docs.cloudaware.com/integrations/aws/service-coverage/>
- <https://docs.cloudaware.com/integrations/aws/resource-coverage/>
- <https://docs.cloudaware.com/modules/cmdb/>
- <https://docs.cloudaware.com/platform/ca-navigation/>
