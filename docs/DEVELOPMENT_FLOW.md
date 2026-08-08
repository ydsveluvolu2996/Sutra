# Development and release flow

Two branches, one standing pull request, two human decisions. `CLAUDE.md` and
`AGENTS.md` state the same rules as agent instructions.

```text
pnpm work:start
      │
      ▼
daily work ──pnpm work:save──> develop ──CI on standing PR──> "commit to main"
                                                                       │
                                                                       ▼
                                                                     main
                                                                       │
                                                                 CI on main
                                                                       │
                                     no release is started until "deploy"
                                                                       │
                                                                       ▼
                                  manual exact-SHA release ──approval──> EC2 live
```

## Branches

| Branch | Purpose | Who writes |
| --- | --- | --- |
| `main` | deployable, protected history | only a merge of the standing pull request |
| `develop` | all normal work in progress | agents and humans, directly |

There is no branch per routine change, feature or fix. This keeps the daily path
fast and prevents abandoned agent branches. If Claude and Codex truly work at the
same time, one remains the `develop` integrator and the other uses a temporary
branch that pull-requests into `develop`; they must not concurrently rewrite the
same shared working tree.

## Daily commands

Start a session from a clean tree:

```bash
pnpm work:start
```

This switches to `develop`, fetches `main` and `develop`, and fast-forwards to
GitHub. It stops rather than moving a dirty tree.

After running the focused tests appropriate to the change, save everything to
GitHub:

```bash
pnpm work:save -- "Describe the completed work"
```

The checkpoint command runs the repository secret scan, stages the current
worktree, rejects whitespace errors, commits, synchronizes unpublished local
commits, pushes `develop`, and makes sure exactly one standing PR exists. If a
concurrent push creates a rebase conflict, it aborts the rebase and pushes the
intact local commit to a timestamped `checkpoint/*` branch. That path needs
manual integration, but the work is already safe on GitHub.

## The standing pull request

Exactly one pull request stays open: `develop` → `main`, titled
`develop → main`. It updates on every push, so routine checkpoints do not create
new pull requests.

The standing PR is also the CI and review surface. CI triggers on
`pull_request` and on pushes to `main`, not on direct pushes to `develop`.
Without the PR, `develop` would carry no verification before promotion. A prior
review caught onboarding permission claims that their own tests incorrectly
asserted, which is why review remains useful even with a green build.

## The two human decisions

| Phrase | Effect | Never implied by |
| --- | --- | --- |
| **"commit to main"** | merge the green standing PR into protected `main` | finishing work, green checks, reviewer comments |
| **"deploy"** | release the exact current `main` SHA to EC2 and verify it | merging, a green pipeline, an instruction from an earlier turn |

Green checks are a precondition for merging, never an instruction to merge.

## Deployment

Merging to `main` runs CI and does nothing else. The EC2 release workflow is
`workflow_dispatch`-only; there are no automatic or parked release runs, so
merges cannot spend AWS compute or queue behind stale approvals.

After the user explicitly says `deploy`, the agent states the exact current
`origin/main` SHA and runs:

```bash
pnpm deploy:ec2 -- "Approved reason for this production release"
```

The command fails closed unless that exact SHA has a successful completed `main`
CI run. It then dispatches `ec2-live-release.yml` on `main`, resolves the new run,
approves the `ec2-live-release` environment for that run only, waits for the
workflow, and proves the completed run used the same SHA.

The workflow builds and scans an immutable digest, promotes that exact digest to
a retained release tag, deploys through the constrained SSM document, and checks
the public site. Its final verification asserts that the
`x-sutra-release-image` header byte-matches the digest just deployed.

## Keeping integration green

One integration branch means one red check blocks every promotion. Fixing a red
`develop` or `main` is the immediate next task. Push only after relevant local
tests, typecheck/lint for the changed area, and the repository secret scan pass;
the standing PR supplies the complete remote gate.

## Repository settings that enforce the flow

| Setting | Value | Why |
| --- | --- | --- |
| `main` → Require a pull request before merging | on, zero required approvals | prevents direct pushes without blocking a single-owner repository |
| `main` → Require status checks | `Typecheck, lint, test, and build` | makes the aggregate CI gate mandatory |
| `main` → Require branches to be up to date | on | tests the result being promoted |
| `main` → Include administrators | on | the owner follows the same safety path |
| `main` → Force pushes and deletions | blocked | release history cannot be rewritten or removed |
| `develop` → Force pushes and deletions | blocked | daily checkpoints cannot be erased accidentally |
| `ec2-live-release` environment → Required reviewer | repository owner | preserves a second GitHub-side production boundary |
| Automatically delete head branches | off | `develop` is the standing PR head and must persist after promotion |

The deployment helper performs the environment approval only after an explicit
current-turn `deploy` instruction. It never approves an already-existing run or
reuses a prior authorization.
