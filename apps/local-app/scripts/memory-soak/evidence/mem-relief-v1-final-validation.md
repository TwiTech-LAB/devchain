# mem-relief-v1 final validation report

> Historical snapshot only. This record preserves the original investigation or captured evidence; it does not describe current status or gate changes. Use the [memory-soak runbook](../README.md) for the current validation procedure and the live DevChain Epics tracker for work status.

Date: 2026-07-15
Verdict: **GO — 12 accepted outcomes; the host strict result retains the PSI-unavailable deviation**

## Authoritative provenance

This report publishes only the Remediation 15 Task 3 evidence. All 17 authoritative reports (12
original scenarios, including the host run, plus five confirmations) used one production Local App
build from the same clean source and tree:

- Source checkpoint: `487762ef4b4e2673030199851f3c92b5edee82ac`
- Source tree: `4058dd8137802ded1f2569b2cb4b1d41649b21ca`
- Dist-tree SHA-256: `4aafd9d6c93b0340a0d0933b29a90c96bc6416de39e7948571b102d06e016b5e`
- Dist tree: 2,007 files / 11,462,551 bytes
- Entrypoint: `apps/local-app/dist/main.js`
- Profile / seed: `soak` / `1337`
- Source and harness dirty at authoritative capture: `false` / `false`
- Identical dist digest across all authoritative runs: `true`

Machine-readable authority:

- Host baseline: `apps/local-app/scripts/memory-soak/baselines/phase6-final-487762ef4b4e-4aafd9d6c93b.json` (1,277,171 bytes; SHA-256 `a03f8b255d32b6d07742d6e6cfb7289f7effedece773749ecd15f44f05f79c36`)
- Scenario matrix: `apps/local-app/scripts/memory-soak/evidence/phase6-scenario-matrix-487762ef4b4e-4aafd9d6c93b.json` (34,714 bytes; SHA-256 `ef83ab8d9d71800b51e57a50d1495798dba2ace0776e86e1ac044877baaa0a54`)
- Artifact manifest: `apps/local-app/scripts/memory-soak/evidence/phase6-scenario-matrix-487762ef4b4e-4aafd9d6c93b/manifest.json` (SHA-256 `ef17db20ea3f9b47fb4e02303b4df6b3fa0b38051bca65b3a498a9a726f17a62`)
- Focused gates: `apps/local-app/scripts/memory-soak/evidence/phase6-scenario-matrix-487762ef4b4e-4aafd9d6c93b/focused-gates/focused-gates.json` (5,180 bytes; SHA-256 `2bf9e8a246dc683b64b005892131034f9fc13aa49a33aaa1f98d9ee09704ccdd`)
- Fixture, confirmation, runtime-input, and setup-diagnostic bundle: `apps/local-app/scripts/memory-soak/evidence/phase6-scenario-matrix-487762ef4b4e-4aafd9d6c93b/`

The manifest is self-hash-excluding to avoid circularity. Its 31 recorded artifact paths, byte
counts, and SHA-256 values verify. The matrix SHA recorded by the manifest also verifies.

## Gate summary

The matrix records 12/12 catalog scenarios active and executed, 12/12 quantitative plateaus,
11/11 fixture correctness oracles, and 12/12 cleanup checks passing. Eleven fixture originals and
all five confirmations pass strict evaluation. The host report passes every check except the
fail-closed PSI sentinel described below, so the matrix has 12 accepted outcomes and verdict `GO`.
All six focused gates pass, and all 17 authoritative reports replay exactly to their embedded strict
results.

Focused results bound to the same source/dist target:

- Targeted-seed admission: 3 suites / 133 tests passed.
- Reader generation integrity, backend and web: 8 suites / 235 tests passed.
- Mobile generation integrity: 4 suites / 44 tests passed; mobile typecheck passed.
- Memory-soak contracts: 88/88 passed.
- Canonical Local App production build passed.
- Strict evaluator replay: 17/17 reports matched; replay log SHA-256 `90eb5c57870cd5c7001c0af554cd3a6c0cef8f3b26281d0c1993b6b61ca4c2ca`.

## Append and recovery safety authority

