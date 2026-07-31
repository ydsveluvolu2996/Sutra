#!/usr/bin/env bash
set -euo pipefail

readonly INACTIVE="inactive-before-first-migration"
readonly ACTIVE="active-after-successful-migration"
readonly SES_INACTIVE="disabled-ses-production-access-denied"
readonly TEMPLATE="infrastructure/production-ha.yaml"
readonly CUSTOMER_ROLE_TEMPLATE_VERSION="standard-2026-07.4"
readonly CUSTOMER_ROLE_TEMPLATE_SHA256="1f08f008ab024bc9c440340340e7a7cfbad7ed394e6704c3df7173766f727fc8"

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

require_value() {
  local name="$1"
  [[ -n "${!name:-}" ]] || fail "${name} is required."
}

for name in AWS_ACCOUNT_ID AWS_REGION STACK_NAME CFN_EXECUTION_ROLE_ARN \
  APP_IMAGE WORKER_IMAGE BROKER_IMAGE SCANNER_IMAGE GITHUB_SHA GITHUB_RUN_ID GITHUB_RUN_ATTEMPT
do
  require_value "${name}"
done

[[ "${AWS_ACCOUNT_ID}" =~ ^[0-9]{12}$ ]] || fail "AWS_ACCOUNT_ID must be a 12-digit account ID."
[[ "${AWS_REGION}" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$ ]] || fail "AWS_REGION is invalid."
[[ "${STACK_NAME}" =~ ^[A-Za-z][A-Za-z0-9-]{2,127}$ ]] || fail "STACK_NAME is invalid."
[[ "${CFN_EXECUTION_ROLE_ARN}" =~ ^arn:aws:iam::${AWS_ACCOUNT_ID}:role/[A-Za-z0-9+=,.@_/-]+$ ]] ||
  fail "CFN_EXECUTION_ROLE_ARN must be a role in the approved account."
[[ "${GITHUB_SHA}" =~ ^[a-f0-9]{40}$ ]] || fail "GITHUB_SHA must be a full commit SHA."
[[ "${GITHUB_RUN_ID}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT}" =~ ^[0-9]+$ ]] ||
  fail "GitHub run identity is invalid."

readonly REGISTRY_PATTERN="${AWS_ACCOUNT_ID}\\.dkr\\.ecr\\.${AWS_REGION}\\.amazonaws\\.com"
[[ "${APP_IMAGE}" =~ ^${REGISTRY_PATTERN}/sutra/app@sha256:[a-f0-9]{64}$ ]] ||
  fail "APP_IMAGE must be an immutable digest in the approved app repository."
[[ "${WORKER_IMAGE}" =~ ^${REGISTRY_PATTERN}/sutra/notification-worker@sha256:[a-f0-9]{64}$ ]] ||
  fail "WORKER_IMAGE must be an immutable digest in the approved worker repository."
[[ "${BROKER_IMAGE}" =~ ^${REGISTRY_PATTERN}/sutra/broker@sha256:[a-f0-9]{64}$ ]] ||
  fail "BROKER_IMAGE must be an immutable digest in the approved broker repository."
[[ "${SCANNER_IMAGE}" =~ ^${REGISTRY_PATTERN}/sutra/agentless-scanner@sha256:[a-f0-9]{64}$ ]] ||
  fail "SCANNER_IMAGE must be an immutable digest in the approved scanner repository."

readonly RUN_MARKER="sutra-bootstrap-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
readonly CHANGE_SET_NAME="sutra-bootstrap-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
readonly PARAMETER_FILE="${RUNNER_TEMP:-/tmp}/sutra-ha-parameters-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.json"
readonly STACK_FILE="${RUNNER_TEMP:-/tmp}/sutra-ha-stack-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.json"
readonly SIGNAL_FILE="${RUNNER_TEMP:-/tmp}/sutra-ha-signal-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.json"
readonly TEMPLATE_OBJECT_KEY="templates/${GITHUB_SHA}/production-ha-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.yaml"

stack_output() {
  local key="$1"
  jq -er --arg key "${key}" \
    '.Stacks[0].Outputs[] | select(.OutputKey == $key) | .OutputValue' "${STACK_FILE}"
}

refresh_stack() {
  aws cloudformation describe-stacks \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --output json > "${STACK_FILE}"
  [[ "$(jq -r '.Stacks | length' "${STACK_FILE}")" == "1" ]] ||
    fail "Expected exactly one managed-production stack."
}

stack_parameter() {
  local key="$1"
  jq -er --arg key "${key}" \
    '.Stacks[0].Parameters[] | select(.ParameterKey == $key) | .ParameterValue' "${STACK_FILE}"
}

validate_stack_identity() {
  [[ "${RUNTIME_SECRET_VERSION_ID:-}" =~ ^[A-Za-z0-9-]{32,64}$ ]] ||
    fail "Validated runtime secret version identity is unavailable."
  [[ "$(stack_parameter ApplicationRuntimeSecretVersionId)" == "${RUNTIME_SECRET_VERSION_ID}" ]] ||
    fail "Stack application runtime secret version is not the semantically validated version."
  [[ "$(stack_output PublicOrigin)" == "${PUBLIC_ORIGIN}" ]] ||
    fail "Stack PublicOrigin does not match the protected environment."
  [[ "$(stack_output ReleaseActivation)" == "$(stack_parameter ReleaseActivation)" ]] ||
    fail "ReleaseActivation output and parameter disagree."
  [[ "$(stack_output CustomerRoleTemplateUrl)" == "$(stack_parameter CustomerRoleTemplateUrl)" ]] ||
    fail "CustomerRoleTemplateUrl output and parameter disagree."
  [[ "$(stack_parameter NotificationSesActivation)" == "${SES_INACTIVE}" ]] ||
    fail "Bootstrap must keep SES notifications disabled while production access is denied."
  [[ "$(stack_output NotificationSesActivation)" == "${SES_INACTIVE}" ]] ||
    fail "NotificationSesActivation output is not fail-closed."
  [[ "$(stack_parameter AgentlessScannerImage)" == "${SCANNER_IMAGE}" ]] ||
    fail "Stack AgentlessScannerImage does not match the workflow-controlled scanner digest."
  [[ "$(stack_output KmsKeyArn)" =~ ^arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:key/[0-9a-f-]{36}$ ]] ||
    fail "Stack KMS output is outside the approved account and region."
}

