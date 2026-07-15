import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch() * 1000)`);

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  issuer: text("issuer").notNull(),
  subject: text("subject").notNull(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  createdAt: timestamp("created_at"),
}, (table) => [
  uniqueIndex("users_issuer_subject_uq").on(table.issuer, table.subject),
]);

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  createdAt: timestamp("created_at"),
}, (table) => [uniqueIndex("organizations_slug_uq").on(table.slug)]);

export const memberships = sqliteTable("memberships", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  userId: text("user_id").notNull().references(() => users.id),
  role: text("role", { enum: ["org_owner", "org_admin", "analyst", "viewer", "customer_admin", "customer_viewer"] }).notNull(),
  scopeMode: text("scope_mode", { enum: ["all_customers", "assigned_customers"] }).notNull().default("assigned_customers"),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  createdAt: timestamp("created_at"),
}, (table) => [
  uniqueIndex("memberships_org_user_uq").on(table.orgId, table.userId),
  index("memberships_org_user_status_idx").on(table.orgId, table.userId, table.status),
]);

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "trial", "suspended"] }).notNull().default("active"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  uniqueIndex("customers_org_slug_uq").on(table.orgId, table.slug),
  uniqueIndex("customers_org_id_uq").on(table.orgId, table.id),
]);

export const customerAccess = sqliteTable("customer_access", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  membershipId: text("membership_id").notNull().references(() => memberships.id),
  role: text("role", { enum: ["customer_admin", "analyst", "viewer", "customer_viewer"] }).notNull(),
  createdAt: timestamp("created_at"),
}, (table) => [
  uniqueIndex("customer_access_scope_uq").on(table.orgId, table.customerId, table.membershipId),
  index("customer_access_member_idx").on(table.orgId, table.membershipId, table.customerId),
]);

export const awsConnections = sqliteTable("aws_connections", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  partition: text("partition", { enum: ["aws", "aws-us-gov", "aws-cn"] }).notNull().default("aws"),
  awsAccountId: text("aws_account_id").notNull(),
  roleArn: text("role_arn").notNull(),
  externalIdCiphertext: text("external_id_ciphertext").notNull(),
  externalIdKeyVersion: text("external_id_key_version").notNull(),
  permissionPackVersion: text("permission_pack_version").notNull(),
  status: text("status", { enum: ["pending", "validating", "active", "needs_attention", "disabled"] }).notNull().default("pending"),
  enabledRegionsJson: text("enabled_regions_json").notNull().default("[]"),
  lastValidatedAt: integer("last_validated_at", { mode: "timestamp_ms" }),
  lastSuccessfulSyncAt: integer("last_successful_sync_at", { mode: "timestamp_ms" }),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  uniqueIndex("aws_connections_customer_account_uq").on(table.orgId, table.customerId, table.partition, table.awsAccountId),
  index("aws_connections_scope_status_idx").on(table.orgId, table.customerId, table.status),
]);

export const syncRuns = sqliteTable("sync_runs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  triggerKind: text("trigger_kind", { enum: ["manual", "scheduled", "onboarding"] }).notNull(),
  status: text("status", { enum: ["queued", "running", "partial", "succeeded", "failed", "cancelled"] }).notNull(),
  coverageState: text("coverage_state", { enum: ["complete", "partial", "unknown"] }).notNull().default("unknown"),
  collectorPackVersion: text("collector_pack_version").notNull(),
  totalsJson: text("totals_json").notNull().default("{}"),
  idempotencyKey: text("idempotency_key").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  createdAt: timestamp("created_at"),
}, (table) => [
  uniqueIndex("sync_runs_connection_idempotency_uq").on(table.orgId, table.connectionId, table.idempotencyKey),
  index("sync_runs_scope_started_idx").on(table.orgId, table.customerId, table.connectionId, table.startedAt),
]);

export const resources = sqliteTable("resources", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  providerKey: text("provider_key").notNull(),
  awsAccountId: text("aws_account_id").notNull(),
  regionKey: text("region_key").notNull(),
  resourceType: text("resource_type").notNull(),
  nativeId: text("native_id").notNull(),
  arn: text("arn"),
  name: text("name"),
  lifecycleState: text("lifecycle_state", { enum: ["active", "retired", "unknown"] }).notNull().default("active"),
  configurationJson: text("configuration_json").notNull().default("{}"),
  contentSha256: text("content_sha256").notNull(),
  firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  seenInRunId: text("seen_in_run_id").references(() => syncRuns.id),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
}, (table) => [
  uniqueIndex("resources_provider_identity_uq").on(table.orgId, table.connectionId, table.resourceType, table.regionKey, table.nativeId),
  index("resources_scope_type_state_idx").on(table.orgId, table.customerId, table.lifecycleState, table.resourceType, table.id),
  index("resources_scope_account_region_idx").on(table.orgId, table.customerId, table.awsAccountId, table.regionKey, table.id),
]);

export const controlVersions = sqliteTable("control_versions", {
  id: text("id").primaryKey(),
  controlKey: text("control_key").notNull(),
  version: text("version").notNull(),
  title: text("title").notNull(),
  defaultSeverity: text("default_severity", { enum: ["critical", "high", "medium", "low", "informational"] }).notNull(),
  ruleAstJson: text("rule_ast_json").notNull(),
  remediationJson: text("remediation_json").notNull(),
  releasedAt: integer("released_at", { mode: "timestamp_ms" }).notNull(),
  retiredAt: integer("retired_at", { mode: "timestamp_ms" }),
}, (table) => [uniqueIndex("control_versions_key_version_uq").on(table.controlKey, table.version)]);

export const findings = sqliteTable("findings", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  resourceId: text("resource_id").references(() => resources.id),
  controlKey: text("control_key").notNull(),
  fingerprint: text("fingerprint").notNull(),
  severity: text("severity", { enum: ["critical", "high", "medium", "low", "informational"] }).notNull(),
  confidence: text("confidence", { enum: ["high", "medium", "low"] }).notNull().default("high"),
  status: text("status", { enum: ["open", "acknowledged", "resolved", "suppressed"] }).notNull().default("open"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  currentEvidenceJson: text("current_evidence_json").notNull(),
  firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
}, (table) => [
  uniqueIndex("findings_org_fingerprint_uq").on(table.orgId, table.fingerprint),
  index("findings_scope_status_severity_idx").on(table.orgId, table.customerId, table.status, table.severity, table.lastSeenAt, table.id),
  index("findings_scope_resource_status_idx").on(table.orgId, table.customerId, table.resourceId, table.status),
]);

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").references(() => customers.id),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  actorType: text("actor_type", { enum: ["user", "service", "system"] }).notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  outcome: text("outcome", { enum: ["allowed", "denied", "failed"] }).notNull(),
  requestId: text("request_id").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  previousEventHash: text("previous_event_hash"),
  eventHash: text("event_hash").notNull(),
}, (table) => [index("audit_events_org_time_idx").on(table.orgId, table.occurredAt, table.id)]);