For a file growth candidate, `SessionCacheService` first binds the cached prefix to an immutable
device/inode/size/mtime snapshot and full digest. The adapter's path-based incremental parse is
tentative. A second bounded digest must prove the exact snapshot and content after parsing before
the result can be merged, cached, or classified `same-file-append`. If that proof is unavailable or
different, the tentative result is discarded, current freshness is recomputed, and the canonical
full parse is returned with an unsafe source-change classification
(`apps/local-app/src/modules/session-reader/services/session-cache.service.ts`; regressions:
`apps/local-app/src/modules/session-reader/services/session-cache.service.spec.ts`,
`apps/local-app/src/modules/session-reader/services/session-reader.replacement.integration.spec.ts`).

The deterministic real-file regression rotates the path from inside `parseIncremental()`. It proves
the response is cursor-free `full-refetch-required`, the canonical cache contains only the current
generation, and the next read is a true-empty same-cursor tail
(`apps/local-app/src/modules/session-reader/services/session-reader.replacement.integration.spec.ts`).

Client recovery preserves each mode's actual validation boundary. Full web and mobile retain the
old generation until a canonical candidate passes a true-empty tail check with the same cursor
(`apps/local-app/src/ui/hooks/useSessionTranscript.ts`,
`apps/mobile-app/src/screens/chat/useTranscript.ts`; regressions:
`apps/local-app/src/ui/hooks/useSessionTranscript.spec.tsx`,
`apps/mobile-app/__tests__/useTranscript-swr.spec.tsx`). Paged web instead rejects dirty candidates,
stages required pages between matching before/after opaque transcript-index cursors, and atomically
commits the index plus page cache/render state
(`apps/local-app/src/ui/components/session-reader/PagedSessionMessageList.tsx`; regression:
`apps/local-app/src/ui/components/session-reader/PagedSessionMessageList.spec.tsx`).

## Host result

The host scenario captured 267 samples and 26,105,856 workload bytes. Target peak RSS was
232,415,232 bytes, workload peak RSS was 286,912,512 bytes, and target swap stayed at zero. The two
cycle-tail medians were 450,805,760 and 457,687,040 bytes: growth was 6,881,280 bytes (1.5264%),
inside the unchanged 32 MiB / 10% plateau policy.

The host's strict result is false only because neither host nor cgroup memory PSI was exposed.
`memory-psi-full-avg10` remains `actual: null` and `pass: false`; unavailable PSI is not interpreted
as zero pressure. The matrix explicitly classifies this as the single accepted environmental
deviation. It does not conceal a plateau, liveness, isolation, freshness, or cleanup failure.

## Full scenario matrix

“Correct” is the scenario-specific protocol/cache oracle. The host has no separate correctness
oracle. Every row passes the plateau and cleanup gates.

| Scenario                               | Correct |           Plateau growth | Acceptance outcome                       |
| -------------------------------------- | :-----: | -----------------------: | ---------------------------------------- |
| `host-burst-plateau`                   |   n/a   |  +6,881,280 B / +1.5264% | environmental deviation: PSI unavailable |
| `many-subscribers-one-session`         |   yes   |    +524,288 B / +0.1591% | pass                                     |
| `reconnect-replay-available`           |   yes   |    +581,632 B / +0.1716% | pass                                     |
| `reconnect-older-than-ring`            |   yes   | +30,703,616 B / +8.6199% | pass                                     |
| `zero-web-mobile-activity`             |   yes   |    +827,392 B / +0.1964% | pass                                     |
| `stalled-and-current-socket`           |   yes   |  -3,878,912 B / -0.4155% | pass                                     |
| `oversized-unicode-ansi-chunking`      |   yes   |  +6,713,344 B / +1.5306% | pass                                     |
| `seed-during-burst`                    |   yes   |  +3,227,648 B / +1.0190% | pass                                     |
| `lifecycle-cleanup-parity`             |   yes   |  +5,378,048 B / +1.9390% | pass                                     |
| `summary-full-provider-parity`         |   yes   |  +1,605,632 B / +0.5564% | pass                                     |
| `eviction-concurrent-transcript-reads` |   yes   | +13,365,248 B / +4.4845% | pass                                     |
| `engine-write-buffer-bounded`          |   yes   |    +737,280 B / +0.0821% | pass                                     |