assert_task_image() {
  local task_definition="$1" expected_image="$2"
  shift 2
  local expected_names
  expected_names="$(printf '%s\n' "$@" | jq -Rsc 'split("\n")[:-1] | sort')"
  aws ecs describe-task-definition \
    --region "${AWS_REGION}" \
    --task-definition "${task_definition}" \
    --query taskDefinition \
    --output json |
    jq -e --arg image "${expected_image}" --argjson names "${expected_names}" '
      ([.containerDefinitions[] | select(.name as $name | $names | index($name) != null)] | length)
        == ($names | length)
      and all(
        .containerDefinitions[];
        if (.name as $name | $names | index($name) != null)
        then .image == $image
        else true
        end
      )
    ' >/dev/null
}

assert_broker_scanner_image() {
  local task_definition="$1"
  aws ecs describe-task-definition \
    --region "${AWS_REGION}" \
    --task-definition "${task_definition}" \
    --query taskDefinition \
    --output json |
    jq -e --arg scannerImage "${SCANNER_IMAGE}" '
      ([.containerDefinitions[]
        | select(.name == "hosted-broker")
        | .environment[]?
        | select(.name == "SUTRA_AGENTLESS_SCANNER_IMAGE")] | length) == 1
      and ([.containerDefinitions[]
        | select(.name == "hosted-broker")
        | .environment[]?
        | select(.name == "SUTRA_AGENTLESS_SCANNER_IMAGE" and .value == $scannerImage)]
        | length) == 1
    ' >/dev/null
}

assert_task_runtime_secret_version() {
  local task_definition="$1" runtime_secret_arn runtime_secret_version
  runtime_secret_arn="$(stack_parameter ApplicationRuntimeSecretArn)"
  runtime_secret_version="$(stack_parameter ApplicationRuntimeSecretVersionId)"
  aws ecs describe-task-definition \
    --region "${AWS_REGION}" \
    --task-definition "${task_definition}" \
    --query taskDefinition \
    --output json |
    jq -e \
      --arg runtimeSecretArn "${runtime_secret_arn}" \
      --arg runtimeSecretVersion "${runtime_secret_version}" '
        [.containerDefinitions[].secrets[]?
          | select((.name | startswith("SUTRA_DB_")) | not)
        ] as $runtimeSecretEntries
        | ($runtimeSecretEntries | length) > 0
        and all(
          $runtimeSecretEntries[];
          (.valueFrom | startswith($runtimeSecretArn + ":"))
          and (.valueFrom | endswith("::" + $runtimeSecretVersion))
        )
      ' >/dev/null ||
    fail "Task definition does not pin every application runtime secret to the validated version."
}

assert_exact_images() {
  local app_task feed_task worker_task broker_task
  app_task="$(stack_output AppTaskDefinitionArn)"
  feed_task="$(stack_output VulnerabilityFeedTaskDefinitionArn)"
  worker_task="$(stack_output WorkerTaskDefinitionArn)"
  broker_task="$(stack_output BrokerTaskDefinitionArn)"
  assert_task_image "${app_task}" "${APP_IMAGE}" \
    app background-job-runner
  assert_task_image "$(stack_output MigrationTaskDefinitionArn)" "${APP_IMAGE}" migrate
  assert_task_image "${worker_task}" "${WORKER_IMAGE}" notification-worker
  assert_task_image "${broker_task}" "${BROKER_IMAGE}" hosted-broker
  assert_broker_scanner_image "${broker_task}"
  assert_task_image "${feed_task}" "${APP_IMAGE}" \
    vulnerability-feed-refresh
  assert_task_runtime_secret_version "${app_task}"
  assert_task_runtime_secret_version "${worker_task}"
  assert_task_runtime_secret_version "${broker_task}"
  assert_task_runtime_secret_version "${feed_task}"
}

assert_inactive() {
  local cluster services schedule_rule
  cluster="$(stack_output ClusterName)"
  services="$(
    jq -cn \
      --arg app "$(stack_output ServiceName)" \
      --arg worker "$(stack_output WorkerServiceName)" \
      --arg broker "$(stack_output BrokerServiceName)" \
      '[$app,$worker,$broker]'
  )"
  aws ecs describe-services \
    --region "${AWS_REGION}" \
    --cluster "${cluster}" \
    --services "$(jq -r '.[0]' <<< "${services}")" \
      "$(jq -r '.[1]' <<< "${services}")" \
      "$(jq -r '.[2]' <<< "${services}")" \
    --output json |
    jq -e --argjson expected "${services}" '
      (.failures | length) == 0
      and ([.services[].serviceName] | sort) == ($expected | sort)
      and all(.services[]; .desiredCount == 0 and .runningCount == 0 and .pendingCount == 0)
    ' >/dev/null
  schedule_rule="$(stack_output VulnerabilityFeedScheduleRuleName)"
  [[ "$(aws events describe-rule --region "${AWS_REGION}" --name "${schedule_rule}" \
    --query State --output text)" == "DISABLED" ]] ||
    fail "The vulnerability-feed schedule was not disabled before migration."
  for service in $(jq -r '.[]' <<< "${services}"); do
    [[ "$(aws ecs list-tasks --region "${AWS_REGION}" --cluster "${cluster}" \
      --service-name "${service}" --desired-status RUNNING --query 'length(taskArns)' --output text)" == "0" ]] ||
      fail "A managed-production service started before migration."
  done
}

