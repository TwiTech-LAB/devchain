# Baseline artifacts

Baseline names describe the **target build being measured**, not the checkout that runs the harness. Every schema-v2 report keeps those identities separate:

- `harness.provenance` is descriptive Git checkout metadata for the harness code (`method: git-checkout`, repository root, commit, branch, dirty flag).
- `target.provenance` binds the measured PID to on-disk content at run start. On Linux it records `/proc/<pid>/exe`, the resolved Node entrypoint when present, SHA-256/size/mtime file metadata, target-cwd Git commit/dirty metadata when available, and an authoritative `buildFingerprint`.

For a Node entrypoint below `dist/`, `buildFingerprint` hashes the complete sorted `dist` tree: entry type + relative path + file contents, using SHA-256. This content digest—not the target Git fields or mtimes—is authoritative for build-to-build comparison. When no `dist` tree is resolvable, the fingerprint falls back to the entrypoint file, then the native executable. Git commit/dirty fields remain useful context but do not prove which already-built bytes the process loaded.

Reports created without `--target-pid` contain an explicit `target.provenance.method: not-requested`; they are useful for workload-only smoke tests but are not baseline-eligible. Raw command-line arguments are never persisted because they may contain secrets.

Fixture-scenario reports instead bind `target.provenance` to the disposable app PID spawned from
`--app-entry`. Matrix evidence must point at the intended built Local App entry. The lightweight
`fixtures/app-runtime.js` process exists only to contract-test lifecycle and cleanup behavior; its
fingerprint is never baseline-eligible.

## Artifact naming

Use the target provenance, shortened only in the filename:

- `pristine-master-<target-commit-12>-<build-sha256-12>.json`
- `phase1-instrumented-<target-commit-12-or-nogit>-<build-sha256-12>.json`
- `phase2-memory-relief-<target-commit-12-or-nogit>-<build-sha256-12>.json`
- `phase6-final-<target-commit-12-or-nogit>-<build-sha256-12>.json`

The full commit and digest stay in the report. Never name an artifact from `harness.provenance.commit`.

`legacy-phase1-instrumented-unbound.json` predates schema v2. Its metrics endpoint proves it measured a Phase-1-instrumented process, but the target executable/build was not recorded and the process no longer exists. It is retained as diagnostic history only: the strict evaluator rejects it, and it must never be used for a memory delta.

## Comparison policy

- The **pristine-master** baseline is the pre-instrumentation reference. Use it only to quantify instrumentation overhead or reproduce the original investigation, and only when target provenance shows the intended clean target build.
- The **Phase-1-instrumented** baseline is the operational comparison point for all later memory-relief phases. Phase 2 and every subsequent phase must cite the exact schema-v2 artifact and full `target.provenance.buildFingerprint.digest` used for its before/after comparison.
- A comparison is invalid when either artifact lacks target provenance, uses `method: not-requested`, or fingerprints a different target build unless the build change is the explicit subject of that comparison.

The authoritative operational baseline is `phase1-instrumented-e31e970a0d41-fe11d4d4474c.json`, with full target-build digest `fe11d4d4474cda10e51c939a90507cf114c47cc41f86b06e06b797e18c54196d`. Later phases cite this artifact unless they deliberately establish and document a replacement Phase-1 baseline.

`phase1-instrumented-e31e970a0d41-01411f3b5635.json` remains checked in as historical evidence for its recorded build (`01411f3b5635ffccc7e9f80974de39d5ba5a32b3317976f45ffaad32c63fb3ef`). It is accepted by the schema-v2 evaluator, but it is not the corrected-tree anchor and must not be selected for new Phase 2+ comparisons.

The Phase 2 after-artifact is `phase2-memory-relief-8b55bb10e650-a8fd4ec41689.json`, with full target-build digest `a8fd4ec4168949ddd8b2a074c4876a546fc7e2f73d99f6b829258940a056fcd2`. Its two cache-churn cycle tail medians are 610,607,104 and 611,106,816 bytes: growth is 499,712 bytes (0.0818%), so the plateau check passes both the 32 MiB absolute and 10% relative limits. The Phase 1 artifacts remain the before/reference evidence and are not superseded by this after-artifact.

