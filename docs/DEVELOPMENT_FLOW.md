# Development and release flow

Two branches, one standing pull request, two human decisions. This is the whole
process; `CLAUDE.md` and `AGENTS.md` state the same rules as agent instructions.

```
work ──push──> develop ──CI on PR #N──> "commit to main" ──merge──> main
                                                                     │
                                                              CI on main
                                                                     │
                                                          release run PARKS
                                                                     │
                                                          "deploy" ──approve──> live
```

## Branches

| Branch | Purpose | Who writes |
| --- | --- | --- |
| `main` | what is released | only a merge of the standing pull request |
| `develop` | all work in progress | agents and humans, directly |

There is no branch per change, per feature or per fix. A second working branch is
the thing this rule exists to prevent.

## The standing pull request

Exactly one pull request is open at any time: `develop` → `main`, titled
`develop → main`. It updates itself on every push, so no pull request is ever
opened for an individual change. When it is merged, a fresh one is opened
immediately for the next cycle.

It is not ceremony, and deleting it would not save time. CI triggers on
`pull_request` and on `push` to `main` -- **not** on branch pushes. Without an
open pull request, `develop` carries no verification at all and the first CI run
happens on `main`, where a successful run is what fires a release. The standing
pull request is the only thing keeping unverified code off `main`.

It also produces the review pass. On 2026-08-07 that review caught six defects
that CI passed, including onboarding UI stating that the customer role grants
`s3:GetObject` when the deployed pack denies it -- the test asserting the grant
was itself the defect, so no test could have caught it.

## The two human decisions

| Phrase | Effect | Never implied by |
| --- | --- | --- |
| **"commit to main"** | merge the standing pull request into `main` | finishing work, green checks, a reviewer approving |
| **"deploy"** | approve the parked release run | merging, a green pipeline, an approval given for an earlier release |

Green checks are a *precondition* for merging, never an instruction to merge.

## Deployment

Merging to `main` runs CI. On success, `ec2-live-release.yml` fires
automatically and then **parks** on the `ec2-live-release` environment approval.
Parked runs accumulate; that is expected. Nothing reaches
https://www.sutracmdb.com until a human approves one.

Each parked run is pinned to the SHA it was created from. Approve the newest, or
dispatch fresh at current `main` if the newest parked run is not the current
head. Approving an older parked run deploys superseded code over newer code.
State which SHA is going live before approving. Parked runs expire after 30 days.

After approval the run builds, scans the exact digest, promotes it to a retained
tag, deploys over SSM, and verifies the live site -- including asserting that the
`x-sutra-release-image` header byte-matches the digest just deployed. If the site
serves anything else, the release fails.

## Keeping `develop` green

One branch means one red check blocks every promotion, including unrelated work.
Fixing a red `develop` or `main` is the immediate next task, ahead of whatever
came next. A red `main` blocks every later release, because the release run only
fires on a successful CI run.

Push only what local verification already covers: the relevant tests, `tsc`,
`eslint` and the repository secret scan for the changed area.

## Parallel agents

More than one agent may work `develop`. They share its state, so one agent's red
check blocks the other's promotion. If two agents run concurrently, either
serialise them or give the second a branch that pull-requests into `develop`;
`develop` itself stays the single integration branch either way.

Shared files listed in `CLAUDE.md` -- dependency manifests, the role broker, the
migration registries, the tracker -- remain integrator-owned regardless.

## Repository settings that enforce this

These are GitHub settings, not repository files, and must be set in the web UI.
Without them the flow is convention; with them it is enforced.

| Setting | Value | Why |
| --- | --- | --- |
| `main` → Require a pull request before merging | on | stops a direct push bypassing CI |
| `main` → Require status checks to pass | on, with `Typecheck, lint, test, and build` | makes green a precondition mechanically |
| `main` → Require branches to be up to date | on | the merged result is what was tested |
| `main` → Block force pushes | on | promotion is never a rewrite |
| `main` → Restrict deletions | on | |
| `ec2-live-release` environment → Required reviewers | the account owner | this is the deployment gate |
| Automatically delete head branches | on | dead branches stop accumulating |

Approvals cannot be set to "anyone" for the release environment: the environment
approval *is* the deployment permission prompt, and it is answered by a human,
never by an agent.