validate_network_firewall() {
  local firewall_arn="$1" expected_vpc="$2" firewall
  [[ "${firewall_arn}" =~ ^arn:aws:network-firewall:${AWS_REGION}:${AWS_ACCOUNT_ID}:firewall/sutra-production-egress-inspection$ ]] ||
    fail "The production Network Firewall ARN is outside the approved boundary."
  [[ "${expected_vpc}" =~ ^vpc-[0-9a-f]{8,17}$ ]] ||
    fail "The expected production VPC ID is invalid."
  firewall="$(
    aws network-firewall describe-firewall \
      --region "${AWS_REGION}" \
      --firewall-arn "${firewall_arn}" \
      --output json
  )"
  jq -e --arg arn "${firewall_arn}" --arg vpc "${expected_vpc}" '
    .Firewall.FirewallArn == $arn
    and .Firewall.FirewallName == "sutra-production-egress-inspection"
    and .Firewall.VpcId == $vpc
    and .Firewall.DeleteProtection == true
    and .Firewall.FirewallPolicyChangeProtection == true
    and .Firewall.SubnetChangeProtection == true
    and (.Firewall.SubnetMappings | length) == 2
    and .FirewallStatus.Status == "READY"
    and (.FirewallStatus.SyncStates | length) == 2
    and all(.FirewallStatus.SyncStates[]; .Attachment.Status == "READY")
  ' <<< "${firewall}" >/dev/null ||
    fail "The production Network Firewall is not protected and READY in both exact Availability Zones."
}

write_outputs() {
  [[ -n "${GITHUB_OUTPUT:-}" ]] || return 0
  {
    printf 'app_image=%s\n' "${APP_IMAGE}"
    printf 'worker_image=%s\n' "${WORKER_IMAGE}"
    printf 'broker_image=%s\n' "${BROKER_IMAGE}"
    printf 'scanner_image=%s\n' "${SCANNER_IMAGE}"
    printf 'runtime_secret_version_id=%s\n' "${RUNTIME_SECRET_VERSION_ID}"
    printf 'load_balancer_dns=%s\n' "$(stack_output LoadBalancerDnsName)"
    printf 'broker_load_balancer_dns=%s\n' "$(stack_output BrokerLoadBalancerDnsName)"
    printf 'public_origin=%s\n' "$(stack_output PublicOrigin)"
  } >> "${GITHUB_OUTPUT}"
}

build_phase_parameter_file() {
  local phase="$1"
  refresh_stack
  jq --arg phase "${phase}" '
    [.Stacks[0].Parameters[] |
      if .ParameterKey == "ReleaseActivation"
      then {ParameterKey:.ParameterKey,ParameterValue:$phase}
      else {ParameterKey:.ParameterKey,UsePreviousValue:true}
      end
    ]
  ' "${STACK_FILE}" > "${PARAMETER_FILE}"
}

update_phase() {
  local phase="$1"
  build_phase_parameter_file "${phase}"
  aws cloudformation update-stack \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --use-previous-template \
    --parameters "file://${PARAMETER_FILE}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --role-arn "${CFN_EXECUTION_ROLE_ARN}" \
    --output json >/dev/null
  aws cloudformation wait stack-update-complete \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}"
  refresh_stack
  [[ "$(stack_parameter ReleaseActivation)" == "${phase}" ]] ||
    fail "CloudFormation did not persist the requested release activation state."
}

begin_activation() {
  build_phase_parameter_file "${ACTIVE}"
  aws cloudformation update-stack \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --use-previous-template \
    --parameters "file://${PARAMETER_FILE}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --role-arn "${CFN_EXECUTION_ROLE_ARN}" \
    --output json >/dev/null
}

