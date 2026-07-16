# Memory soak harness

This opt-in integration harness creates an isolated tmux server with deterministic chatty Node.js workloads, samples memory over named phases, and emits a JSON pass/fail report. It never writes application storage or joins the user's normal tmux server.

## Run

From the repository root:

```bash
pnpm --filter local-app memory-soak -- --scenario host-burst-plateau --profile baseline --report /tmp/devchain-memory-baseline.json
```

Add `--target-pid <pid>` to account for a running Local App process and all of its descendants. Add `--metrics-url <url>` after the application memory-counter endpoint is available; only numeric leaves are retained in the report. Use `--expected-repo-root <path>` in worktrees to fail closed when the command is launched from the wrong checkout.

Fixture-backed scenarios use `--app-entry <path>` to select the built Local App entrypoint. The
default is `apps/local-app/dist/main.js` in the selected repository. Build provenance is captured
from the spawned PID, so a missing or non-running entry cannot produce accepted fixture evidence.

List the machine-readable scenario catalog and activation notes:

```bash
pnpm --filter local-app memory-soak -- --list --report /tmp/devchain-memory-scenarios.json
```

Profiles are `smoke` (about 5 seconds), `baseline` (15 seconds), and `soak` (about 4.5 minutes). The default fixed seed is `1337`; rates, session count, seed, and chunk size are recorded in each report.

## Pass/fail contract

The active `host-burst-plateau` scenario records:

- host memory availability, swap use, and `/proc/pressure/memory` values;
- target and owned-workload process trees with per-process and aggregate RSS/swap;
- cgroup v2 `memory.current`, `memory.swap.current`, and memory pressure when available;
- optional numeric application counters;
- output bytes, bursts, chunks, forced-GC count, and churn-cycle count per scratch session.

The runner applies explicit thresholds for sample count, output volume, target/workload peak RSS, target swap, memory PSI, cleanup, and RSS plateau. Plateau is the combined target + owned-workload RSS median over the final three samples of each of two cache-churn cycles. It passes when growth is within either the absolute byte allowance or the relative allowance; both values are included in the report.

Programmatic report evaluation has one supported entry point:
`evaluateReport(report, thresholds)` in `lib/evaluate.js`. It validates the report schema and
harness/target provenance before any quantitative check can run. Only the current schema version is
accepted. Every sample tree, generator PID set, workload-session metric, threshold, and cleanup
field read by the evaluator is type-checked, with unavailable cgroup and PSI evidence represented
explicitly. Malformed evidence is refused with named paths, and unexpected evaluator failures are
returned as refusals instead of escaping as exceptions. The CLI runner and baseline contract
validation both use this strict entry point. `evaluateRun` and the individual check helpers remain
exported only as pure unit-test seams; application and validation callers must not bypass
`evaluateReport`.

`reportKind: "fixture-scenario"` uses the same schema version, provenance gate, and
`evaluateReport` entry point. Its evidence names the app/runtime readiness, runtime-token-bound
Socket.IO attach, deterministic scratch session, procfs process-tree samples, and cleanup result.
Socket scenario reports also contain machine-readable correctness checks and two-cycle RSS plateau
evidence. Malformed fixture evidence is refused with its full path before any pass/fail check runs.

The target is sampled observationally and is never sent a GC signal. Owned workload processes run with `--expose-gc` and force GC after each deterministic retained-buffer replacement, so before/after churn samples are comparable.

When application counters include Local App cache metrics, `caches.aggregate.bytesEstimated` is a
complete-snapshot view cached for 10 seconds. Retained-root providers stage visited identities and
commit them only after a complete successful provider walk; a failed provider is zeroed without
suppressing shared objects retained by later healthy providers
(`src/modules/metrics/services/metrics.service.ts`).

## Scenario activation

`lib/scenarios.js` is the scenario source of truth. The runner selects an implementation by each
scenario's `execution` value. A pending scenario, or an active scenario whose execution has no
registered implementation, returns the same JSON `status: "pending"` stub instead of falling
through to the host runner.

