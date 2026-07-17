# GitHub repository release-readiness checklist

This checklist keeps review claims proportional to evidence.

| Gate | Current state | Required before production release |
|---|---|---|
| CI | Passing on the current branch | Keep required checks enabled on `main` |
| Secret scan | Repository scan passes | Enable GitHub secret scanning and push protection when plan supports it |
| Dependency updates | Dependabot configuration added | Review and merge updates weekly |
| Code scanning | CodeQL workflow prepared and gated | Enable Advanced Security or set repository variable `CODEQL_ENABLED=true` after entitlement |
| Ownership | CODEOWNERS added | Add independent security and infrastructure reviewers |
| PR quality | PR template added | Split the current large draft PR into reviewable feature PRs |
| Branch safety | Branch protection unavailable on current private plan | Upgrade GitHub plan or move repository to an organization with required reviews/checks |
| Release | Immutable ECR/OIDC workflow present | Configure protected `kubernetes-production-release` environment and independent approver |
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