find_activation_handle() {
  local attempt physical_id
  for attempt in $(seq 1 60); do
    physical_id="$(
      aws cloudformation describe-stack-resource \
        --region "${AWS_REGION}" \
        --stack-name "${STACK_NAME}" \
        --logical-resource-id ActivationVerificationHandle \
        --query StackResourceDetail.PhysicalResourceId \
        --output text 2>/dev/null || true
    )"
    if [[ "${physical_id}" =~ ^https:// ]]; then
      printf '%s\n' "${physical_id}"
      return 0
    fi
    sleep 5
  done
  fail "CloudFormation did not publish the activation verification handle."
}

signal_activation() {
  local status="$1" reason="$2"
  [[ "${status}" == "SUCCESS" || "${status}" == "FAILURE" ]] ||
    fail "Invalid CloudFormation activation signal status."
  [[ "${activation_handle:-}" =~ ^https:// ]] ||
    fail "Activation verification handle is unavailable."
  jq -n \
    --arg status "${status}" \
    --arg reason "${reason}" \
    --arg uniqueId "${RUN_MARKER}" \
    --arg data "${GITHUB_SHA}" \
    '{Status:$status,Reason:$reason,UniqueId:$uniqueId,Data:$data}' > "${SIGNAL_FILE}"
  curl --fail --silent --show-error \
    --config <(printf 'url = "%s"\n' "${activation_handle}") \
    --request PUT \
    --header "Content-Type:" \
    --data-binary "@${SIGNAL_FILE}"
}

prepare_stack_parameters() {
  require_value PRODUCTION_HA_PARAMETERS_JSON
  jq -e '
    . as $parameters
    | [
        "VpcId",
        "VpcCidr",
        "PublicSubnetIds",
        "PrivateAppSubnetIds",
        "PrivateDatabaseSubnetIds",
        "AlbIngressPrefixListId",
        "ApprovedHttpsEgressPrefixListId",
        "S3GatewayPrefixListId",
        "EndpointSecurityGroupId",
        "NetworkFirewallArn",
        "CertificateArn",
        "BrokerHostName",
        "AgentlessScanAvailabilityZone",
        "AgentlessKmsKeyArn",
        "AgentlessOrchestratorRoleArn",
        "AgentlessAmiId",
        "AgentlessInstanceType",
        "AgentlessSubnetId",
        "AgentlessSecurityGroupId",
        "AgentlessInstanceProfileArn",
        "AgentlessFindingsBucket",
        "HostedReleaseApproval",
        "HostedRuntimeArchitectureApproval",
        "ApplicationRuntimeSecretArn",
        "CustomerRoleTemplateUrl",
        "IdentityMode",
        "KmsKeyArn",
        "MinimumTaskCount",
        "MaximumTaskCount",
        "DatabaseEngineVersion",
        "DatabaseParameterGroupFamily",
        "DatabaseInstanceClass",
        "EnableBackupVaultLock",
        "EnableWaf",
        "WafClientIpHeader",
        "EnableContainerInsights",
        "GitHubOidcProviderArn",
        "NotificationSesIdentityArn"
      ] as $required
    |
    type == "object"
    and all(to_entries[]; (.value | type) == "string" or (.value | type) == "number")
    and all($required[] as $key; $parameters | has($key))
    and (has("SutraAppImage") | not)
    and (has("SutraMigrationImage") | not)
    and (has("NotificationWorkerImage") | not)
    and (has("HostedBrokerImage") | not)
    and (has("AgentlessScannerImage") | not)
    and (has("ApplicationRuntimeSecretVersionId") | not)
    and (has("ReleaseActivation") | not)
    and (has("NotificationSesActivation") | not)
    and (has("PublicOrigin") | not)
    and (has("GitHubRepository") | not)
    and (has("GitHubReleaseEnvironment") | not)
  ' <<< "${PRODUCTION_HA_PARAMETERS_JSON}" >/dev/null ||
    fail "PRODUCTION_HA_PARAMETERS_JSON is missing a required parameter or contains a release-controlled key."
  jq -e \
    --arg account "${AWS_ACCOUNT_ID}" \
    --arg region "${AWS_REGION}" '
      . as $parameters
      | ($parameters.KmsKeyArn | startswith("arn:aws:kms:\($region):\($account):key/"))
      and ($parameters.CertificateArn | startswith("arn:aws:acm:\($region):\($account):certificate/"))
      and ($parameters.ApplicationRuntimeSecretArn | startswith("arn:aws:secretsmanager:\($region):\($account):secret:sutra/production/runtime-"))
      and ($parameters.NotificationSesIdentityArn | startswith("arn:aws:ses:\($region):\($account):identity/"))
      and ($parameters.NetworkFirewallArn == "arn:aws:network-firewall:\($region):\($account):firewall/sutra-production-egress-inspection")
      and ($parameters.GitHubOidcProviderArn == "arn:aws:iam::\($account):oidc-provider/token.actions.githubusercontent.com")
      and ($parameters.AgentlessKmsKeyArn | startswith("arn:aws:kms:\($region):\($account):key/"))
      and ($parameters.AgentlessOrchestratorRoleArn | startswith("arn:aws:iam::\($account):role/sutra/"))
      and ($parameters.AgentlessInstanceProfileArn | startswith("arn:aws:iam::\($account):instance-profile/sutra/"))
    ' <<< "${PRODUCTION_HA_PARAMETERS_JSON}" >/dev/null ||
    fail "A protected stack parameter is outside the approved account or region."
  jq -e '
      .CustomerRoleTemplateUrl as $url
      | ($url | type == "string")
      and ($url | test(
        "^https://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\\.s3\\.ap-south-1\\.amazonaws\\.com/templates/standard-2026-07\\.4/1f08f008ab024bc9c440340340e7a7cfbad7ed394e6704c3df7173766f727fc8\\.yaml\\?versionId=[A-Za-z0-9._~%+=/-]{1,256}$"
      ))
      and ($url | endswith("?versionId=null") | not)
    ' <<< "${PRODUCTION_HA_PARAMETERS_JSON}" >/dev/null ||
    fail "CustomerRoleTemplateUrl must be the versionId-qualified ap-south-1 S3 object for the exact reviewed template version and SHA-256."
  jq --arg runtimeSecretVersion "${RUNTIME_SECRET_VERSION_ID}" '
      (. + {
        SutraAppImage:env.APP_IMAGE,
        SutraMigrationImage:env.APP_IMAGE,
        NotificationWorkerImage:env.WORKER_IMAGE,
        HostedBrokerImage:env.BROKER_IMAGE,
        AgentlessScannerImage:env.SCANNER_IMAGE,
        ApplicationRuntimeSecretVersionId:$runtimeSecretVersion,
        ReleaseActivation:"inactive-before-first-migration",
        NotificationSesActivation:"disabled-ses-production-access-denied",
        PublicOrigin:env.PUBLIC_ORIGIN,
        GitHubRepository:env.GITHUB_REPOSITORY,
        GitHubReleaseEnvironment:"production-ha-release"
      })
      | to_entries
      | sort_by(.key)
      | map({ParameterKey:.key,ParameterValue:(.value | tostring)})
    ' <<< "${PRODUCTION_HA_PARAMETERS_JSON}" > "${PARAMETER_FILE}"
}

validate_runtime_secret() {
  local expected_version_id="${1:-}" runtime_secret_arn identity_mode version_id
  if [[ -n "${PRODUCTION_HA_PARAMETERS_JSON:-}" ]]; then
    runtime_secret_arn="$(jq -er '.ApplicationRuntimeSecretArn' <<< "${PRODUCTION_HA_PARAMETERS_JSON}")"
    identity_mode="$(jq -er '.IdentityMode' <<< "${PRODUCTION_HA_PARAMETERS_JSON}")"
  else
    runtime_secret_arn="$(stack_parameter ApplicationRuntimeSecretArn)"
    identity_mode="$(stack_parameter IdentityMode)"
  fi
  [[ "${identity_mode}" == "oidc" || "${identity_mode}" == "federated" ]] ||
    fail "The protected stack identity mode is invalid."
  version_id="$(
    aws secretsmanager get-secret-value \
      --region "${AWS_REGION}" \
      --secret-id "${runtime_secret_arn}" \
      --version-stage AWSCURRENT \
      --query VersionId \
      --output text
  )"
  [[ "${version_id}" =~ ^[A-Za-z0-9-]{32,64}$ ]] ||
    fail "Secrets Manager returned an invalid AWSCURRENT version identity."
  if [[ -n "${expected_version_id}" && "${version_id}" != "${expected_version_id}" ]]; then
    fail "The production runtime secret AWSCURRENT version changed after preparation."
  fi
  aws secretsmanager get-secret-value \
    --region "${AWS_REGION}" \
    --secret-id "${runtime_secret_arn}" \
    --version-id "${version_id}" \
    --version-stage AWSCURRENT \
    --query SecretString \
    --output text |
    SUTRA_EXPECTED_IDENTITY_MODE="${identity_mode}" \
      node scripts/validate-production-runtime-secret.mjs >/dev/null ||
    fail "The production runtime secret failed semantic validation."
  RUNTIME_SECRET_VERSION_ID="${version_id}"
}

describe_existing_stack() {
  local error_file="${RUNNER_TEMP:-/tmp}/sutra-ha-describe-error-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.txt"
  if aws cloudformation describe-stacks \
      --region "${AWS_REGION}" \
      --stack-name "${STACK_NAME}" \
      --output json > "${STACK_FILE}" 2> "${error_file}"
  then
    printf '%s\n' "UPDATE"
    return 0
  fi
  if grep -Fq "does not exist" "${error_file}"; then
    printf '%s\n' "CREATE"
    return 0
  fi
  sed -E 's/[[:space:]]+/ /g' "${error_file}" >&2
  fail "Unable to determine whether the managed-production stack exists."
}

apply_inactive_stack() {
  local change_type status reason
  change_type="$(describe_existing_stack)"
  if [[ "${change_type}" == "UPDATE" ]]; then
    status="$(jq -r '.Stacks[0].StackStatus' "${STACK_FILE}")"
    [[ "${status}" == "CREATE_COMPLETE" || "${status}" == "UPDATE_COMPLETE" ||
      "${status}" == "UPDATE_ROLLBACK_COMPLETE" ]] ||
      fail "Existing stack is not in a stable updateable state: ${status}."
    [[ "$(stack_parameter ReleaseActivation)" == "${INACTIVE}" ]] ||
      fail "First-deployment bootstrap refuses to mutate an active production stack."
  fi

  aws cloudformation create-change-set \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --change-set-name "${CHANGE_SET_NAME}" \
    --change-set-type "${change_type}" \
    --template-url "${TEMPLATE_URL}" \
    --parameters "file://${PARAMETER_FILE}" \
    --capabilities CAPABILITY_NAMED_IAM \
    --role-arn "${CFN_EXECUTION_ROLE_ARN}" \
    --description "Dormant managed-production bootstrap for ${GITHUB_SHA}" \
    --tags Key=sutra:environment,Value=production Key=sutra:bootstrap-sha,Value="${GITHUB_SHA}" \
    --output json >/dev/null

  if ! aws cloudformation wait change-set-create-complete \
      --region "${AWS_REGION}" \
      --stack-name "${STACK_NAME}" \
      --change-set-name "${CHANGE_SET_NAME}"
  then
    read -r status reason < <(
      aws cloudformation describe-change-set \
        --region "${AWS_REGION}" \
        --stack-name "${STACK_NAME}" \
        --change-set-name "${CHANGE_SET_NAME}" \
        --query '[Status,StatusReason]' \
        --output text
    )
    if [[ "${change_type}" == "UPDATE" && "${status}" == "FAILED" &&
      "${reason}" == *"didn't contain changes"* ]]
    then
      refresh_stack
      return 0
    fi
    fail "CloudFormation change set was not executable: ${status} ${reason}"
  fi

  [[ "$(aws cloudformation describe-change-set \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --change-set-name "${CHANGE_SET_NAME}" \
    --query Status --output text)" == "CREATE_COMPLETE" ]] ||
    fail "CloudFormation change set was not ready to execute."
  aws cloudformation execute-change-set \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --change-set-name "${CHANGE_SET_NAME}"
  if [[ "${change_type}" == "CREATE" ]]; then
    aws cloudformation wait stack-create-complete \
      --region "${AWS_REGION}" \
      --stack-name "${STACK_NAME}"
  else
    aws cloudformation wait stack-update-complete \
      --region "${AWS_REGION}" \
      --stack-name "${STACK_NAME}"
  fi
  refresh_stack
}

upload_stack_template() {
  local kms_key expected_checksum result
  require_value CFN_TEMPLATE_BUCKET
  [[ "${CFN_TEMPLATE_BUCKET}" == "sutra-production-ha-bootstrap-templates-${AWS_ACCOUNT_ID}-${AWS_REGION}" ]] ||
    fail "CFN_TEMPLATE_BUCKET is outside the approved production boundary."
  kms_key="$(jq -er '.KmsKeyArn' <<< "${PRODUCTION_HA_PARAMETERS_JSON}")"
  expected_checksum="$(
    openssl dgst -sha256 -binary "${TEMPLATE}" |
      base64 |
      tr -d '\n'
  )"
  result="$(
    aws s3api put-object \
      --region "${AWS_REGION}" \
      --bucket "${CFN_TEMPLATE_BUCKET}" \
      --key "${TEMPLATE_OBJECT_KEY}" \
      --body "${TEMPLATE}" \
      --server-side-encryption aws:kms \
      --ssekms-key-id "${kms_key}" \
      --content-type application/yaml \
      --checksum-algorithm SHA256 \
      --metadata "commit=${GITHUB_SHA},run-id=${GITHUB_RUN_ID},run-attempt=${GITHUB_RUN_ATTEMPT}" \
      --output json
  )"
  [[ "$(jq -r '.ChecksumSHA256' <<< "${result}")" == "${expected_checksum}" ]] ||
    fail "S3 did not acknowledge the exact production template checksum."
  TEMPLATE_URL="https://${CFN_TEMPLATE_BUCKET}.s3.${AWS_REGION}.amazonaws.com/${TEMPLATE_OBJECT_KEY}"
  readonly TEMPLATE_URL
}

