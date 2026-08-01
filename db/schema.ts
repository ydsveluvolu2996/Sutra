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

export const samlAssertionReplays = sqliteTable("saml_assertion_replays", {
  identityIssuer: text("identity_issuer").notNull(),
  assertionId: text("assertion_id").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("saml_assertion_replays_identity_assertion_uq").on(table.identityIssuer, table.assertionId),
  index("saml_assertion_replays_expiry_idx").on(table.expiresAt),
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
  deliveryProvider: text("delivery_provider", { enum: ["none", "zoho", "resend", "sendgrid", "generic"] }).notNull().default("none"),
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

export const passwordResetTokens = sqliteTable("password_reset_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  tokenDigest: text("token_digest").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
  consumedNonce: text("consumed_nonce"),
  deliveryStatus: text("delivery_status", {
    enum: ["not_attempted", "accepted", "failed", "unknown"],
  }).notNull().default("not_attempted"),
  deliveryErrorCode: text("delivery_error_code"),
  requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("password_reset_tokens_digest_uq").on(table.tokenDigest),
  index("password_reset_tokens_user_expiry_idx").on(
    table.userId,
    table.expiresAt,
    table.consumedAt,
  ),
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
  deliveryProvider: text("delivery_provider", { enum: ["none", "zoho", "resend", "sendgrid", "generic"] }).notNull().default("none"),
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
  expectedRoleName: text("expected_role_name").notNull().default("SutraCollectorRole"),
  permissionCapabilitiesJson: text("permission_capabilities_json"),
  status: text("status", { enum: ["pending", "validating", "active", "needs_attention", "disabled"] }).notNull().default("pending"),
  enabledRegionsJson: text("enabled_regions_json").notNull().default("[]"),
  lastValidatedAt: integer("last_validated_at", { mode: "timestamp_ms" }),
  lastSuccessfulSyncAt: integer("last_successful_sync_at", { mode: "timestamp_ms" }),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  uniqueIndex("aws_connections_customer_account_uq").on(table.orgId, table.customerId, table.partition, table.awsAccountId),
  uniqueIndex("aws_connections_global_live_account_uq")
    .on(table.partition, table.awsAccountId)
    .where(sql`${table.sourceKind} = 'aws_trust_role'`),
  uniqueIndex("aws_connections_global_live_role_uq")
    .on(table.roleArn)
    .where(sql`${table.sourceKind} = 'aws_trust_role' AND ${table.roleArn} <> ''`),
  index("aws_connections_scope_status_idx").on(table.orgId, table.customerId, table.status),
]);

export const evidenceObjects = sqliteTable("evidence_objects", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  runId: text("run_id").notNull(),
  snapshotId: text("snapshot_id"),
  artifactKind: text("artifact_kind", {
    enum: [
      "aws_snapshot_raw",
      "export_json",
      "export_csv",
      "finops_source_snapshot",
    ],
  }).notNull(),
  objectKey: text("object_key").notNull(),
  contentType: text("content_type").notNull(),
  contentSha256: text("content_sha256").notNull(),
  byteSize: integer("byte_size").notNull(),
  status: text("status", { enum: ["staging", "available", "failed"] }).notNull().default("staging"),
  retentionUntil: integer("retention_until", { mode: "timestamp_ms" }).notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  availableAt: integer("available_at", { mode: "timestamp_ms" }),
}, (table) => [
  uniqueIndex("evidence_objects_key_uq").on(table.objectKey),
  uniqueIndex("evidence_objects_run_kind_uq")
    .on(table.orgId, table.connectionId, table.runId, table.artifactKind),
  index("evidence_objects_scope_time_idx")
    .on(table.orgId, table.customerId, table.connectionId, table.createdAt, table.id),
]);

export const evidenceDownloadGrants = sqliteTable("evidence_download_grants", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  objectId: text("object_id").notNull().references(() => evidenceObjects.id),
  actorId: text("actor_id").notNull(),
  purpose: text("purpose", { enum: ["raw_evidence_review", "export_download"] }).notNull(),
  tokenSha256: text("token_sha256").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("evidence_download_grants_token_uq").on(table.tokenSha256),
  index("evidence_download_grants_scope_expiry_idx")
    .on(table.orgId, table.customerId, table.actorId, table.expiresAt),
]);