`lib/app-fixture.js` provides the shared disposable app foundation. It redirects `HOME`, SQLite,
runtime metadata, worktree paths, and `TMUX_TMPDIR` beneath one temporary root; starts the selected
entrypoint on an OS-assigned loopback port; verifies its one-run runtime token; creates a
deterministic scratch tmux session and matching scratch-database session row; attaches a Socket.IO
client; and samples both process trees. Teardown disconnects the client, terminates the app process
group, kills the isolated tmux server, removes the temporary root, and reports every observed PID
or path that survived. It never joins the user's default tmux server or writes their application
storage.

Teardown retains every fixture-created Socket.IO client reference until cleanup verification. It
records the observed count and each client's disconnect attempt, error, bounded-wait result, and
final connected state before removing listeners or clearing the registry. Socket-backed reports
are refused when the observation count is zero or below the scenario's client count; a disconnect
error, timeout, or connected survivor fails the cleanup gate while the remaining process, tmux, and
storage cleanup attempts still run.

The `many-subscribers-one-session`, `reconnect-replay-available`, and
`reconnect-older-than-ring` scenarios use the real gateway. They rehydrate the scratch session,
observe fresh seed captures through `/api/debug/metrics`, retain and replay sequence watermarks,
and compare received terminal bytes against a fresh strict tmux capture by rendering them in an
isolated comparison pane. Clients acknowledge the application heartbeat throughout the soak.

The many-subscriber and covered-replay scenarios establish a retained-state barrier after their
correctness checks: the isolated tmux server uses a 256-line history cap, normal generator output is
paused, and a bounded one-row fill loop normalizes tmux `history_size` to exactly 256 after its batch
pruning. The final generator and fill markers must be rendered before plateau sampling begins.
Stable state means every expected socket remains connected in every sample, server connection count
does not fall below that set, history stays exactly at the configured cap, output byte/chunk counters
do not advance, and each cycle performs only its explicit memory churn. Missing or changing evidence
causes the strict evaluator to refuse the report. The report also derives target, tmux-server, and
generator tail medians from the sampled process rows. The combined plateau still includes the tmux
server and retains the unchanged 32 MiB / 10% limits; the barrier makes retained workload state
deterministic rather than excluding it or relaxing the gate. Covered replay additionally requires
the resident replay session/frame/byte state in every sample.

The `stalled-and-current-socket` and `engine-write-buffer-bounded` scenarios preload a control
hook only into the disposable child process, then make one authenticated client's Engine.IO
transport deterministically unwritable. The host-burst generator continues driving the shared
session while the report samples both clients' application queue bytes and Engine.IO buffered
packets. `evaluateReport` gates the stalled queue against the production 5 MiB policy, requires
that policy to become observable through queue growth and desynchronization/disconnection, and
independently bounds the current client's queue, buffered packets, and timestamp-marker delivery
latency. The preload and its one-run secret do not exist in a normal application launch.

The `oversized-unicode-ansi-chunking` and `seed-during-burst` scenarios replay targeted seed and
live `data` envelopes into `@xterm/headless` 6, then compare visible text and styled Unicode cells
with a fresh escaped tmux capture. The oversized driver forces generator chunks above 64 KiB and
asserts UTF-8 round trips, sequence order, replacement-character absence, and ANSI styling. The
burst driver deliberately withholds `terminal:resync_complete` while at least 20 frames arrive,
then requires the covered tail to begin at `capturedSequence + 1` without a gap before comparing
the final terminal state.

The `zero-web-mobile-activity` scenario uses an authenticated loopback bridge fixture against the
Local App's real tunnel ingress. It serves a disposable JWKS, issues a five-minute JWT scoped to
the scratch project, verifies the Local App's Ed25519 tunnel attestation, and launches the fake
provider through mobile `chat.launchAgent` before leasing `terminal.viewport.subscribe`. The
report requires viewport sequence/content and persisted session activity to advance while every
sample reports zero connected web Socket.IO clients. The token, keys, app storage, provider
processes, tmux server, and bridge listener are all confined to and removed with the fixture.