run_migration() {
  local cluster migration_task network migration migration_arn migration_result
  cluster="$(stack_output ClusterName)"
  migration_task="$(stack_output MigrationTaskDefinitionArn)"
  network="$(
    jq -cn \
      --arg subnets "$(stack_output PrivateAppSubnetIds)" \
      --arg sg "$(stack_output ApplicationSecurityGroupId)" '
      {awsvpcConfiguration:{
        subnets:($subnets | split(",")),
        securityGroups:[$sg],
        assignPublicIp:"DISABLED"
      }}
    '
  )"
  migration="$(
    aws ecs run-task \
      --region "${AWS_REGION}" \
      --cluster "${cluster}" \
      --launch-type FARGATE \
      --task-definition "${migration_task}" \
      --network-configuration "${network}" \
      --started-by "${RUN_MARKER}" \
      --output json
  )"
  jq -e '(.failures | length) == 0 and (.tasks | length) == 1' <<< "${migration}" >/dev/null ||
    fail "ECS refused the first-deployment migration task."
  migration_arn="$(jq -er '.tasks[0].taskArn' <<< "${migration}")"
  aws ecs wait tasks-stopped \
    --region "${AWS_REGION}" \
    --cluster "${cluster}" \
    --tasks "${migration_arn}"
  migration_result="$(
    aws ecs describe-tasks \
      --region "${AWS_REGION}" \
      --cluster "${cluster}" \
      --tasks "${migration_arn}" \
      --output json
  )"
  jq -e --arg marker "${RUN_MARKER}" '
    (.failures | length) == 0
    and (.tasks | length) == 1
    and .tasks[0].startedBy == $marker
    and ([.tasks[0].containers[] | select(.name == "migrate" and .exitCode == 0)] | length) == 1
  ' <<< "${migration_result}" >/dev/null ||
    fail "The first-deployment migration did not finish successfully."
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    printf 'migration_task_arn=%s\n' "${migration_arn}" >> "${GITHUB_OUTPUT}"
  fi
}

