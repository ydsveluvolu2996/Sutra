# Graph Report - cloudaware-aws-product-map  (2026-08-21)

## Corpus Check
- Corpus is ~10,761 words - fits in a single context window. You may not need a graph.

## Summary
- 85 nodes · 139 edges · 6 communities
- Extraction: 83% EXTRACTED · 17% INFERRED · 0% AMBIGUOUS · INFERRED: 23 edges (avg confidence: 0.92)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Implementation Roadmap and Gaps
- AWS Navigator Categories
- Cloud Operations Modules
- Product Shell and Search
- AWS Onboarding and Administration
- AWS Catalog Coverage

## God Nodes (most connected - your core abstractions)
1. `AWS Navigator Taxonomy` - 20 edges
2. `CloudAware AWS Navigator Routes` - 19 edges
3. `Modules and Operating Model` - 12 edges
4. `CloudAware-class AWS Implementation Roadmap` - 12 edges
5. `AWS Onboarding and Administration` - 11 edges
6. `Sutra Capability and Gap Analysis` - 11 edges
7. `CloudAware-informed AWS Product Map for Sutra` - 9 edges
8. `Product Shell and Navigation` - 9 edges
9. `CMDB Common Foundation` - 7 edges
10. `AWS Service and Resource Catalog` - 6 edges

## Surprising Connections (you probably didn't know these)
- `Sutra Evidence and Tenant-boundary Advantages` --semantically_similar_to--> `Truthful Collection-state Semantics`  [INFERRED] [semantically similar]
  05-sutra-gap-analysis.md → 01-product-shell-and-navigation.md
- `CloudAware-informed AWS Product Map for Sutra` --references--> `AWS Taggable Resource Types`  [EXTRACTED]
  README.md → raw/aws-taggable-resource-types.txt
- `AWS Navigator Taxonomy` --conceptually_related_to--> `CMDB Navigator`  [INFERRED]
  03-aws-service-and-resource-catalog.md → 01-product-shell-and-navigation.md
- `Topology and Change-intelligence Gap` --conceptually_related_to--> `Rich AWS CMDB Object Model`  [INFERRED]
  05-sutra-gap-analysis.md → 03-aws-service-and-resource-catalog.md
- `CloudAware-informed AWS Product Map for Sutra` --references--> `Product Shell and Navigation`  [EXTRACTED]
  README.md → 01-product-shell-and-navigation.md

## Hyperedges (group relationships)
- **AWS Catalog Truth and Coverage** — docs_research_cloudaware_aws_product_map_01_product_shell_and_navigation_truthful_collection_state_semantics, docs_research_cloudaware_aws_product_map_03_aws_service_and_resource_catalog_canonical_aws_object_catalog_contract, docs_research_cloudaware_aws_product_map_03_aws_service_and_resource_catalog_truthful_catalog_coverage, docs_research_cloudaware_aws_product_map_raw_aws_resource_coverage_aws_cmdb_object_type_inventory, docs_research_cloudaware_aws_product_map_05_sutra_gap_analysis_sutra_evidence_and_tenant_boundary_advantages, docs_research_cloudaware_aws_product_map_06_implementation_roadmap_epic_0_catalog_contracts_and_ux_foundation [INFERRED 0.85]
- **Organization-scale Secure Onboarding** — docs_research_cloudaware_aws_product_map_02_aws_onboarding_and_administration_recommended_iam_role_onboarding, docs_research_cloudaware_aws_product_map_02_aws_onboarding_and_administration_aws_organizations_onboarding, docs_research_cloudaware_aws_product_map_02_aws_onboarding_and_administration_production_grade_onboarding_acceptance, docs_research_cloudaware_aws_product_map_05_sutra_gap_analysis_organizations_onboarding_gap, docs_research_cloudaware_aws_product_map_06_implementation_roadmap_epic_1_organization_scale_onboarding, docs_research_cloudaware_aws_product_map_06_implementation_roadmap_evidence_driven_release_gates [INFERRED 0.85]
- **CMDB-centered Operating Plane** — docs_research_cloudaware_aws_product_map_01_product_shell_and_navigation_cmdb_navigator, docs_research_cloudaware_aws_product_map_03_aws_service_and_resource_catalog_rich_aws_cmdb_object_model, docs_research_cloudaware_aws_product_map_04_modules_and_operating_model_cmdb_common_foundation, docs_research_cloudaware_aws_product_map_04_modules_and_operating_model_cmdb_workflows, docs_research_cloudaware_aws_product_map_06_implementation_roadmap_sutra_aws_product_architecture, docs_research_cloudaware_aws_product_map_06_implementation_roadmap_epic_3_relationship_and_change_intelligence [INFERRED 0.85]

## Communities (6 total, 0 thin omitted)

### Community 0 - "Implementation Roadmap and Gaps"
Cohesion: 0.13
Nodes (20): AWS Catalog Scale, Integration Ecosystem, AWS Inventory Breadth Gap, Connector and Credential Administration Gap, Governed Remediation Gap, Organizations Onboarding Gap, Sutra Capability and Gap Analysis, Sutra Evidence and Tenant-boundary Advantages (+12 more)

### Community 1 - "AWS Navigator Categories"
Cohesion: 0.19
Nodes (20): AWS Navigator Taxonomy, AWS AI and Machine Learning Category, AWS Analytics Category, AWS Application Integration Category, AWS Blockchain Category, AWS Business Applications Category, AWS Compute Category, AWS Cost Management Category (+12 more)

### Community 2 - "Cloud Operations Modules"
Cohesion: 0.20
Nodes (15): Analytics Automation and AI, Cloud Operations Persona Model, CloudAware Product Modules, CMDB Common Foundation, CMDB Workflows, Cost Management Operating Model, Modules and Operating Model, Monitoring Logs Patching and Backup (+7 more)

### Community 3 - "Product Shell and Search"
Cohesion: 0.20
Nodes (12): Administration and Personal Controls, Capability-oriented Application Launcher, CloudAware Control Hub, CMDB Navigator, Global Search and Resource Views, Multi-tab Operator Workspace, Product Shell and Navigation, Sutra Coherent Operator Shell (+4 more)

### Community 4 - "AWS Onboarding and Administration"
Cohesion: 0.27
Nodes (11): API Credential Administration, AWS Account Onboarding Form, AWS Onboarding and Administration, AWS Organizations Onboarding, CloudFormation Quick Launch, Feature-gated Access-key Fallback, Least-privilege Permission Packs, Manual CloudFormation Creation (+3 more)

### Community 5 - "AWS Catalog Coverage"
Cohesion: 0.43
Nodes (7): AWS Service and Resource Catalog, Canonical AWS Object Catalog Contract, Rich AWS CMDB Object Model, Truthful Catalog Coverage, AWS CMDB Object-type Inventory, CloudAware AWS Resource Coverage, CloudAware-informed AWS Product Map for Sutra

## Knowledge Gaps
- **12 isolated node(s):** `CloudAware Control Hub`, `Multi-tab Operator Workspace`, `Capability-oriented Application Launcher`, `Administration and Personal Controls`, `Feature-gated Access-key Fallback` (+7 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `AWS Navigator Taxonomy` connect `AWS Navigator Categories` to `Product Shell and Search`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **What connects `CloudAware Control Hub`, `Multi-tab Operator Workspace`, `Capability-oriented Application Launcher` to the rest of the system?**
  _12 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Implementation Roadmap and Gaps` be split into smaller, more focused modules?**
  _Cohesion score 0.13157894736842105 - nodes in this community are weakly interconnected._