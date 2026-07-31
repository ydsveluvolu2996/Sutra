# Sutra ResilienceVue AWS Resilience Hub source contract

ResilienceVue treats AWS Resilience Hub as retained provider evidence. It does
not infer that an application is resilient merely because an application or
policy exists, or because the source returned no assessment.

The v1 pure engine normalizes:

- application inventory, linked resiliency policies, AWS-reported scores,
  RTO/RPO, compliance, and drift;
- bounded assessment history and the provider's objective-level current and
  achievable RTO/RPO evidence;
- application-component compliance and scores;
- configuration, alarm, standard operating procedure, and test
  recommendations;
- application-version resources and component lineage; and
- assessment compliance and resource drift.

Observed AWS evidence is returned under `observedAwsEvidence`. Sutra's bounded,
deterministic ordering of the recommendation backlog is returned separately
under `inferredPrioritization`, with the label
`SUTRA_INFERRED_PRIORITY_NOT_AWS_FINDING`. The ranking does not alter or replace
AWS status, score, recommendation, risk, or compliance evidence.

## Exact read-only permissions

The collector for this contract requires only:

- `resiliencehub:DescribeApp`
- `resiliencehub:DescribeAppAssessment`
- `resiliencehub:DescribeResiliencyPolicy`
- `resiliencehub:ListAlarmRecommendations`
- `resiliencehub:ListAppAssessmentComplianceDrifts`
- `resiliencehub:ListAppAssessmentResourceDrifts`
- `resiliencehub:ListAppAssessments`
- `resiliencehub:ListAppComponentCompliances`
- `resiliencehub:ListAppComponentRecommendations`
- `resiliencehub:ListAppVersionResources`
- `resiliencehub:ListApps`
- `resiliencehub:ListResiliencyPolicies`
- `resiliencehub:ListSopRecommendations`
- `resiliencehub:ListTestRecommendations`

`ListApps`, `ListAppAssessments`, and `ListResiliencyPolicies` do not support
resource-level permissions in the AWS service authorization table, so those
list calls require `Resource: "*"`. The remaining operations are scoped to the
captured Resilience Hub application/policy resources where AWS supports it.
The capture contract also validates that every application, assessment, and
policy ARN matches the configured partition, Region, and AWS account.

This slice contains no `StartAppAssessment`, create, update, publish, import,
batch-update, tag, or delete permission or behavior.

Authoritative AWS references:

- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_awsresiliencehub.html>
- <https://docs.aws.amazon.com/resilience-hub/latest/APIReference/API_ListApps.html>
- <https://docs.aws.amazon.com/resilience-hub/latest/APIReference/API_DescribeApp.html>
- <https://docs.aws.amazon.com/resilience-hub/latest/APIReference/API_ListResiliencyPolicies.html>
- <https://docs.aws.amazon.com/resilience-hub/latest/APIReference/API_DescribeResiliencyPolicy.html>
- <https://docs.aws.amazon.com/resilience-hub/latest/APIReference/API_ListAppAssessments.html>
- <https://docs.aws.amazon.com/resilience-hub/latest/APIReference/API_DescribeAppAssessment.html>
- <https://docs.aws.amazon.com/resilience-hub/latest/APIReference/API_ListAppComponentCompliances.html>
- <https://docs.aws.amazon.com/resilience-hub/latest/APIReference/API_ListAppComponentRecommendations.html>
- <https://docs.aws.amazon.com/resilience-hub/latest/APIReference/API_ListAlarmRecommendations.html>
- <https://docs.aws.amazon.com/resilience-hub/latest/APIReference/API_ListSopRecommendations.html>
- <https://docs.aws.amazon.com/resilience-hub/latest/APIReference/API_ListTestRecommendations.html>
- <https://docs.aws.amazon.com/resilience-hub/latest/APIReference/API_ListAppVersionResources.html>
- <https://docs.aws.amazon.com/resilience-hub/latest/APIReference/API_ListAppAssessmentComplianceDrifts.html>
- <https://docs.aws.amazon.com/resilience-hub/latest/APIReference/API_ListAppAssessmentResourceDrifts.html>

## Tenant and collection boundary

The query service accepts only the trusted server-side organization, customer,
connection, AWS account, partition, and Region configuration. It has no client
tenant selector, AWS credentials, fixtures, database access, or global cache.
Cross-scope captures and cross-account/Region/partition provider ARNs fail
closed. Transport and evidence failures expose only generic error codes.

The source is bounded to 100 records per API page, four concurrent calls, 15
minutes, 20,000 pages, 1,000 applications, 1,000 policies, 20,000 assessments,
36 assessments per application, 100,000 component records, 200,000
recommendations, 200,000 resources, 100,000 drifts, 48 MiB per capture, and 64
MiB per dashboard input, with an additional 500,000-record aggregate capture
ceiling. Recommendation text, suggested changes, component
lists, response rows, and dashboard rows have independent bounds. Pagination
must begin without a token, preserve an unbroken request/response token chain,
never replay a token, and state whether provider pagination was exhausted.

Duplicates are accepted only when the normalized record is byte-for-byte
equivalent. Conflicting duplicates, mismatched `List`/`Describe` evidence, an
assessment attached to the wrong application, a recommendation attached to the
wrong assessment, or a resource returned for the wrong app version fail closed.

## Honest states

- `configuration_required`: service configuration, Region availability, or
  the complete read permission set has not been validated.
- `no_apps`: an exhaustive configured read returned no applications. This is
  not evidence that customer workloads are resilient.
- `no_assessments`: applications exist but an exhaustive read returned no
  assessments. Application resilience has not been established.
- `partial`: at least one provider sequence stopped before exhaustion.
- `stale`: complete evidence is older than the 168-hour source SLA.
- `current`: configuration and pagination are complete and the capture is
  current. Pending, in-progress, and failed assessments remain visibly
  non-successful; `current` describes evidence freshness, not resilience.

## Production acceptance gates

This source engine and its tests do not make ResilienceVue production-ready.
Production acceptance still requires all of these independently verified gates:

1. **Versioned IAM:** add the 14 reads to a versioned collector role/session
   ceiling, using resource-level application/policy restrictions wherever AWS
   supports them and documenting unavoidable wildcard list actions.
2. **Signed broker:** implement a credential-owning, replay-resistant broker
   runner that enforces the exact tenant/account/Region scope, concurrency,
   duration, page, retry, and payload bounds before returning evidence.
3. **Persistence:** atomically retain collection attempts, normalized captures,
   freshness, pagination completion, and generic failures under organization,
   customer, connection, account, partition, and Region scope.
4. **API:** expose only authorization-derived tenant scope and bounded persisted
   snapshots; do not accept a tenant/account/Region from the browser.
5. **Professional UI:** render applications, policy objectives, assessment
   history, component/resource risk, drifts, recommendation backlog, observed
   versus inferred labels, and every honest empty/partial/stale state.
6. **Live validation:** use a controlled customer account to test apps with and
   without policies, successful/pending/failed/missing assessments, policy
   breach/met cases, drift, all four recommendation kinds, resources,
   pagination, throttling, access denial, stale evidence, and adversarial
   cross-tenant requests.

No IAM role, broker, database, route, UI, customer AWS account, or deployment is
changed by this source-only slice.