prepare() {
  require_value PUBLIC_ORIGIN
  require_value GITHUB_REPOSITORY
  [[ "${GITHUB_REPOSITORY}" == "ydsveluvolu2996/Sutra" ]] ||
    fail "The bootstrap workflow is restricted to the approved repository."
  [[ "${PUBLIC_ORIGIN}" == "https://www.sutracmdb.com" ]] ||
    fail "PUBLIC_ORIGIN must be the canonical managed-production origin."
  [[ "$(aws sts get-caller-identity --query Account --output text)" == "${AWS_ACCOUNT_ID}" ]] ||
    fail "AWS credentials are not for the approved production account."
  validate_runtime_secret
  prepare_stack_parameters
  validate_network_firewall \
    "$(jq -er '.NetworkFirewallArn' <<< "${PRODUCTION_HA_PARAMETERS_JSON}")" \
    "$(jq -er '.VpcId' <<< "${PRODUCTION_HA_PARAMETERS_JSON}")"
  upload_stack_template
  apply_inactive_stack
  aws cloudformation update-termination-protection \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --enable-termination-protection >/dev/null
  refresh_stack
  [[ "$(jq -r '.Stacks[0].EnableTerminationProtection' "${STACK_FILE}")" == "true" ]] ||
    fail "Termination protection was not enabled."
  validate_stack_identity
  [[ "$(stack_parameter ReleaseActivation)" == "${INACTIVE}" ]] ||
    fail "The stack was not created in the inactive bootstrap phase."
  assert_exact_images
  assert_inactive
  validate_runtime_secret "${RUNTIME_SECRET_VERSION_ID}"
  run_migration
  assert_inactive
  write_outputs

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      printf '%s\n' "## Dormant managed-production stack is migration-ready"
      printf '\n'
      printf '%s\n' "- Public ALB DNS: \`$(stack_output LoadBalancerDnsName)\`"
      printf '%s\n' "- Internal broker ALB DNS: \`$(stack_output BrokerLoadBalancerDnsName)\`"
      printf '%s\n' "- Public origin: \`$(stack_output PublicOrigin)\`"
      printf '\n'
      printf '%s\n' "Before approving the activation job, point the approved Cloudflare origin to the public ALB and the private broker DNS name to the internal ALB. The stack remains at zero tasks and the vulnerability-feed schedule remains disabled while approval is pending."
    } >> "${GITHUB_STEP_SUMMARY}"
  fi
}