export const evidenceLocalPayloads = sqliteTable("evidence_local_payloads", {
  objectId: text("object_id").primaryKey().references(() => evidenceObjects.id),
  contentSha256: text("content_sha256").notNull(),
  byteSize: integer("byte_size").notNull(),
  bodyBase64: text("body_base64").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

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
  originKind: text("origin_kind", { enum: ["unknown", "simulated_fixture", "aws_live"] }).notNull().default("unknown"),
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

/**
 * Mutable lifecycle projection over immutable CMDB resource evidence. Missing
 * resources keep pointing at the exact row and snapshot in which they were last
 * observed; no collected configuration or checksum is rewritten.
 */
export const cmdbResourceProjectionStates = sqliteTable("cmdb_resource_projection_states", {
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  resourceKey: text("resource_key").notNull(),
  lifecycleState: text("lifecycle_state", {
    enum: ["active", "retirement_pending", "retired"],
  }).notNull().default("active"),
  consecutiveCompleteMisses: integer("consecutive_complete_misses").notNull().default(0),
  lastObservedResourceId: text("last_observed_resource_id").notNull().references(() => cmdbResources.id),
  lastObservedSnapshotId: text("last_observed_snapshot_id").notNull().references(() => cmdbSnapshots.id),
  firstMissingSnapshotId: text("first_missing_snapshot_id").references(() => cmdbSnapshots.id),
  stateChangedSnapshotId: text("state_changed_snapshot_id").notNull().references(() => cmdbSnapshots.id),
  lastCompleteRunId: text("last_complete_run_id").notNull().references(() => syncRuns.id),
  lastCompleteRunCreatedAt: integer("last_complete_run_created_at", { mode: "timestamp_ms" }).notNull(),
  retirementPendingAt: integer("retirement_pending_at", { mode: "timestamp_ms" }),
  retiredAt: integer("retired_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("cmdb_resource_projection_identity_uq").on(table.orgId, table.connectionId, table.resourceKey),
  index("cmdb_resource_projection_scope_state_idx").on(
    table.orgId,
    table.customerId,
    table.connectionId,
    table.lifecycleState,
    table.resourceKey,
  ),
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
  projectionApplied: integer("projection_applied", { mode: "boolean" }).notNull().default(true),
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
  hashVersion: integer("hash_version").notNull().default(1),
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

/**
 * Manifest-level state for the canonical FinOps billing engine. A refreshed
 * AWS billing period is written under stagingGenerationId and becomes visible
 * only when activeGenerationId is switched after reconciliation.
 */
export const finopsExportPartitions = sqliteTable("finops_export_partitions", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  exportName: text("export_name").notNull(),
  billingPeriod: text("billing_period").notNull(),
  sourceTable: text("source_table").notNull(),
  sourceFormat: text("source_format").notNull(),
  sourceVersion: text("source_version").notNull(),
  status: text("status", { enum: ["staging", "ready", "failed"] }).notNull(),
  manifestBucket: text("manifest_bucket").notNull(),
  manifestKey: text("manifest_key").notNull(),
  manifestSha256: text("manifest_sha256").notNull(),
  schemaSha256: text("schema_sha256").notNull(),
  manifestEtag: text("manifest_etag"),
  manifestVersionId: text("manifest_version_id"),
  sourceUpdatedAt: text("source_updated_at"),
  observedAt: text("observed_at").notNull(),
  activeGenerationId: text("active_generation_id"),
  activeManifestSha256: text("active_manifest_sha256"),
  activeManifestVersionId: text("active_manifest_version_id"),
  activeSourceTable: text("active_source_table"),
  activeSourceFormat: text("active_source_format"),
  activeSourceVersion: text("active_source_version"),
  activeSourceUpdatedAt: text("active_source_updated_at"),
  activeObservedAt: text("active_observed_at"),
  activeAcceptedRows: integer("active_accepted_rows"),
  activeRejectedRows: integer("active_rejected_rows"),
  activeFileCount: integer("active_file_count"),
  activeCurrencyTotalsJson: text("active_currency_totals_json"),
  activeCommittedAt: text("active_committed_at"),
  stagingGenerationId: text("staging_generation_id"),
  stagingManifestSha256: text("staging_manifest_sha256"),
  acceptedRows: integer("accepted_rows").notNull().default(0),
  rejectedRows: integer("rejected_rows").notNull().default(0),
  fileCount: integer("file_count").notNull(),
  columnsJson: text("columns_json").notNull(),
  dataFilesJson: text("data_files_json").notNull(),
  currencyTotalsJson: text("currency_totals_json"),
  lastErrorCode: text("last_error_code"),
  lastErrorAt: text("last_error_at"),
  committedAt: text("committed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("finops_export_partitions_scope_uq")
    .on(table.orgId, table.customerId, table.connectionId, table.exportName, table.billingPeriod),
  index("finops_export_partitions_health_idx")
    .on(table.orgId, table.customerId, table.connectionId, table.status, table.observedAt),
]);

/** Queryable canonical billing facts. canonicalJson preserves every normalized
 * source dimension while common groupings remain indexed columns. */
export const finopsBillingLinesV2 = sqliteTable("finops_billing_lines_v2", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  exportName: text("export_name").notNull(),
  billingPeriod: text("billing_period").notNull(),
  generationId: text("generation_id").notNull(),
  sourceFormat: text("source_format").notNull(),
  sourceVersion: text("source_version").notNull(),
  lineItemId: text("line_item_id").notNull(),
  payerAccountId: text("payer_account_id"),
  usageAccountId: text("usage_account_id").notNull(),
  service: text("service").notNull(),
  productCode: text("product_code"),
  productName: text("product_name"),
  productFamily: text("product_family"),
  resourceId: text("resource_id"),
  resourceType: text("resource_type"),
  region: text("region"),
  availabilityZone: text("availability_zone"),
  operation: text("operation"),
  usageType: text("usage_type"),
  chargeKind: text("charge_kind").notNull(),
  chargeCategory: text("charge_category").notNull(),
  usageStart: text("usage_start").notNull(),
  usageEnd: text("usage_end"),
  amountMicros: text("amount_micros").notNull(),
  netUnblendedCostMicros: text("net_unblended_cost_micros"),
  amortizedMicros: text("amortized_micros"),
  listCostMicros: text("list_cost_micros"),
  contractedCostMicros: text("contracted_cost_micros"),
  publicOnDemandCostMicros: text("public_on_demand_cost_micros"),
  currency: text("currency").notNull(),
  commitmentType: text("commitment_type"),
  commitmentId: text("commitment_id"),
  commitmentExpiry: text("commitment_expiry"),
  invoiceId: text("invoice_id"),
  billingEntity: text("billing_entity"),
  legalEntity: text("legal_entity"),
  tagsJson: text("tags_json").notNull().default("{}"),
  costCategoriesJson: text("cost_categories_json").notNull().default("{}"),
  canonicalJson: text("canonical_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("finops_billing_lines_v2_generation_line_uq")
    .on(table.orgId, table.customerId, table.connectionId, table.exportName, table.billingPeriod, table.generationId, table.lineItemId),
  index("finops_billing_lines_v2_query_idx")
    .on(table.orgId, table.customerId, table.connectionId, table.billingPeriod, table.generationId, table.service, table.usageAccountId),
  index("finops_billing_lines_v2_resource_idx")
    .on(table.orgId, table.customerId, table.connectionId, table.resourceId, table.billingPeriod),
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

/** Immutable normalized data-security classification and exposure publications. */
export const dspmScanRuns = sqliteTable("dspm_scan_runs", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  source: text("source", { enum: ["aws-macie", "agentless-classifier", "normalized-import"] }).notNull(),
  status: text("status", { enum: ["COMPLETE", "PARTIAL"] }).notNull(),
  coverageJson: text("coverage_json").notNull(),
  evidenceSha256: text("evidence_sha256").notNull(),
  assetCount: integer("asset_count").notNull(),
  findingCount: integer("finding_count").notNull(),
  collectedAt: integer("collected_at", { mode: "timestamp_ms" }).notNull(),
  importedBy: text("imported_by").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: timestamp("created_at"),
}, (table) => [
  uniqueIndex("dspm_scan_runs_scope_id_uq").on(table.orgId, table.customerId, table.connectionId, table.id),
  uniqueIndex("dspm_scan_runs_idempotency_uq").on(table.orgId, table.connectionId, table.idempotencyKey),
  index("dspm_scan_runs_scope_time_idx").on(table.orgId, table.customerId, table.connectionId, table.collectedAt, table.id),
]);

export const dspmAssetEvidence = sqliteTable("dspm_asset_evidence", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  scanRunId: text("scan_run_id").notNull().references(() => dspmScanRuns.id),
  resourceKey: text("resource_key").notNull(),
  resourceType: text("resource_type").notNull(),
  region: text("region_key").notNull(),
  classification: text("classification", {
    enum: ["restricted", "confidential", "internal", "public", "unknown"],
  }).notNull(),
  categoriesJson: text("categories_json").notNull(),
  ownerRef: text("owner_ref"),
  encrypted: integer("encrypted", { mode: "boolean" }),
  publicAccess: integer("public_access", { mode: "boolean" }),
  crossAccountAccess: integer("cross_account_access", { mode: "boolean" }),
  externalSharing: integer("external_sharing", { mode: "boolean" }),
  credentialsDetected: integer("credentials_detected", { mode: "boolean" }),
  dataSizeBytes: integer("data_size_bytes"),
  riskScore: integer("risk_score").notNull(),
  riskSeverity: text("risk_severity", {
    enum: ["critical", "high", "medium", "low", "none"],
  }).notNull(),
  riskTitle: text("risk_title"),
  riskFactorsJson: text("risk_factors_json").notNull(),
  recommendationsJson: text("recommendations_json").notNull(),
}, (table) => [
  uniqueIndex("dspm_asset_evidence_run_resource_uq").on(table.scanRunId, table.resourceKey),
  index("dspm_asset_evidence_scope_risk_idx")
    .on(table.orgId, table.customerId, table.connectionId, table.riskSeverity, table.riskScore),
]);

export const dspmScanHeads = sqliteTable("dspm_scan_heads", {
  connectionId: text("connection_id").primaryKey().references(() => awsConnections.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  scanRunId: text("scan_run_id").notNull().references(() => dspmScanRuns.id),
  collectedAt: integer("collected_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  index("dspm_scan_heads_scope_idx").on(table.orgId, table.customerId, table.connectionId),
]);

/** Tenant-bound SCIM provisioning connector; only the token digest is retained. */
export const scimConnectors = sqliteTable("scim_connectors", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  name: text("name").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  tokenSha256: text("token_sha256").notNull(),
  identityIssuer: text("identity_issuer").notNull(),
  subjectSource: text("subject_source", { enum: ["userName", "externalId"] }).notNull(),
  roleMappingsJson: text("role_mappings_json").notNull().default("{}"),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
  lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  rotatedAt: integer("rotated_at", { mode: "timestamp_ms" }),
  revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  createdBy: text("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at"),
}, (table) => [
  uniqueIndex("scim_connectors_token_sha256_uq").on(table.tokenSha256),
  index("scim_connectors_org_created_idx").on(table.orgId, table.createdAt, table.id),
]);

export const scimUserLinks = sqliteTable("scim_user_links", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  connectorId: text("connector_id").notNull().references(() => scimConnectors.id),
  userId: text("user_id").notNull().references(() => users.id),
  externalId: text("external_id"),
  version: integer("version").notNull().default(1),
  mutationNonce: text("mutation_nonce").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
}, (table) => [
  uniqueIndex("scim_user_links_connector_user_uq").on(table.connectorId, table.userId),
  uniqueIndex("scim_user_links_connector_external_uq")
    .on(table.connectorId, table.externalId)
    .where(sql`${table.externalId} IS NOT NULL`),
  index("scim_user_links_scope_idx").on(table.orgId, table.connectorId, table.updatedAt, table.id),
]);

export const scimGroups = sqliteTable("scim_groups", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  connectorId: text("connector_id").notNull().references(() => scimConnectors.id),
  externalId: text("external_id"),
  displayName: text("display_name").notNull(),
  mappedRole: text("mapped_role", { enum: ["viewer", "analyst"] }),
  version: integer("version").notNull().default(1),
  mutationNonce: text("mutation_nonce").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
  deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
}, (table) => [
  uniqueIndex("scim_groups_connector_external_uq")
    .on(table.connectorId, table.externalId)
    .where(sql`${table.externalId} IS NOT NULL`),
  index("scim_groups_scope_name_idx").on(table.orgId, table.connectorId, table.displayName, table.id),
]);

export const scimGroupMembers = sqliteTable("scim_group_members", {
  orgId: text("org_id").notNull().references(() => organizations.id),
  connectorId: text("connector_id").notNull().references(() => scimConnectors.id),
  groupId: text("group_id").notNull().references(() => scimGroups.id),
  scimUserId: text("scim_user_id").notNull().references(() => scimUserLinks.id),
  createdAt: timestamp("created_at"),
}, (table) => [
  uniqueIndex("scim_group_members_group_user_uq").on(table.groupId, table.scimUserId),
  index("scim_group_members_user_idx").on(table.orgId, table.connectorId, table.scimUserId, table.groupId),
]);

/** Append-only SCIM security ledger protected by database immutability triggers. */
export const scimAuditEvents = sqliteTable("scim_audit_events", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  connectorId: text("connector_id").references(() => scimConnectors.id),
  actorType: text("actor_type", { enum: ["user", "scim_connector"] }).notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  outcome: text("outcome").notNull(),
  requestId: text("request_id").notNull(),
  metadataJson: text("metadata_json").notNull().default("{}"),
  occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  uniqueIndex("scim_audit_events_org_request_uq").on(table.orgId, table.requestId),
  index("scim_audit_events_scope_time_idx").on(table.orgId, table.occurredAt, table.id),
]);

/** Immutable, generation-independent tenant KPI goal versions. */
export const finopsKpiGoalVersions = sqliteTable("finops_kpi_goal_versions", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  kpiId: text("kpi_id").notNull(),
  version: integer("version").notNull(),
  targetDirection: text("target_direction", {
    enum: ["higher_is_better", "lower_is_better"],
  }).notNull(),
  targetBasisPoints: integer("target_basis_points").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  effectiveTo: text("effective_to"),
  actorId: text("actor_id").notNull(),
  auditReference: text("audit_reference").notNull(),
  rbacDecisionId: text("rbac_decision_id").notNull(),
  rbacDecision: text("rbac_decision", { enum: ["allow"] }).notNull(),
  rbacAction: text("rbac_action", { enum: ["finops:kpi-goal:write"] }).notNull(),
  rbacResource: text("rbac_resource").notNull(),
  rbacActorId: text("rbac_actor_id").notNull(),
  rbacDecidedAt: text("rbac_decided_at").notNull(),
  rbacPolicyVersion: text("rbac_policy_version").notNull(),
  rbacEvidenceReference: text("rbac_evidence_reference").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("finops_kpi_goal_versions_scope_version_uq")
    .on(table.orgId, table.customerId, table.connectionId, table.kpiId, table.version),
  index("finops_kpi_goal_versions_scope_effective_idx")
    .on(
      table.orgId,
      table.customerId,
      table.connectionId,
      table.kpiId,
      table.effectiveFrom,
      table.effectiveTo,
      table.version,
    ),
]);

/** Immutable organization taxonomy publication; only the head pointer mutates. */
export const finopsTaxonomySnapshots = sqliteTable("finops_taxonomy_snapshots", {
  id: text("id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  version: integer("version").notNull(),
  source: text("source", {
    enum: ["aws_organizations", "operator_map", "cmdb"],
  }).notNull(),
  sourceEvidenceId: text("source_evidence_id").notNull(),
  observedAt: text("observed_at").notNull(),
  createdBy: text("created_by").notNull(),
  auditReference: text("audit_reference").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("finops_taxonomy_snapshots_scope_version_uq")
    .on(table.orgId, table.customerId, table.connectionId, table.version),
  index("finops_taxonomy_snapshots_scope_time_idx")
    .on(
      table.orgId,
      table.customerId,
      table.connectionId,
      table.observedAt,
      table.version,
    ),
]);

export const finopsTaxonomyAssignments = sqliteTable("finops_taxonomy_assignments", {
  snapshotId: text("snapshot_id").notNull().references(() => finopsTaxonomySnapshots.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  accountId: text("account_id").notNull(),
  company: text("company"),
  businessUnit: text("business_unit"),
  environment: text("environment"),
  costCenter: text("cost_center"),
  owner: text("owner"),
}, (table) => [
  uniqueIndex("finops_taxonomy_assignments_snapshot_account_uq")
    .on(table.snapshotId, table.accountId),
  index("finops_taxonomy_assignments_scope_account_idx")
    .on(table.orgId, table.customerId, table.connectionId, table.accountId, table.snapshotId),
]);

export const finopsTaxonomyAllowedValues = sqliteTable("finops_taxonomy_allowed_values", {
  snapshotId: text("snapshot_id").notNull().references(() => finopsTaxonomySnapshots.id),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  dimension: text("dimension", {
    enum: ["company", "business_unit", "environment", "cost_center", "account"],
  }).notNull(),
  value: text("value").notNull(),
}, (table) => [
  uniqueIndex("finops_taxonomy_allowed_values_snapshot_dimension_value_uq")
    .on(table.snapshotId, table.dimension, table.value),
  index("finops_taxonomy_allowed_values_scope_dimension_idx")
    .on(table.orgId, table.customerId, table.connectionId, table.dimension, table.value, table.snapshotId),
]);

export const finopsTaxonomyHeads = sqliteTable("finops_taxonomy_heads", {
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  snapshotId: text("snapshot_id").notNull().references(() => finopsTaxonomySnapshots.id),
  promotedBy: text("promoted_by").notNull(),
  promotedAt: integer("promoted_at").notNull(),
}, (table) => [
  uniqueIndex("finops_taxonomy_heads_scope_uq")
    .on(table.orgId, table.customerId, table.connectionId),
  uniqueIndex("finops_taxonomy_heads_snapshot_uq").on(table.snapshotId),
]);

/**
 * Durable Data Collection Monitor attempt ledger. Identity is immutable after
 * insertion; repository and database guards allow only bounded lifecycle
 * transitions from queued to running to one terminal status.
 */
export const finopsSourceJobAttempts = sqliteTable("finops_source_job_attempts", {
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  sourceId: text("source_id").notNull(),
  jobId: text("job_id").notNull(),
  attempt: integer("attempt").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status", {
    enum: ["queued", "running", "succeeded", "partial", "failed", "cancelled"],
  }).notNull(),
  queuedAt: text("queued_at").notNull(),
  startedAt: text("started_at"),
  finishedAt: text("finished_at"),
  acceptedRecords: integer("accepted_records"),
  rejectedRecords: integer("rejected_records"),
  expectedRecords: integer("expected_records"),
  processedBytes: integer("processed_bytes"),
  reconciliationOutcome: text("reconciliation_outcome", {
    enum: ["matched", "mismatched"],
  }),
  reconciliationEvidenceReference: text("reconciliation_evidence_reference"),
  errorCode: text("error_code", {
    enum: [
      "AUTHORIZATION_FAILED",
      "SOURCE_UNAVAILABLE",
      "THROTTLED",
      "TIMEOUT",
      "SCHEMA_MISMATCH",
      "RECONCILIATION_FAILED",
      "CANCELLED",
      "INTERNAL_ERROR",
    ],
  }),
  errorMessage: text("error_message"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("finops_source_job_attempts_identity_uq")
    .on(
      table.orgId,
      table.customerId,
      table.connectionId,
      table.sourceId,
      table.jobId,
      table.attempt,
    ),
  uniqueIndex("finops_source_job_attempts_scope_idempotency_uq")
    .on(
      table.orgId,
      table.customerId,
      table.connectionId,
      table.sourceId,
      table.idempotencyKey,
    ),
  index("finops_source_job_attempts_scope_page_idx")
    .on(
      table.orgId,
      table.customerId,
      table.connectionId,
      table.queuedAt,
      table.sourceId,
      table.jobId,
      table.attempt,
    ),
  index("finops_source_job_attempts_scope_source_health_idx")
    .on(
      table.orgId,
      table.customerId,
      table.connectionId,
      table.sourceId,
      table.status,
      table.queuedAt,
    ),
]);

/**
 * Immutable normalized source-generation evidence. Provider payloads are never
 * stored here: evidenceReferenceCiphertext is an application-sealed pointer to
 * the private evidence object, and the active head is the only mutable record.
 */
export const finopsSourceSnapshots = sqliteTable("finops_source_snapshots", {
  generationId: text("generation_id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  sourceId: text("source_id").notNull(),
  jobId: text("job_id").notNull(),
  attempt: integer("attempt").notNull(),
  status: text("status", {
    enum: ["ready", "complete", "partial", "failed", "stale"],
  }).notNull(),
  contentSha256: text("content_sha256").notNull(),
  schemaVersion: text("schema_version").notNull(),
  collectedAt: text("collected_at").notNull(),
  dataThroughAt: text("data_through_at").notNull(),
  coverageAssessment: text("coverage_assessment", {
    enum: ["complete", "partial", "unknown"],
  }).notNull(),
  coverageExpectedRecords: integer("coverage_expected_records"),
  coverageObservedRecords: integer("coverage_observed_records").notNull(),
  coverageMissingRecords: integer("coverage_missing_records"),
  reconciliationExpectedRecords: integer("reconciliation_expected_records"),
  reconciliationAcceptedRecords: integer("reconciliation_accepted_records").notNull(),
  reconciliationRejectedRecords: integer("reconciliation_rejected_records").notNull(),
  reconciliationOutcome: text("reconciliation_outcome", {
    enum: ["matched", "mismatched", "not_run"],
  }).notNull(),
  evidenceReferenceCiphertext: text("evidence_reference_ciphertext").notNull(),
  evidenceReferenceKeyVersion: text("evidence_reference_key_version").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("finops_source_snapshots_scope_generation_uq")
    .on(
      table.orgId,
      table.customerId,
      table.connectionId,
      table.sourceId,
      table.generationId,
    ),
  uniqueIndex("finops_source_snapshots_scope_job_attempt_uq")
    .on(
      table.orgId,
      table.customerId,
      table.connectionId,
      table.sourceId,
      table.jobId,
      table.attempt,
    ),
  index("finops_source_snapshots_scope_source_time_idx")
    .on(
      table.orgId,
      table.customerId,
      table.connectionId,
      table.sourceId,
      table.dataThroughAt,
      table.collectedAt,
      table.generationId,
    ),
]);

/** Atomically advanced pointer to the latest accepted generation per source. */
export const finopsSourceSnapshotHeads = sqliteTable("finops_source_snapshot_heads", {
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  connectionId: text("connection_id").notNull().references(() => awsConnections.id),
  sourceId: text("source_id").notNull(),
  activeGenerationId: text("active_generation_id").notNull()
    .references(() => finopsSourceSnapshots.generationId),
  advancedAt: integer("advanced_at").notNull(),
}, (table) => [
  uniqueIndex("finops_source_snapshot_heads_scope_uq")
    .on(table.orgId, table.customerId, table.connectionId, table.sourceId),
  uniqueIndex("finops_source_snapshot_heads_generation_uq")
    .on(table.activeGenerationId),
]);

/** Frozen, server-derived account set for one organizational TA collection. */
export const finopsTaCollectionManifests = sqliteTable("finops_ta_collection_manifests", {
  manifestId: text("manifest_id").primaryKey(),
  orgId: text("org_id").notNull().references(() => organizations.id),
  customerId: text("customer_id").notNull().references(() => customers.id),
  anchorConnectionId: text("anchor_connection_id").notNull().references(() => awsConnections.id),
  jobId: text("job_id").notNull(),
  taxonomySnapshotId: text("taxonomy_snapshot_id").notNull(),
  taxonomySha256: text("taxonomy_sha256").notNull(),
  accountSetSha256: text("account_set_sha256").notNull(),
  expectedAccountCount: integer("expected_account_count").notNull(),
  status: text("status", {
    enum: ["pending", "collecting", "finalizing", "complete", "partial", "failed"],
  }).notNull(),
  createdAt: integer("created_at").notNull(),
  startedAt: integer("started_at"),
  finalizedAt: integer("finalized_at"),
}, (table) => [
  uniqueIndex("finops_ta_manifests_scope_job_uq")
    .on(table.orgId, table.customerId, table.anchorConnectionId, table.jobId),
  index("finops_ta_manifests_scope_time_idx")
    .on(table.orgId, table.customerId, table.anchorConnectionId, table.createdAt, table.manifestId),
]);

/** Membership is append-only; lifecycle fields advance through guarded states. */
export const finopsTaManifestAccounts = sqliteTable("finops_ta_manifest_accounts", {
  manifestId: text("manifest_id").notNull().references(() => finopsTaCollectionManifests.manifestId),
  orgId: text("org_id").notNull(),
  customerId: text("customer_id").notNull(),
  anchorConnectionId: text("anchor_connection_id").notNull(),
  accountId: text("account_id").notNull(),
  accountPosition: integer("account_position").notNull(),
  targetConnectionId: text("target_connection_id").references(() => awsConnections.id),
  status: text("status", {
    enum: ["pending", "running", "accepted", "partial", "failed", "unconfigured"],
  }).notNull(),
  accountSnapshotId: text("account_snapshot_id"),
  errorCode: text("error_code"),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
}, (table) => [
  uniqueIndex("finops_ta_manifest_accounts_identity_uq").on(table.manifestId, table.accountId),
  uniqueIndex("finops_ta_manifest_accounts_position_uq").on(table.manifestId, table.accountPosition),
  index("finops_ta_manifest_accounts_status_idx").on(table.manifestId, table.status, table.accountPosition),
]);

/** Immutable account-level TA evidence header. */
export const finopsTaAccountSnapshots = sqliteTable("finops_ta_account_snapshots", {
  accountSnapshotId: text("account_snapshot_id").primaryKey(),
  manifestId: text("manifest_id").notNull().references(() => finopsTaCollectionManifests.manifestId),
  orgId: text("org_id").notNull(),
  customerId: text("customer_id").notNull(),
  anchorConnectionId: text("anchor_connection_id").notNull(),
  accountId: text("account_id").notNull(),
  status: text("status", { enum: ["complete", "partial"] }).notNull(),
  contentSha256: text("content_sha256").notNull(),
  collectedAt: text("collected_at").notNull(),
  dataThroughAt: text("data_through_at"),
  checkCount: integer("check_count").notNull(),
  resourceCount: integer("resource_count").notNull(),
  rejectedRecordCount: integer("rejected_record_count").notNull(),
  evidenceReferenceCiphertext: text("evidence_reference_ciphertext").notNull(),
  evidenceReferenceKeyVersion: text("evidence_reference_key_version").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("finops_ta_account_snapshots_manifest_account_uq").on(table.manifestId, table.accountId),
]);

/** Immutable check aggregates belonging to an account snapshot. */
export const finopsTaCheckSnapshots = sqliteTable("finops_ta_check_snapshots", {
  accountSnapshotId: text("account_snapshot_id").notNull()
    .references(() => finopsTaAccountSnapshots.accountSnapshotId),
  checkId: text("check_id").notNull(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  status: text("status", { enum: ["ok", "warning", "error", "not_available"] }).notNull(),
  dataThroughAt: text("data_through_at"),
  processedCount: integer("processed_count").notNull(),
  flaggedCount: integer("flagged_count").notNull(),
  ignoredCount: integer("ignored_count").notNull(),
  suppressedCount: integer("suppressed_count").notNull(),
  contentSha256: text("content_sha256").notNull(),
}, (table) => [
  uniqueIndex("finops_ta_check_snapshots_identity_uq").on(table.accountSnapshotId, table.checkId),
]);

/** Immutable resource findings belonging to an accepted check snapshot. */
export const finopsTaResourceSnapshots = sqliteTable("finops_ta_resource_snapshots", {
  resourceKey: text("resource_key").primaryKey(),
  accountSnapshotId: text("account_snapshot_id").notNull()
    .references(() => finopsTaAccountSnapshots.accountSnapshotId),
  checkId: text("check_id").notNull(),
  resourceId: text("resource_id").notNull(),
  region: text("region"),
  status: text("status", { enum: ["ok", "warning", "error"] }).notNull(),
  suppressed: integer("suppressed").notNull(),
  metadataJson: text("metadata_json").notNull(),
  metadataSha256: text("metadata_sha256").notNull(),
}, (table) => [
  uniqueIndex("finops_ta_resource_snapshots_identity_uq")
    .on(table.accountSnapshotId, table.checkId, table.resourceKey),
  index("finops_ta_resources_filter_idx")
    .on(table.accountSnapshotId, table.checkId, table.status, table.region, table.resourceKey),
]);

/** Immutable organization roll-up; partial and failed generations remain history-only. */
export const finopsTaOrganizationSnapshots = sqliteTable("finops_ta_organization_snapshots", {
  generationId: text("generation_id").primaryKey(),
  manifestId: text("manifest_id").notNull().references(() => finopsTaCollectionManifests.manifestId),
  orgId: text("org_id").notNull(),
  customerId: text("customer_id").notNull(),
  anchorConnectionId: text("anchor_connection_id").notNull(),
  status: text("status", { enum: ["complete", "partial", "failed"] }).notNull(),
  contentSha256: text("content_sha256").notNull(),
  collectedAt: text("collected_at").notNull(),
  dataThroughAt: text("data_through_at"),
  expectedAccountCount: integer("expected_account_count").notNull(),
  acceptedAccountCount: integer("accepted_account_count").notNull(),
  rejectedAccountCount: integer("rejected_account_count").notNull(),
  checkCount: integer("check_count").notNull(),
  resourceCount: integer("resource_count").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  uniqueIndex("finops_ta_org_snapshots_manifest_uq").on(table.manifestId),
  index("finops_ta_org_snapshots_history_idx")
    .on(table.orgId, table.customerId, table.anchorConnectionId, table.collectedAt, table.generationId),
]);

/** Mutable only through monotonic advancement to a complete generation. */
export const finopsTaOrganizationSnapshotHeads = sqliteTable("finops_ta_organization_snapshot_heads", {
  orgId: text("org_id").notNull(),
  customerId: text("customer_id").notNull(),
  anchorConnectionId: text("anchor_connection_id").notNull(),
  activeGenerationId: text("active_generation_id").notNull()
    .references(() => finopsTaOrganizationSnapshots.generationId),
  advancedAt: integer("advanced_at").notNull(),
}, (table) => [
  uniqueIndex("finops_ta_org_snapshot_heads_scope_uq")
    .on(table.orgId, table.customerId, table.anchorConnectionId),
  uniqueIndex("finops_ta_org_snapshot_heads_generation_uq").on(table.activeGenerationId),
]);