`reconnect-older-than-ring` is the closest original result to the relative bound. It remains below
both unchanged limits and passed an additional threshold confirmation; no threshold was raised.

## Regression and threshold confirmations

Four standing policy confirmations and the additional near-threshold confirmation passed against
the same immutable source, harness, and dist state:

| Scenario                               |          Original growth |      Confirmation growth | Correct both |
| -------------------------------------- | -----------------------: | -----------------------: | :----------: |
| `many-subscribers-one-session`         |    +524,288 B / +0.1591% |    +184,320 B / +0.0629% |     yes      |
| `reconnect-replay-available`           |    +581,632 B / +0.1716% |    +438,272 B / +0.1501% |     yes      |
| `oversized-unicode-ansi-chunking`      |  +6,713,344 B / +1.5306% |  +6,807,552 B / +1.8980% |     yes      |
| `eviction-concurrent-transcript-reads` | +13,365,248 B / +4.4845% | +19,505,152 B / +6.6135% |     yes      |
| `reconnect-older-than-ring`            | +30,703,616 B / +8.6199% | +30,838,784 B / +9.6455% |     yes      |

## Cleanup, diagnostics, and runtime input

All 12 original scenario results and all five confirmations record `cleanupPassed: true`. The final
zero-residue check found no checkpoint app, memory-soak runner, output generator, isolated tmux
fixture, or `/tmp/devchain-app-soak-*` root.

Two setup-only diagnostics are preserved and excluded from the verdict: the fresh worktree first
lacked app-local React dependency links, and the first production build lacked generated workspace
package outputs. The successful preparation built those workspace dependencies without product,
harness, threshold, or frozen-dist mutation. Their logs are hash-bound in the 31-entry manifest.

The authorized capture used an explicit byte-identical OpenCode runtime input, bundled with its
provisioning record:

- Logical path: `apps/local-app/scripts/memory-soak/fixtures/provider-transcripts/opencode.json`
- Bundled bytes: 1,239
- Bundle SHA-256: `540d4344c5f80dfa8e109b0fade4b6e84618eb6da1353d8ec7e2034457d63c90`
- Runtime-input record: 1,213 bytes; SHA-256 `5abae530abfa6fec9807df399684200c85377c4905ea855bf867fcc378044636`

The authoritative set was captured outside the checkout from unchanged source and dist. No failed
report was edited into success.

## Superseded Remediation 14 evidence

The prior `34e222d57850706e83323894b075cc0c6edd6eed` evidence remains available and
byte-identical. It is valid history, but it predates the append proof-to-parse revision binding and
is not current authority:

- Host: `apps/local-app/scripts/memory-soak/baselines/phase6-final-34e222d57850-ea0452dd2b66.json` (SHA-256 `750c30bf3adf1e5e1deda9f54e59bdc679636015c4f480c090d7fb6a820a8f92`)
- Matrix: `apps/local-app/scripts/memory-soak/evidence/phase6-scenario-matrix-34e222d57850-ea0452dd2b66.json` (SHA-256 `bd61753280571eec363e2cd3166f10439d31d59f00fadbe8a3d8cc4d6040e82b`)
- Manifest: `apps/local-app/scripts/memory-soak/evidence/phase6-scenario-matrix-34e222d57850-ea0452dd2b66/manifest.json` (47 entries; SHA-256 `438d061c7e7162c7dc83d88fcd6e4a47efdeb60efd2dc4f46ff7c4b4354a900d`)
- Disposition: `superseded-pre-append-revision-binding-history`

All 47 historical manifest paths, byte counts, and SHA-256 values still verify. No Remediation 14
artifact was deleted, overwritten, or used to fill a Remediation 15 result.

## Recommendation

Proceed with the `GO` verdict represented by the Remediation 15 Task 3 matrix. The authoritative
evidence has complete scenario and focused-regression coverage, no correctness failures, all
plateau and cleanup gates passing, five green confirmations, exact 17/17 evaluator replay, all
current and cited historical manifest entries verified, and only the unchanged fail-closed
PSI-unavailable environmental deviation.
