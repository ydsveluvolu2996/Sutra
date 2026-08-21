# AWS service and resource catalog

## Captured scale

The signed-in AWS Navigator exposed **18 categories** and **114 service destinations**. The public AWS resource-coverage page enumerated **978 CMDB object types**. Tag Analyzer exposed **317 AWS resource types** that can participate in tagging workflows.

The complete machine-readable inventories are preserved in:

- [`raw/aws-navigator-routes.json`](raw/aws-navigator-routes.json)
- [`raw/aws-resource-coverage.txt`](raw/aws-resource-coverage.txt)
- [`raw/aws-taggable-resource-types.txt`](raw/aws-taggable-resource-types.txt)

## Navigator categories

**Observed:** AI & Machine Learning; Analytics; Application Integration; Blockchain; Business Applications; Compute; Cost Management; Customer Engagement; Database; Developer Tools; End User Computing; Internet of Things; Management & Governance; Media Services; Migration & Transfer; Networking & Content Delivery; Security, Identity & Compliance; and Storage.

Examples of the service breadth include Bedrock, SageMaker, Athena, Glue, Kinesis, MSK, OpenSearch, SNS, SQS, Step Functions, Connect, EC2, ECS, EKS, Lambda, Budgets, Cost Explorer, RDS, DynamoDB, ElastiCache, Redshift, CodeBuild, CodePipeline, WorkSpaces, CloudFormation, CloudTrail, CloudWatch, Config, EventBridge, SSM, DMS, CloudFront, Route 53, VPC, Network Firewall, GuardDuty, IAM, Inspector, KMS, Organizations, Secrets Manager, Security Hub, WAF, EFS, FSx, S3, and Storage Gateway.

## Model shape

**Observed and documented:** CloudAware models more than top-level resources. The catalog includes:

- resources and subresources;
- relationship/link objects;
- configuration versions and policy attachments;
- findings, events, statuses, recommendations, and compliance evaluations;
- account, partition, Region, Availability Zone, and quota context;
- host/OS/package facts collected through an agent;
- backup plans, selections, vaults, recovery points, and restore tests;
- Kubernetes objects associated with EKS clusters;
- cost, budget, reservation, and savings-plan evidence.

This distinction matters: collecting `EC2 Instance` alone is not equivalent to an EC2 CMDB. Useful service pages also need related network interfaces, IPs, volumes, snapshots, images, launch templates, security groups/rules, scaling constructs, status events, host facts, and typed relationships.

## Required Sutra catalog contract

**Inference:** define a versioned canonical catalog with one record per object type:

- AWS category and service;
- Sutra resource type and provider-native identifier;
- global/regional scope and partitions;
- required APIs, permissions, pagination, quotas, and throttling behavior;
- collection frequency and event sources;
- normalization schema and relationship extractors;
- sensitive-field/redaction rules;
- tagging, cost, compliance, security, backup, and monitoring applicability;
- implementation maturity and external-acceptance state;
- empty/partial/stale/failed semantics.

Navigator can expose the full approved catalog before all collectors exist, but it must show coverage truthfully. Unsupported or unconfigured types must never appear as a successfully collected zero.
