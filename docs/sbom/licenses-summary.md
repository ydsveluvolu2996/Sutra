# Sutra — dependency license & IP-risk report

Generated 2026-07-20 from the installed dependency tree via `pnpm licenses list`.
Machine-readable SBOM: [`sbom-production.cdx.json`](./sbom-production.cdx.json)
(CycloneDX 1.5, 124 production components). Flagged set:
[`flagged-components.json`](./flagged-components.json).

## Verdict: nothing blocks selling Sutra as a proprietary product

There are **zero** copyleft-viral or commercially-hostile licenses in the tree —
in production **or** dev. Specifically **none** of: AGPL, SSPL, Sleepycat/BerkeleyDB,
BUSL/BSL, Commons-Clause, CC-BY-NC, or plain GPL-2.0/3.0. Every dependency is either
permissive or a non-infecting weak-copyleft that is satisfied by ordinary use.

## Full license distribution (prod + dev)

| License | Count | Class | Sell-safe? |
| --- | ---: | --- | --- |
| MIT | 410 | permissive | ✅ |
| Apache-2.0 | 72 | permissive (patent grant) | ✅ |
| ISC | 16 | permissive | ✅ |
| BSD-2-Clause | 8 | permissive | ✅ |
| MPL-2.0 | 6 | weak copyleft (file-level) | ✅ (dev-only; see below) |
| BSD-3-Clause | 5 | permissive | ✅ |
| MIT OR Apache-2.0 | 3 | permissive | ✅ |
| CC0-1.0 | 2 | public domain | ✅ |
| LGPL-3.0-or-later | 1 | weak copyleft (dynamic link) | ✅ (see obligation) |
| Python-2.0 | 1 | permissive | ✅ |
| CC-BY-4.0 | 1 | attribution (data) | ✅ (attribution) |
| BlueOak-1.0.0 | 1 | permissive | ✅ |
| 0BSD | 1 | public domain equiv | ✅ |

## Components carrying an obligation (the SBOM-flagged set)

### Production (shipped) — 2

| Component | Version | License | Why it's fine | Your obligation |
| --- | --- | --- | --- | --- |
| `@img/sharp-libvips-darwin-arm64` | 1.2.4 | LGPL-3.0-or-later | LGPL native lib (libvips) loaded dynamically by `sharp`. Dynamic linking in proprietary software is explicitly permitted. This is the **darwin-arm64** binary (dev machines); Linux containers pull a different-arch binary of the same lib. The `sharp` JS wrapper itself is Apache-2.0. | Do not statically link libvips and forbid relinking. Shipping the stock npm binary satisfies this. If you want zero LGPL, `sharp` can be swapped, but it is not required. |
| `caniuse-lite` | 1.0.30001805 | CC-BY-4.0 | Browser-support **data** used by build tooling (browserslist). Not executed in, nor redistributed by, the running product. | Attribution only, and only if you redistribute the dataset itself. |

### Dev / build-only (not shipped to customers) — MPL-2.0 (6)

`@vercel/og`, `satori`, `@resvg/resvg-wasm`, `lightningcss` (+ `lightningcss-darwin-arm64`),
`axe-core`. MPL-2.0 is **file-level** copyleft: it never infects your proprietary code —
the only obligation is to publish modifications *to the MPL-licensed files themselves*,
which you are not making. These are OG-image rendering, CSS build tooling, and
accessibility testing; they run at build/test time.

## Recommended (optional) compliance hygiene

- Keep this report + the CycloneDX SBOM in the repo and regenerate on dependency
  changes (`pnpm licenses list --prod --json`).
- Ship a `THIRD-PARTY-NOTICES` file with attributions for Apache-2.0/BSD/MIT/CC-BY
  components (standard practice; none of these restrict sale).
- No action is required to sell. The LGPL and MPL items above are compatible with a
  closed-source commercial offering under ordinary use.

_This is an engineering license inventory, not legal advice; a licensing attorney
should sign off before contractual IP representations._