rollback_activation() {
  local exit_code="$1"
  trap - EXIT INT TERM
  if [[ "${exit_code}" -ne 0 && "${activation_started:-false}" == "true" ]]; then
    printf '%s\n' "Activation failed; returning the first-deployment stack to its dormant state." >&2
    set +e
    refresh_stack
    status="$(jq -r '.Stacks[0].StackStatus' "${STACK_FILE}")"
    if [[ "${status}" == "UPDATE_IN_PROGRESS" ]]; then
      if [[ -z "${activation_handle:-}" ]]; then
        activation_handle="$(find_activation_handle)"
      fi
      if [[ "${activation_success_signaled:-false}" != "true" ]]; then
        signal_activation FAILURE "Protected activation verification failed."
      fi
      aws cloudformation wait stack-update-rollback-complete \
        --region "${AWS_REGION}" \
        --stack-name "${STACK_NAME}"
      refresh_stack
    elif [[ "${status}" == "UPDATE_ROLLBACK_IN_PROGRESS" ]]; then
      aws cloudformation wait stack-update-rollback-complete \
        --region "${AWS_REGION}" \
        --stack-name "${STACK_NAME}"
      refresh_stack
    fi
    if [[ "$(stack_parameter ReleaseActivation 2>/dev/null)" == "${ACTIVE}" ]]; then
      update_phase "${INACTIVE}"
    fi
    assert_exact_images
    assert_inactive
    rollback_result=$?
    set -e
    if [[ "${rollback_result}" -ne 0 ]]; then
      printf '%s\n' "Dormant rollback requires immediate operator intervention." >&2
    fi
  fi
  exit "${exit_code}"
}

verify_migration_result() {
  require_value MIGRATION_TASK_ARN
  local cluster result
  cluster="$(stack_output ClusterName)"
  [[ "${MIGRATION_TASK_ARN}" =~ ^arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT_ID}:task/${cluster}/[a-f0-9-]+$ ]] ||
    fail "MIGRATION_TASK_ARN is outside the prepared cluster."
  result="$(
    aws ecs describe-tasks \
      --region "${AWS_REGION}" \
      --cluster "${cluster}" \
      --tasks "${MIGRATION_TASK_ARN}" \
      --output json
  )"
  jq -e --arg marker "${RUN_MARKER}" '
    (.failures | length) == 0
    and (.tasks | length) == 1
    and .tasks[0].lastStatus == "STOPPED"
    and .tasks[0].startedBy == $marker
    and ([.tasks[0].containers[] | select(.name == "migrate" and .exitCode == 0)] | length) == 1
  ' <<< "${result}" >/dev/null ||
    fail "The activation job could not prove the prepared migration succeeded."
}

verify_active_services() {
  local attempt cluster app worker broker services schedule_rule schedule_state feed_target health_headers served_image
  cluster="$(stack_output ClusterName)"
  app="$(stack_output ServiceName)"
  worker="$(stack_output WorkerServiceName)"
  broker="$(stack_output BrokerServiceName)"
  for attempt in $(seq 1 60); do
    services="$(
      aws ecs describe-services \
        --region "${AWS_REGION}" \
        --cluster "${cluster}" \
        --services "${app}" "${worker}" "${broker}" \
        --output json
    )"
    if jq -e '
        (.failures | length) == 0
        and (.services | length) == 3
        and all(.services[]; .desiredCount >= 2)
      ' <<< "${services}" >/dev/null
    then
      break
    fi
    sleep 5
  done
  jq -e '
    (.failures | length) == 0
    and (.services | length) == 3
    and all(.services[]; .desiredCount >= 2)
  ' <<< "${services}" >/dev/null ||
    fail "CloudFormation did not request the required HA service capacity."
  aws ecs wait services-stable \
    --region "${AWS_REGION}" \
    --cluster "${cluster}" \
    --services "${app}" "${worker}" "${broker}"
  services="$(
    aws ecs describe-services \
      --region "${AWS_REGION}" \
      --cluster "${cluster}" \
      --services "${app}" "${worker}" "${broker}" \
      --output json
  )"
  jq -e '
    (.failures | length) == 0
    and (.services | length) == 3
    and all(
      .services[];
      .desiredCount >= 2
      and .runningCount == .desiredCount
      and .pendingCount == 0
      and ([.deployments[] | select(
        .status == "PRIMARY"
        and .rolloutState == "COMPLETED"
        and .runningCount == .desiredCount
      )] | length) == 1
    )
  ' <<< "${services}" >/dev/null ||
    fail "The activated services did not reach the required HA steady state."
  schedule_rule="$(stack_output VulnerabilityFeedScheduleRuleName)"
  schedule_state=""
  for attempt in $(seq 1 60); do
    schedule_state="$(
      aws events describe-rule \
        --region "${AWS_REGION}" \
        --name "${schedule_rule}" \
        --query State \
        --output text
    )"
    [[ "${schedule_state}" == "ENABLED" ]] && break
    sleep 5
  done
  [[ "${schedule_state}" == "ENABLED" ]] ||
    fail "The vulnerability-feed schedule was not enabled during activation."
  feed_target="$(
    aws events list-targets-by-rule \
      --region "${AWS_REGION}" \
      --rule "${schedule_rule}" \
      --query 'Targets[?Id==`vulnerability-feed-refresh`].EcsParameters.TaskDefinitionArn | [0]' \
      --output text
  )"
  [[ "${feed_target}" == "$(stack_output VulnerabilityFeedTaskDefinitionArn)" ]] ||
    fail "The vulnerability-feed schedule does not target the prepared app digest."
  health_headers="$(
    curl --fail --silent --show-error \
      --retry 18 \
      --retry-all-errors \
      --retry-delay 10 \
      --max-time 20 \
      --dump-header - \
      --output /dev/null \
      "${PUBLIC_ORIGIN}/api/healthz"
  )"
  served_image="$(
    awk 'BEGIN{IGNORECASE=1} $1=="x-sutra-release-image:"{gsub("\\r","",$2); print $2}' \
      <<< "${health_headers}"
  )"
  [[ "${served_image}" == "${APP_IMAGE}" ]] ||
    fail "The public edge did not serve the exact prepared application digest."
}

