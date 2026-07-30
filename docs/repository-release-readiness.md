# GitHub repository release-readiness checklist

**Status:** repository-control checklist. A checked-in workflow or local test is not
evidence that GitHub protections are enabled or that a production deployment
succeeded.

This checklist keeps review claims proportional to evidence. The managed-production
deployment contract is
[`../deploy/production/README.md`](../deploy/production/README.md).

| Gate | Current state | Required before production release |
|---|---|---|
| CI | Required workflow definitions and local verification scripts are present | Confirm the exact release SHA passes every required check on protected `main` |
| Secret scan | Repository scan passes | Enable GitHub secret scanning and push protection when plan supports it |
| Dependency updates | Dependabot configuration added | Review and merge updates weekly |
| Code scanning | CodeQL workflow prepared and gated | Enable Advanced Security or set repository variable `CODEQL_ENABLED=true` after entitlement |
| Ownership | CODEOWNERS added | Add independent security and infrastructure reviewers |
| PR quality | PR template added | Review security, identity, database, broker and infrastructure boundaries with accountable owners |
| Branch safety | Repository files cannot prove the live GitHub protection state | Require protected `main`, required checks, restricted pushes and independent approval |
| Managed production release | One immutable app/worker/broker ECR/OIDC workflow is present | Configure the protected `production-ha-release` environment, exact AWS OIDC trust and independent approver; perform one approved dry run and rollback exercise |
| Kubernetes release | Separate Kubernetes release material remains scoped to that subsystem | Do not treat a Kubernetes workflow as approval for the managed application stack |
| Documentation | Architecture, security and Kubernetes runbooks present | Keep changelog, release notes and customer limitations current |
| Legal/commercial | No license selected | Choose proprietary commercial license or approved open-source license |

## Recommended review sequence

1. Merge repository governance and documentation changes.
2. Review authentication, tenant isolation and database migrations separately.
3. Review Kubernetes collectors and deployment manifests separately.
4. Review AWS IAM/STS and broker changes separately.
5. Review hosted identity, notifications and deployment workflows separately.
6. Require focused tests and a rollback plan for each PR.
7. Tag only commits that passed all required checks and acceptance evidence.
