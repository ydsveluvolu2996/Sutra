# Sutra Mac Mini Codex progress

This file is the review-facing progress ledger for the single Codex writer on
`agent/mac-mini-finops-continuation`. The complete scope and status definitions
are in `docs/CODEX_MAC_MINI_HANDOVER.md`.

## Handover baseline

| Item | State |
|---|---|
| Implementation base | `8fb5919a24612e1ccf015110b040c45b5df59177` |
| Local verticals | 8 of 27 |
| Engine-partial capabilities | 19 of 27 |
| Production-accepted capabilities | 0 of 27 |
| Repository shards | 3,099 passed, 0 failed, 4 environment-only skips |
| Root/collector typecheck, lint, secret scan, build | Passed on the handover tree |
| Rendered route tests | 4 passed, 0 failed on the handover tree |
| Live deployment of handover | Not performed; protected release gates remain |

## Active queue

| Order | Capability | Status | Last verified evidence | Next action |
|---|---|---|---|---|
| 1 | Trusted Advisor Organizational | Pending vertical | Engine, contract and focused tests | Complete collector, immutable persistence, API, UI and adversarial tests |
| 2 | Pricing Change Analysis | Pending vertical | Engine, contract and focused tests | Complete pinned catalog persistence, API, UI and adversarial tests |
| 3 | Compute Optimizer Organization | Pending vertical | Engine, contract and focused tests | Complete organization export/history persistence, API and UI |
| 4 | AWS Health Organization | Pending vertical | Engine, contract and focused tests | Complete event/entity persistence, API and UI |
| 5 | AWS Budgets Organization | Pending vertical | Engine, contract and focused tests | Complete provider persistence, API and separate provider UI |
| 6 | Support Cases Radar | Pending vertical | Engine, contract and focused tests | Complete privacy-minimized persistence, API and UI |
| 7 | ResilienceVue | Pending vertical | Engine, contract and focused tests | Complete assessment/drift persistence, API and UI |
| 8 | Remaining 12 engine-partial rows | Pending verticals | See complete handover tracker | Complete one provider-to-UI slice at a time |
| 9 | Full fixed-tree verification | Pending | Handover baseline is green | Rerun after the final slice, including PostgreSQL/Docker where available |
| 10 | Controlled production release | Owner-gated | Immutable workflow exists | Independent approval, protected-main merge, exact CodeQL and release workflow |

## Checkpoint log

Append one entry after each pushed vertical slice:

```text
UTC time:
Capability:
Commit:
Files:
Tests passed/failed/skipped:
Unavailable gates:
Live/owner actions:
Next slice:
```