write_activation_evidence() {
  local evidence_bucket kms_key evidence_file expected_checksum result
  require_value RELEASE_REASON
  require_value CHANGE_TICKET
  evidence_bucket="$(stack_output EvidenceBucketName)"
  kms_key="$(stack_output KmsKeyArn)"
  evidence_file="${RUNNER_TEMP:-/tmp}/sutra-bootstrap-evidence-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.json"
  jq -n \
    --arg schemaVersion "sutra.managed-production-bootstrap.v1" \
    --arg repository "${GITHUB_REPOSITORY:-ydsveluvolu2996/Sutra}" \
    --arg commit "${GITHUB_SHA}" \
    --arg runId "${GITHUB_RUN_ID}" \
    --arg runAttempt "${GITHUB_RUN_ATTEMPT}" \
    --arg actor "${GITHUB_ACTOR:-unknown}" \
    --arg reason "${RELEASE_REASON}" \
    --arg ticket "${CHANGE_TICKET}" \
    --arg appImage "${APP_IMAGE}" \
    --arg workerImage "${WORKER_IMAGE}" \
    --arg brokerImage "${BROKER_IMAGE}" \
    --arg scannerImage "${SCANNER_IMAGE}" \
    --arg migrationTask "${MIGRATION_TASK_ARN}" \
    --arg activatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      schemaVersion:$schemaVersion,
      repository:$repository,
      commit:$commit,
      runId:$runId,
      runAttempt:$runAttempt,
      actor:$actor,
      reason:$reason,
      changeTicket:$ticket,
      appImage:$appImage,
      workerImage:$workerImage,
      brokerImage:$brokerImage,
      scannerImage:$scannerImage,
      migrationTask:$migrationTask,
      activatedAt:$activatedAt
    }' > "${evidence_file}"
  expected_checksum="$(
    openssl dgst -sha256 -binary "${evidence_file}" |
      base64 |
      tr -d '\n'
  )"
  result="$(
    aws s3api put-object \
      --region "${AWS_REGION}" \
      --bucket "${evidence_bucket}" \
      --key "releases/${GITHUB_SHA}/bootstrap-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.json" \
      --body "${evidence_file}" \
      --server-side-encryption aws:kms \
      --ssekms-key-id "${kms_key}" \
      --content-type application/json \
      --checksum-algorithm SHA256 \
      --output json
  )"
  [[ "$(jq -r '.ChecksumSHA256' <<< "${result}")" == "${expected_checksum}" ]] ||
    fail "The first-deployment evidence checksum was not acknowledged by S3."
}

activate() {
  require_value PUBLIC_ORIGIN
  require_value RELEASE_REASON
  require_value CHANGE_TICKET
  require_value RUNTIME_SECRET_VERSION_ID
  [[ "${RUNTIME_SECRET_VERSION_ID}" =~ ^[A-Za-z0-9-]{32,64}$ ]] ||
    fail "RUNTIME_SECRET_VERSION_ID is invalid."
  [[ "$(aws sts get-caller-identity --query Account --output text)" == "${AWS_ACCOUNT_ID}" ]] ||
    fail "AWS credentials are not for the approved production account."
  refresh_stack
  validate_stack_identity
  [[ "$(stack_parameter ReleaseActivation)" == "${INACTIVE}" ]] ||
    fail "Activation requires a dormant first-deployment stack."
  [[ "$(jq -r '.Stacks[0].EnableTerminationProtection' "${STACK_FILE}")" == "true" ]] ||
    fail "Activation requires stack termination protection."
  assert_exact_images
  assert_inactive
  validate_network_firewall "$(stack_output NetworkFirewallArn)" "$(stack_parameter VpcId)"
  validate_runtime_secret "${RUNTIME_SECRET_VERSION_ID}"
  verify_migration_result
  activation_started=true
  activation_success_signaled=false
  activation_handle=""
  trap 'rollback_activation $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  begin_activation
  activation_handle="$(find_activation_handle)"
  assert_exact_images
  verify_active_services
  signal_activation SUCCESS "Protected activation verification passed."
  activation_success_signaled=true
  aws cloudformation wait stack-update-complete \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}"
  refresh_stack
  [[ "$(stack_parameter ReleaseActivation)" == "${ACTIVE}" ]] ||
    fail "The stack did not persist active release state."
  [[ "$(stack_output ReleaseActivation)" == "${ACTIVE}" ]] ||
    fail "The stack did not report active release state."
  write_activation_evidence
  activation_started=false
  trap - EXIT INT TERM
}

case "${1:-}" in
  prepare) prepare ;;
  activate) activate ;;
  *) fail "Usage: $0 prepare|activate" ;;
esac