The authoritative Remediation 15 Phase 6 host artifact is `phase6-final-487762ef4b4e-4aafd9d6c93b.json` (SHA-256 `a03f8b255d32b6d07742d6e6cfb7289f7effedece773749ecd15f44f05f79c36`), bound to source checkpoint `487762ef4b4e2673030199851f3c92b5edee82ac`, tree `4058dd8137802ded1f2569b2cb4b1d41649b21ca`, and full target-build digest `4aafd9d6c93b0340a0d0933b29a90c96bc6416de39e7948571b102d06e016b5e`. Its full soak profile captured 267 samples and 26,105,856 workload bytes. The two cycle-tail medians are 450,805,760 and 457,687,040 bytes: growth is 6,881,280 bytes (1.5264%), within both plateau limits. Its strict result remains false solely because PSI is unavailable. The companion `../evidence/phase6-scenario-matrix-487762ef4b4e-4aafd9d6c93b.json` (SHA-256 `ef83ab8d9d71800b51e57a50d1495798dba2ace0776e86e1ac044877baaa0a54`) and its manifest (SHA-256 `ef17db20ea3f9b47fb4e02303b4df6b3fa0b38051bca65b3a498a9a726f17a62`) bind all 12 active scenarios, five confirmation runs, focused regression gates, runtime inputs, and setup diagnostics to that immutable target. All 12 plateau and cleanup checks and all 11 fixture correctness oracles pass, so its verdict is `GO`. See `docs/mem-relief-v1-final-validation.md`.

`phase6-final-34e222d57850-ea0452dd2b66.json`, its matrix, and its 47-entry manifest remain byte-identical and hash-valid Remediation 14 evidence, but are superseded pre-append-revision-binding history. They do not attest to the post-parse proof that binds a tentative adapter result to its proven file revision and must not be cited as the current final validation authority.

`phase6-final-471d10fb4dd6-388c178aef48.json` and its companion matrix remain hash-valid Remediation 13 evidence but are superseded pre-Remediation-14 history. They do not attest to targeted-seed admission ownership or whole-generation transcript replacement and must not be cited as the current final validation authority.

`phase6-final-6c3ee5235fb9-0074ab9ec999.json` and its companion matrix are retained as superseded pre-remediation history. Their source/dist fingerprint predates the terminal recovery, reader cursor, and cleanup-evidence corrections and must not be cited as the final validation authority.

`phase6-final-91d58c3ddb89-547388a13871.json` and its companion matrix are retained as superseded diagnostic history. They established complete coverage and exposed the reconnect, oversized-delivery, and concurrent-reader regressions that the final matrix confirms are resolved.

`phase6-final-206435f3ff2e-4ea5d7ff205d.json` is retained as superseded history. It measured a valid host plateau but its companion catalog had only one active scenario, so it cannot establish plan-wide coverage.

`../evidence/phase6-xterm-retention-5.5.0-vs-6.0.0.json` contains three real-Chromium comparisons of 30 terminal lifecycle cycles per version. xterm 6 retained zero event listeners in every trial versus 60, 60, and 66 on xterm 5.5. Heap and browser-process RSS deltas overlap run noise; both versions plateau over the final ten cycles.

A pristine-master artifact is not required for operational Phase 2+ comparisons. Generate it separately only when an instrumentation-overhead study or reproduction of the pre-instrumentation investigation is explicitly in scope.

The authoritative Phase 1 and Phase 2 runs' strict report-level evaluations are accepted but record `pass: false` solely because the capture host exposed neither host nor cgroup memory PSI. The fail-closed `memory-psi-full-avg10` sentinel therefore remains unavailable; the other quantitative, liveness, isolation, cleanup, freshness, and plateau checks pass. Do not reinterpret unavailable PSI as zero pressure.

## Isolation and target selection

Every soak run rejects the run if the sampler PID appears in the target tree or if target/workload process trees overlap. The application process-tree root comes from `--target-pid`; the harness walks `/proc` to include descendants.

To find the application PID:

```bash
jq .pid ~/.devchain/runtime.json
# Or inspect the backend process directly:
pgrep -f "node.*local-app"
```

Example regeneration command (choose the output name after reading the report's target commit/digest):

```bash
pnpm --filter local-app memory-soak -- \
  --scenario host-burst-plateau \
  --profile baseline \
  --target-pid <application-pid> \
  --metrics-url http://127.0.0.1:3000/api/debug/metrics \
  --expected-repo-root "$(pwd)" \
  --report /tmp/phase1-instrumented-candidate.json
```
