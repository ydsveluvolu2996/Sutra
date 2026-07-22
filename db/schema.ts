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
  uniqueIndex("users_issuer_email_uq").on(table.issuer, table.email),
]);

export const localPasswordCredentials = sqliteTable("local_password_credentials", {
  userId: text("user_id").primaryKey().references(() => users.id),
  algorithm: text("algorithm", { enum: ["pbkdf2-sha256"] }).notNull(),
  iterations: integer("iterations").notNull(),
  salt: text("salt").notNull(),
  passwordHash: text("password_hash").notNull(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: integer("locked_until", { mode: "timestamp_ms" }),
  changedAt: timestamp("changed_at"),
  updatedAt: timestamp("updated_at"),
});

export const totpCredentials = sqliteTable("totp_credentials", {
  userId: text("user_id").primaryKey().references(() => users.id),
  secretCiphertext: text("secret_ciphertext").notNull(),
  secretKeyVersion: text("secret_key_version").notNull(),
  confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
  lastUsedStep: integer("last_used_step"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

export const organizations = sqliteTable("organizations", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  createdAt: timestamp("created_at"),
}, (table) => [uniqueIndex("organizations_slug_uq").on(table.slug)]);

export const localSessions = sqliteTable("local_sessions", {
  id: text("id").primaryKey(),
  tokenDigest: text("token_digest").notNull(),
  userId: text("user_id").notNull().references(() => users.id),
  selectedOrgId: text("selected_org_id").notNull().references(() => organizations.id),
  createdAt: timestamp("created_at"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  lastSeenAt: timestamp("last_seen_at"),
  mfaVerifiedAt: integer("mfa_verified_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
}, (table) => [
  uniqueIndex("local_sessions_token_digest_uq").on(table.tokenDigest),
  index("local_sessions_user_expiry_idx").on(table.userId, table.expiresAt, table.revokedAt),
]);

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

export const identityInvitations = sqliteTable("identity_invitations", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  email: text("email").notNull(),
  role: text("role", { enum: ["org_admin", "analyst", "viewer", "customer_admin", "customer_viewer"] }).notNull(),
  scopeMode: text("scope_mode", { enum: ["all_customers", "assigned_customers"] }).notNull().default("assigned_customers"),
  customerId: text("customer_id").references(() => customers.id),
  tokenDigest: text("token_digest").notNull(),
  invitedBy: text("invited_by").notNull().references(() => users.id),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  acceptedAt: integer("accepted_at", { mode: "timestamp_ms" }),
  acceptedUserId: text("accepted_user_id"),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  deliveryStatus: text("delivery_status", { enum: ["not_attempted", "sending", "accepted", "failed", "unknown"] }).notNull().default("not_attempted"),
  deliveryTransport: text("delivery_transport", { enum: ["none", "email-api"] }).notNull().default("none"),
  deliveryProvider: text("delivery_provider", { enum: ["none", "resend", "sendgrid", "generic"] }).notNull().default("none"),
  deliveryAttempts: integer("delivery_attempts").notNull().default(0),
  deliveryLastAttemptedAt: integer("delivery_last_attempted_at", { mode: "timestamp_ms" }),
  deliveryCompletedAt: integer("delivery_completed_at", { mode: "timestamp_ms" }),
  deliveryErrorCode: text("delivery_error_code"),
  deliveryHttpStatus: integer("delivery_http_status"),
  deliveryIdempotencyDigest: text("delivery_idempotency_digest"),
  deliveryRevision: integer("delivery_revision").notNull().default(0),
  createdAt: timestamp("created_at"),
}, (table) => [
  uniqueIndex("identity_invitations_token_uq").on(table.tokenDigest),
  uniqueIndex("identity_invitations_active_email_uq")
    .on(table.orgId, table.email)
    .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
  index("identity_invitations_org_expiry_idx").on(table.orgId, table.expiresAt, table.revokedAt),
  index("identity_invitations_org_delivery_idx").on(table.orgId, table.deliveryStatus, table.deliveryLastAttemptedAt),
]);

/**
 * Durable idempotency ledger for invitation lifecycle mutations. Creation may
 * claim an operation before an invitation exists, so `invitationId` is nullable
 * and `idempotencyScopeId` supplies the stable pre-create scope (normally the
 * actor id). Resend and initial-delivery rows set both fields to the invitation
 * id. Plaintext idempotency keys, invitation tokens and activation URLs never
 * enter this table.
 */
export const identityInvitationOperations = sqliteTable("identity_invitation_operations", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  operationKind: text("operation_kind", { enum: ["creation", "initial_delivery", "resend"] }).notNull(),
  idempotencyScopeId: text("idempotency_scope_id").notNull(),
  invitationId: text("invitation_id").references(() => identityInvitations.id),
  idempotencyDigest: text("idempotency_digest").notNull(),
  requestFingerprint: text("request_fingerprint").notNull(),
  operationStatus: text("operation_status", { enum: ["claimed", "completed"] }).notNull().default("claimed"),
  outcomeStatus: text("outcome_status", { enum: ["accepted", "failed", "unknown"] }),
  deliveryTransport: text("delivery_transport", { enum: ["none", "email-api"] }).notNull().default("none"),
  deliveryProvider: text("delivery_provider", { enum: ["none", "resend", "sendgrid", "generic"] }).notNull().default("none"),
  deliveryErrorCode: text("delivery_error_code"),
  deliveryHttpStatus: integer("delivery_http_status"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
}, (table) => [
  uniqueIndex("identity_invitation_operations_scope_key_uq")
    .on(table.orgId, table.operationKind, table.idempotencyScopeId, table.idempotencyDigest),
  uniqueIndex("identity_invitation_operations_invitation_key_uq")
    .on(table.orgId, table.invitationId, table.idempotencyDigest)
    .where(sql`${table.invitationId} IS NOT NULL`),
  index("identity_invitation_operations_invitation_time_idx")
    .on(table.orgId, table.invitationId, table.createdAt, table.id),
]);

export const identityInvitationEvents = sqliteTable("identity_invitation_events", {
  id: text("id").primaryKey(),
  invitationId: text("invitation_id").notNull().references(() => identityInvitations.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  actorId: text("actor_id").notNull(),
  action: text("action", { enum: [
    "created", "accepted", "revoked", "resent", "delivery_started",
    "delivery_accepted", "delivery_failed", "delivery_unknown",
  ] }).notNull(),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  previousEventHash: text("previous_event_hash"),
  eventHash: text("event_hash").notNull(),
}, (table) => [
  uniqueIndex("identity_invitation_events_hash_uq").on(table.invitationId, table.eventHash),
  uniqueIndex("identity_invitation_events_previous_hash_uq")
    .on(table.invitationId, table.previousEventHash)
    .where(sql`${table.previousEventHash} IS NOT NULL`),
  index("identity_invitation_events_org_time_idx").on(table.orgId, table.occurredAt, table.id),
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
  sourceKind: text("source_kind", { enum: ["aws_trust_role", "simulated_fixture"] }).notNull().default("aws_trust_role"),
  fixtureId: text("fixture_id"),
  fixtureVersion: text("fixture_version"),
  partition: text("partition", { enum: ["aws", "aws-us-gov", "aws-cn"] }).notNull().default("aws"),
  awsAccountId: text("aws_account_id").notNull(),
  roleArn: text("role_arn").notNull(),
  externalIdCiphertext: text("external_id_ciphertext").notNull(),
  externalIdKeyVersion: text("external_id_key_version").notNull(),
  permissionPackVersion: text("permission_pack_version").notNull(),
  roleProvisioningMode: text("role_provisioning_mode", { enum: ["sutra_template", "customer_managed"] }).notNull().default("sutra_template"),
  expectedRolePath: text("expected_role_path").notNull().default("/sutra/"),
  expectedRoleName: text("expected_role_name").notNull().default("SutraReadOnlyRole"),
  permissionCapabilitiesJson: text("permission_capabilities_json"),
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
  scheduleId: text("schedule_id"),
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
  uniqueIndex("sync_runs_one_active_connection_uq")
    .on(table.orgId, table.connectionId)
    .where(sql`${table.status} IN ('queued', 'running')`),
  index("sync_runs_scope_started_idx").on(table.orgId, table.customerId, table.connectionId, table.startedAt),
]);

/**
 * Per-service/region execution detail. A sync can succeed partially without
 * hiding which API families were denied, throttled, or unavailable.
 */
export const collectorRuns = sqliteTable("collector_runs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  syncRunId: text("sync_run_id").notNull().references(() => syncRuns.id),
  collectorKey: text("collector_key").notNull(),
  regionKey: text("region_key").notNull(),
  status: text("status", { enum: ["queued", "running", "succeeded", "partial", "failed", "skipped"] }).notNull(),
  itemsObserved: integer("items_observed").notNull().default(0),
  pagesObserved: integer("pages_observed").notNull().default(0),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
}, (table) => [
  uniqueIndex("collector_runs_sync_collector_region_uq").on(table.syncRunId, table.collectorKey, table.regionKey),
  index("collector_runs_scope_sync_idx").on(table.orgId, table.customerId, table.connectionId, table.syncRunId),
]);

/**
 * Immutable normalized snapshots. The connection head is only advanced after
 * every row for a usable snapshot has been persisted, so failed runs preserve
 * the last known-good CMDB projection.
 */
export const cmdbSnapshots = sqliteTable("cmdb_snapshots", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  syncRunId: text("sync_run_id").notNull().references(() => syncRuns.id),
  status: text("status", { enum: ["staging", "complete", "partial", "failed"] }).notNull().default("staging"),
  collectedAt: integer("collected_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  coverageJson: text("coverage_json").notNull().default("{}"),
  summaryJson: text("summary_json").notNull().default("{}"),
  snapshotSha256: text("snapshot_sha256"),
  originKind: text("origin_kind", { enum: ["unknown", "simulated_fixture", "aws_sandbox"] }).notNull().default("unknown"),
  fixtureId: text("fixture_id"),
  fixtureVersion: text("fixture_version"),
}, (table) => [
  uniqueIndex("cmdb_snapshots_sync_run_uq").on(table.syncRunId),
  index("cmdb_snapshots_connection_time_idx").on(table.orgId, table.connectionId, table.collectedAt),
]);

export const connectionHeads = sqliteTable("connection_heads", {
  connectionId: text("connection_id").primaryKey().references(() => awsConnections.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  snapshotId: text("snapshot_id").notNull().references(() => cmdbSnapshots.id),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("connection_heads_scope_idx").on(table.orgId, table.customerId, table.connectionId),
]);

export const cmdbResources = sqliteTable("cmdb_resources", {
  id: text("id").primaryKey(),
  snapshotId: text("snapshot_id").notNull().references(() => cmdbSnapshots.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  resourceKey: text("resource_key").notNull(),
  providerKey: text("provider_key").notNull().default("aws"),
  service: text("service").notNull(),
  resourceType: text("resource_type").notNull(),
  nativeId: text("native_id").notNull(),
  arn: text("arn"),
  name: text("name"),
  regionKey: text("region_key").notNull(),
  state: text("state").notNull().default("unknown"),
  tagsJson: text("tags_json").notNull().default("{}"),
  configurationJson: text("configuration_json").notNull().default("{}"),
  sourceJson: text("source_json").notNull().default("{}"),
  contentSha256: text("content_sha256").notNull(),
  collectedAt: integer("collected_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("cmdb_resources_snapshot_key_uq").on(table.snapshotId, table.resourceKey),
  index("cmdb_resources_scope_type_idx").on(table.orgId, table.customerId, table.connectionId, table.resourceType, table.regionKey),
]);

/** Immutable resource-level deltas between consecutively published complete snapshots. */
export const cmdbChangeEvents = sqliteTable("cmdb_change_events", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  fromSnapshotId: text("from_snapshot_id").references(() => cmdbSnapshots.id),
  toSnapshotId: text("to_snapshot_id").notNull().references(() => cmdbSnapshots.id),
  resourceKey: text("resource_key").notNull(),
  changeType: text("change_type", { enum: ["added", "changed", "removed"] }).notNull(),
  changedPathsJson: text("changed_paths_json").notNull().default("[]"),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("cmdb_change_events_snapshot_resource_uq").on(table.toSnapshotId, table.resourceKey),
  index("cmdb_change_events_scope_time_idx").on(table.orgId, table.customerId, table.connectionId, table.occurredAt, table.id),
]);

export const cmdbRelationships = sqliteTable("cmdb_relationships", {
  id: text("id").primaryKey(),
  snapshotId: text("snapshot_id").notNull().references(() => cmdbSnapshots.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  fromResourceKey: text("from_resource_key").notNull(),
  toResourceKey: text("to_resource_key").notNull(),
  relationType: text("relation_type").notNull(),
  evidenceJson: text("evidence_json").notNull().default("{}"),
}, (table) => [
  uniqueIndex("cmdb_relationships_snapshot_edge_uq").on(table.snapshotId, table.fromResourceKey, table.toResourceKey, table.relationType),
  index("cmdb_relationships_scope_from_idx").on(table.orgId, table.customerId, table.connectionId, table.fromResourceKey),
]);

export const cmdbFindings = sqliteTable("cmdb_findings", {
  id: text("id").primaryKey(),
  snapshotId: text("snapshot_id").notNull().references(() => cmdbSnapshots.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  resourceKey: text("resource_key"),
  controlKey: text("control_key").notNull(),
  controlVersion: text("control_version").notNull(),
  fingerprint: text("fingerprint").notNull(),
  severity: text("severity", { enum: ["critical", "high", "medium", "low", "informational"] }).notNull(),
  status: text("status", { enum: ["open", "acknowledged", "resolved", "suppressed"] }).notNull().default("open"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  remediation: text("remediation").notNull(),
  evidenceJson: text("evidence_json").notNull(),
  evaluatedAt: integer("evaluated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("cmdb_findings_snapshot_fingerprint_uq").on(table.snapshotId, table.fingerprint),
  index("cmdb_findings_scope_severity_idx").on(table.orgId, table.customerId, table.connectionId, table.status, table.severity),
]);

/** Operator workflow state is kept outside immutable evidence snapshots. */
export const findingWorkflowStates = sqliteTable("finding_workflow_states", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  fingerprint: text("fingerprint").notNull(),
  status: text("status", { enum: ["open", "acknowledged", "suppressed"] }).notNull(),
  note: text("note"),
  actorId: text("actor_id").notNull(),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  uniqueIndex("finding_workflow_scope_fingerprint_uq").on(table.orgId, table.connectionId, table.fingerprint),
  index("finding_workflow_scope_status_idx").on(table.orgId, table.customerId, table.connectionId, table.status),
]);

/** Idempotent control-plane publication record for durable local fixture jobs. */
export const localJobPublications = sqliteTable("local_job_publications", {
  jobId: text("job_id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  syncRunId: text("sync_run_id").notNull().references(() => syncRuns.id),
  snapshotId: text("snapshot_id").notNull().references(() => cmdbSnapshots.id),
  fixtureId: text("fixture_id").notNull(),
  fixtureVersion: text("fixture_version").notNull(),
  scheduleId: text("schedule_id"),
  actorId: text("actor_id").notNull(),
  publishedAt: timestamp("published_at"),
}, (table) => [
  uniqueIndex("local_job_publications_sync_uq").on(table.orgId, table.syncRunId),
  index("local_job_publications_scope_time_idx").on(table.orgId, table.customerId, table.publishedAt, table.jobId),
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
}, (table) => [
  index("audit_events_org_time_idx").on(table.orgId, table.occurredAt, table.id),
  uniqueIndex("audit_events_org_request_id_uq").on(table.orgId, table.requestId),
]);

/**
 * Local collector mutations cross the D1/collector process boundary. This
 * durable outbox preserves the exact signed command until its audit event is
 * committed, allowing an interrupted request to be replayed safely.
 */
export const localScheduleMutationOutbox = sqliteTable("local_schedule_mutation_outbox", {
  operationId: text("operation_id").primaryKey(),
  mutationSequence: integer("mutation_sequence"),
  orgId: text("org_id").notNull().references(() => organizations.id),
  actorId: text("actor_id").notNull(),
  customerId: text("customer_id").references(() => customers.id),
  scheduleId: text("schedule_id").notNull(),
  fixtureId: text("fixture_id").notNull(),
  connectionId: text("connection_id").notNull(),
  operationKind: text("operation_kind", { enum: ["upsert", "toggle"] }).notNull(),
  commandJson: text("command_json").notNull(),
  commandSha256: text("command_sha256").notNull(),
  status: text("status", { enum: ["pending", "completed", "failed"] }).notNull().default("pending"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  failureCode: text("failure_code"),
  failedAt: integer("failed_at", { mode: "timestamp_ms" }),
}, (table) => [
  uniqueIndex("local_schedule_mutation_outbox_sequence_uq").on(table.mutationSequence),
  index("local_schedule_mutation_outbox_pending_idx")
    .on(table.orgId, table.status, table.createdAt, table.operationId),
  index("local_schedule_mutation_outbox_scope_idx")
    .on(table.orgId, table.customerId, table.scheduleId, table.createdAt),
]);

/** Immutable, account-scoped AWS Cost Explorer observations. */
export const costSnapshots = sqliteTable("cost_snapshots", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  source: text("source", { enum: ["aws_cost_explorer"] }).notNull().default("aws_cost_explorer"),
  status: text("status", { enum: ["complete", "partial", "unavailable"] }).notNull(),
  currency: text("currency").notNull(),
  periodStart: text("period_start").notNull(),
  periodEnd: text("period_end").notNull(),
  collectedAt: integer("collected_at", { mode: "timestamp_ms" }).notNull(),
  payloadJson: text("payload_json").notNull(),
  payloadSha256: text("payload_sha256").notNull(),
  createdAt: timestamp("created_at"),
}, (table) => [
  uniqueIndex("cost_snapshots_connection_hash_uq").on(table.orgId, table.connectionId, table.payloadSha256),
  index("cost_snapshots_scope_time_idx").on(table.orgId, table.customerId, table.connectionId, table.collectedAt, table.id),
]);

/** Time-bounded, finding-specific compliance risk acceptance workflow. */
export const complianceExceptions = sqliteTable("compliance_exceptions", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  controlKey: text("control_key").notNull(),
  findingFingerprint: text("finding_fingerprint").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected", "revoked"] }).notNull().default("pending"),
  ownerUserId: text("owner_user_id").notNull().references(() => users.id),
  requestedBy: text("requested_by").notNull().references(() => users.id),
  reviewedBy: text("reviewed_by").references(() => users.id),
  rationale: text("rationale").notNull(),
  compensatingControl: text("compensating_control").notNull(),
  reviewNote: text("review_note"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  requestedAt: timestamp("requested_at"),
  reviewedAt: integer("reviewed_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  uniqueIndex("compliance_exceptions_active_finding_uq")
    .on(table.orgId, table.connectionId, table.findingFingerprint)
    .where(sql`${table.status} IN ('pending', 'approved')`),
  index("compliance_exceptions_scope_status_idx")
    .on(table.orgId, table.customerId, table.connectionId, table.status, table.expiresAt),
]);

/** Immutable local activity ledger; the global chained audit log is also appended. */
export const complianceExceptionEvents = sqliteTable("compliance_exception_events", {
  id: text("id").primaryKey(),
  exceptionId: text("exception_id").notNull().references(() => complianceExceptions.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  actorId: text("actor_id").notNull().references(() => users.id),
  action: text("action", { enum: ["requested", "approved", "rejected", "revoked"] }).notNull(),
  note: text("note"),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("compliance_exception_events_scope_time_idx")
    .on(table.orgId, table.exceptionId, table.occurredAt, table.id),
]);

export const findingCases = sqliteTable("finding_cases", {
  id: text("id").primaryKey(),
  caseNumber: text("case_number").notNull(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  findingFingerprint: text("finding_fingerprint").notNull(),
  findingSnapshotId: text("finding_snapshot_id").notNull().references(() => cmdbSnapshots.id),
  findingSeverity: text("finding_severity").notNull(),
  title: text("title").notNull(),
  status: text("status", { enum: ["open", "investigating", "resolved", "closed"] }).notNull().default("open"),
  priority: text("priority", { enum: ["critical", "high", "medium", "low"] }).notNull(),
  assigneeMembershipId: text("assignee_membership_id").references(() => memberships.id),
  dueAt: integer("due_at", { mode: "timestamp_ms" }).notNull(),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
  closedAt: integer("closed_at", { mode: "timestamp_ms" }),
  createdByUserId: text("created_by_user_id").notNull().references(() => users.id),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  uniqueIndex("finding_cases_org_number_uq").on(table.orgId, table.caseNumber),
  uniqueIndex("finding_cases_active_fingerprint_uq")
    .on(table.orgId, table.connectionId, table.findingFingerprint)
    .where(sql`${table.status} != 'closed'`),
  index("finding_cases_scope_status_idx")
    .on(table.orgId, table.customerId, table.connectionId, table.status, table.updatedAt),
]);

export const findingCaseActivities = sqliteTable("finding_case_activities", {
  id: text("id").primaryKey(),
  caseId: text("case_id").notNull().references(() => findingCases.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  kind: text("kind", { enum: ["created", "status_changed", "assignment_changed", "priority_changed", "due_date_changed", "note_added"] }).notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => users.id),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
  detailJson: text("detail_json").notNull(),
  previousEventHash: text("previous_event_hash"),
  eventHash: text("event_hash").notNull(),
}, (table) => [
  uniqueIndex("finding_case_activity_hash_uq").on(table.caseId, table.eventHash),
  uniqueIndex("finding_case_activity_chain_uq").on(table.caseId, table.previousEventHash),
  index("finding_case_activity_timeline_idx")
    .on(table.orgId, table.customerId, table.caseId, table.occurredAt, table.id),
]);

export const securityEventSources = sqliteTable("security_event_sources", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  source: text("source", { enum: ["aws_cloudtrail_lookup_events"] }).notNull().default("aws_cloudtrail_lookup_events"),
  status: text("status", { enum: ["NOT_COLLECTED", "COMPLETE", "PARTIAL", "UNAVAILABLE"] }).notNull().default("NOT_COLLECTED"),
  retentionDays: integer("retention_days").notNull().default(30),
  lookbackHours: integer("lookback_hours").notNull().default(1),
  overlapMinutes: integer("overlap_minutes").notNull().default(5),
  lastWindowStart: integer("last_window_start", { mode: "timestamp_ms" }),
  lastWindowEnd: integer("last_window_end", { mode: "timestamp_ms" }),
  lastCollectedAt: integer("last_collected_at", { mode: "timestamp_ms" }),
  lastRunId: text("last_run_id"),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  uniqueIndex("security_event_sources_scope_uq").on(table.orgId, table.customerId, table.connectionId),
]);

export const securityEventRuns = sqliteTable("security_event_runs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  source: text("source", { enum: ["aws_cloudtrail_lookup_events"] }).notNull().default("aws_cloudtrail_lookup_events"),
  status: text("status", { enum: ["PERSISTING", "COMPLETE", "PARTIAL", "UNAVAILABLE"] }).notNull(),
  windowStart: integer("window_start", { mode: "timestamp_ms" }).notNull(),
  windowEnd: integer("window_end", { mode: "timestamp_ms" }).notNull(),
  collectedAt: integer("collected_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }).notNull(),
  coverageJson: text("coverage_json").notNull(),
  eventsObserved: integer("events_observed").notNull().default(0),
  eventsInserted: integer("events_inserted").notNull().default(0),
  duplicateEvents: integer("duplicate_events").notNull().default(0),
  detectionsObserved: integer("detections_observed").notNull().default(0),
  payloadSha256: text("payload_sha256").notNull(),
}, (table) => [
  uniqueIndex("security_event_runs_scope_hash_uq").on(table.orgId, table.connectionId, table.payloadSha256),
  index("security_event_runs_scope_time_idx").on(table.orgId, table.customerId, table.connectionId, table.collectedAt, table.id),
]);

export const securityEvents = sqliteTable("security_events", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  sourceRunId: text("source_run_id").notNull().references(() => securityEventRuns.id),
  providerEventId: text("provider_event_id").notNull(),
  accountId: text("account_id").notNull(),
  regionKey: text("region_key").notNull(),
  eventTime: integer("event_time", { mode: "timestamp_ms" }).notNull(),
  eventName: text("event_name").notNull(),
  eventSource: text("event_source").notNull(),
  readOnly: integer("read_only", { mode: "boolean" }),
  managementEvent: integer("management_event", { mode: "boolean" }),
  eventCategory: text("event_category"),
  username: text("username"),
  identityType: text("identity_type"),
  principalArn: text("principal_arn"),
  sourceIp: text("source_ip"),
  userAgent: text("user_agent"),
  errorCode: text("error_code"),
  requestId: text("request_id"),
  consoleLoginResult: text("console_login_result", { enum: ["Success", "Failure"] }),
  mfaUsed: integer("mfa_used", { mode: "boolean" }),
  detailStatus: text("detail_status", { enum: ["AVAILABLE", "UNAVAILABLE"] }).notNull(),
  resourcesJson: text("resources_json").notNull().default("[]"),
  ingestedAt: integer("ingested_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("security_events_provider_identity_uq").on(table.orgId, table.connectionId, table.providerEventId),
  index("security_events_scope_time_idx").on(table.orgId, table.customerId, table.connectionId, table.eventTime, table.id),
  index("security_events_scope_name_idx").on(table.orgId, table.customerId, table.connectionId, table.eventName, table.regionKey, table.eventTime),
]);

export const securityEventDetections = sqliteTable("security_event_detections", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  sourceRunId: text("source_run_id").notNull().references(() => securityEventRuns.id),
  ruleKey: text("rule_key").notNull(),
  ruleVersion: text("rule_version").notNull(),
  severity: text("severity", { enum: ["critical", "high", "medium", "low"] }).notNull(),
  status: text("status", { enum: ["open", "acknowledged"] }).notNull().default("open"),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  firstEventAt: integer("first_event_at", { mode: "timestamp_ms" }).notNull(),
  lastEventAt: integer("last_event_at", { mode: "timestamp_ms" }).notNull(),
  eventIdsJson: text("event_ids_json").notNull(),
  evidenceJson: text("evidence_json").notNull(),
  limitation: text("limitation").notNull(),
  note: text("note"),
  actorId: text("actor_id").references(() => users.id),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  uniqueIndex("security_event_detections_scope_id_uq").on(table.orgId, table.connectionId, table.id),
  index("security_event_detections_scope_status_idx").on(table.orgId, table.customerId, table.connectionId, table.status, table.severity, table.lastEventAt, table.id),
]);

/** Credential-free Kubernetes cluster identity scoped to one MSP customer. */
export const kubernetesClusters = sqliteTable("kubernetes_clusters", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  clusterUid: text("cluster_uid").notNull(),
  name: text("name").notNull(),
  distribution: text("distribution"),
  version: text("version"),
  status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  uniqueIndex("kubernetes_clusters_scope_uid_uq").on(table.orgId, table.customerId, table.clusterUid),
  uniqueIndex("kubernetes_clusters_scope_id_uq").on(table.orgId, table.customerId, table.id),
  index("kubernetes_clusters_scope_status_idx").on(table.orgId, table.customerId, table.status, table.name),
]);

/** Immutable normalized scan publication; partial scans never replace the complete head. */
export const kubernetesScanRuns = sqliteTable("kubernetes_scan_runs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  clusterId: text("cluster_id").notNull().references(() => kubernetesClusters.id),
  status: text("status", { enum: ["complete", "partial", "failed"] }).notNull(),
  collectedAt: integer("collected_at", { mode: "timestamp_ms" }).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  evidenceSha256: text("evidence_sha256").notNull(),
  postureSha256: text("posture_sha256").notNull(),
  resourceCount: integer("resource_count").notNull(),
  findingCount: integer("finding_count").notNull(),
  coverageCount: integer("coverage_count").notNull(),
  createdAt: timestamp("created_at"),
}, (table) => [
  uniqueIndex("kubernetes_scan_runs_scope_idempotency_uq")
    .on(table.orgId, table.clusterId, table.idempotencyKey),
  uniqueIndex("kubernetes_scan_runs_scope_id_uq")
    .on(table.orgId, table.customerId, table.clusterId, table.id),
  index("kubernetes_scan_runs_scope_time_idx")
    .on(table.orgId, table.customerId, table.clusterId, table.collectedAt, table.id),
]);

export const kubernetesScanHeads = sqliteTable("kubernetes_scan_heads", {
  clusterId: text("cluster_id").primaryKey().references(() => kubernetesClusters.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  scanRunId: text("scan_run_id").notNull().references(() => kubernetesScanRuns.id),
  collectedAt: integer("collected_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("kubernetes_scan_heads_scope_idx").on(table.orgId, table.customerId, table.clusterId),
]);

export const kubernetesScanResources = sqliteTable("kubernetes_scan_resources", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  clusterId: text("cluster_id").notNull().references(() => kubernetesClusters.id),
  scanRunId: text("scan_run_id").notNull().references(() => kubernetesScanRuns.id),
  resourceKey: text("resource_key").notNull(),
  kind: text("kind").notNull(),
  namespace: text("namespace"),
  name: text("name").notNull(),
  evidenceJson: text("evidence_json").notNull(),
  evidenceSha256: text("evidence_sha256").notNull(),
}, (table) => [
  uniqueIndex("kubernetes_scan_resources_run_key_uq").on(table.scanRunId, table.resourceKey),
  index("kubernetes_scan_resources_scope_kind_idx")
    .on(table.orgId, table.customerId, table.clusterId, table.kind, table.namespace, table.name),
]);

export const kubernetesScanFindings = sqliteTable("kubernetes_scan_findings", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  clusterId: text("cluster_id").notNull().references(() => kubernetesClusters.id),
  scanRunId: text("scan_run_id").notNull().references(() => kubernetesScanRuns.id),
  controlId: text("control_id").notNull(),
  subject: text("subject").notNull(),
  state: text("state", { enum: ["PASS", "FAIL", "UNKNOWN"] }).notNull(),
  severity: text("severity", { enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] }).notNull(),
  message: text("message").notNull(),
  evidenceJson: text("evidence_json").notNull(),
  findingSha256: text("finding_sha256").notNull(),
}, (table) => [
  uniqueIndex("kubernetes_scan_findings_run_control_subject_uq")
    .on(table.scanRunId, table.controlId, table.subject),
  index("kubernetes_scan_findings_scope_state_idx")
    .on(table.orgId, table.customerId, table.clusterId, table.state, table.severity, table.controlId),
]);

export const kubernetesScanCoverage = sqliteTable("kubernetes_scan_coverage", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  clusterId: text("cluster_id").notNull().references(() => kubernetesClusters.id),
  scanRunId: text("scan_run_id").notNull().references(() => kubernetesScanRuns.id),
  evidenceKind: text("evidence_kind").notNull(),
  state: text("state", { enum: ["COMPLETE", "PARTIAL", "UNKNOWN", "FAILED"] }).notNull(),
  itemsObserved: integer("items_observed").notNull(),
  errorCode: text("error_code"),
}, (table) => [
  uniqueIndex("kubernetes_scan_coverage_run_kind_uq").on(table.scanRunId, table.evidenceKind),
  index("kubernetes_scan_coverage_scope_state_idx")
    .on(table.orgId, table.customerId, table.clusterId, table.state, table.evidenceKind),
]);

/** Immutable, sanitized Trivy Operator findings and SBOM summaries for one scan. */
export const kubernetesScanScannerEvidence = sqliteTable("kubernetes_scan_scanner_evidence", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  clusterId: text("cluster_id").notNull().references(() => kubernetesClusters.id),
  scanRunId: text("scan_run_id").notNull().references(() => kubernetesScanRuns.id),
  findingsJson: text("findings_json").notNull(),
  sbomsJson: text("sboms_json").notNull(),
  evidenceSha256: text("evidence_sha256").notNull(),
  findingCount: integer("finding_count").notNull(),
  sbomCount: integer("sbom_count").notNull(),
}, (table) => [
  uniqueIndex("kubernetes_scan_scanner_evidence_run_uq").on(table.scanRunId),
  index("kubernetes_scan_scanner_evidence_scope_idx")
    .on(table.orgId, table.customerId, table.clusterId, table.scanRunId),
]);