The `lifecycle-cleanup-parity` scenario launches scratch sessions through the authenticated mobile
path, attaches a real Socket.IO terminal subscriber, and terminates them by clean API stop, a real
provider `SIGKILL`, or direct removal of the tmux target. A fixture-only child preload observes the
actual registry, frame-listener, PTY, and replay-buffer maps after their existing lifecycle methods
run; procfs PTY descriptors and the public metrics snapshot cross-check those counts. The normal
60-second stopped-session replay setting is not overridden; any earlier cleanup caused by later
real lifecycle events is recorded in the per-path latency. A separate tmux workload anchor stays
alive solely so repeated create/terminate samples retain strict process-tree and generator-liveness
evidence for the two-cycle RSS plateau evaluation.

The `summary-full-provider-parity` scenario captures the provider list at runtime from
`SessionReaderAdapterFactory.getSupportedProviders()` and loads the matching committed fixtures
under `fixtures/provider-transcripts/` into disposable storage. It requires exact summary fields
to match full-transcript metrics for every registered provider and records any differences only
for fields that the adapter declares approximate. Every summary and full read has a corresponding
memory sample, and the registry coverage, metric parity, read sampling, plateau, and cleanup
evidence all pass through `evaluateReport`.

The `eviction-concurrent-transcript-reads` scenario creates three seed-derived Claude transcripts
inside the disposable home and runs concurrent summary, index, and paged-chunk requests while a
round-robin reader forces whole composite entries through a harness-only 768 KiB budget. Every
generation carries an exact marker and message/chunk totals, so the report fails on mixed reads,
unbounded retained bytes, missing cache hits/misses or evictions, or a metrics window that does not
cross the 10-second aggregate-snapshot TTL. The same report is evaluated for the standard
two-cycle RSS plateau and full fixture cleanup.

`@xterm/headless` is intentionally a Local App devDependency at 6.0.0, matching the shipped xterm
major. It is loaded only by this opt-in harness and is not a production runtime dependency; its
presence provides a real parser/render-state oracle without restoring the vestigial production
dependency that was removed during the xterm 6 upgrade.

Socket smoke and baseline profiles collect short plateau cycles; soak collects 30 one-second
samples per cycle. Other protocol-specific scenarios remain pending until their individual drivers
register an execution implementation. The active host scenario continues to exercise deterministic
multi-session burst shape, foreground/background phases, Unicode/ANSI output, two churn cycles,
host/cgroup/process sampling, and isolation.

## Tests

The Node.js contract tests, including local child-process checks for target provenance and the
disposable app/tmux/Socket.IO lifecycle, are intentionally separate from the default Jest gate:

```bash
pnpm --filter local-app memory-soak:test
```

The harness itself is an opt-in integration artifact. Run it deliberately on a quiet host for comparable baselines; host PSI and cgroup totals can include unrelated processes in a shared cgroup.

Target-build provenance, truthful artifact naming, and the baseline comparison policy are documented in `baselines/README.md`.

## Publishing final evidence

A prose validation report is only an index into machine-readable evidence. Publish it from one
matrix manifest whose scenario reports all name the same clean `target.provenance.commit` and
`target.provenance.buildFingerprint.digest`. Cite the exact matrix, self-hash-excluding manifest,
host baseline, focused-gate artifact, fixture directory, full source checkpoint/tree, full dist
digest, and their SHA-256 values. Copy per-scenario, confirmation, focused-gate, correctness,
plateau, and cleanup outcomes from the matrix or manifest; do not infer them from logs or reuse
values from a superseded matrix.

Preserve failed or superseded attempts and any ignored runtime input needed for reproduction in the
manifest with their disposition, provisioning contract, byte count, and hashes. Verify every
current manifest entry by path, byte count, and SHA-256; when the matrix names a superseded manifest,
verify that historical manifest too instead of copying its prior verification claim. An
environmental sentinel such as unavailable PSI remains a failed strict check with `actual: null`;
the prose may describe an approved environmental deviation but must never rewrite it as a pass.
The published verdict must equal the matrix verdict recorded by the manifest. See
`docs/mem-relief-v1-final-validation.md` for the currently authoritative manifest and report.
