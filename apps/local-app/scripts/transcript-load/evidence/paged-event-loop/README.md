# Paged transcript event-loop evidence

Generated Claude transcripts, three sequential rounds per scenario. These are host-specific observations, not a universal timing guarantee.

| Fixture | Endpoint | Before max delay (ms) | After max delay (ms) |
| --- | --- | ---: | ---: |
| large | Index + pages | 220.86 | 18.19 |
| large | Chunk page | 153.88 | 17.06 |
| large | Empty tail | 27.84 | 16.94 |
| large | Catch-up tail | 879.23 | 17.06 |
| dense | Index + pages | 82.71 | 32.54 |
| dense | Chunk page | 62.16 | 16.62 |
| dense | Empty tail | 52.23 | 18.91 |
| dense | Catch-up tail | 884.47 | 23.13 |

The large-answer fixture has 412 messages and 57,726,624 bytes. The dense fixture has 23,134 messages and 57,675,347 bytes. Both exceed the unchanged 64 MiB cache budget at 2x source weight. All measured requests left zero retained cache entries and every streamed response matched the controller DTO’s native JSON hash. Fixtures were removed after all four runs.

The harness exercises actual Nest/Fastify REST routes over loopback HTTP. `monitorEventLoopDelay` samples at 1 ms; the measured interval includes parsing, chunk construction, projection, encoding, network output, and incremental client hashing. Native JSON parity checks and explicit GC happen outside measured intervals. RSS includes the harness and its transient parity-check allocations. The `encodeAndStreamResponse` stage includes backpressure/network time, so its elapsed duration is not a synchronous-block measurement.

Historical runs load the six changed pre-existing pipeline files from the recorded `head` revision, transpiled in memory at their normal module paths. The same built dependencies are used in both runs. Each report records source/dist/harness hashes and environment details. Cursor hashes differ between separately generated files because source revisions include file identity; parity is checked within each run.

Reproduce from the repo root after `pnpm --filter local-app build`, using fresh report paths:

```bash
node --test apps/local-app/scripts/transcript-paged-load.test.js
node --expose-gc apps/local-app/scripts/transcript-paged-load.js --baseline-ref afc4af1a373925f5a6e78747e9b5c2b69ed13c1a --report /tmp/large-before.json
node --expose-gc apps/local-app/scripts/transcript-paged-load.js --report /tmp/large-after.json
node --expose-gc apps/local-app/scripts/transcript-paged-load.js --text-kib 4 --baseline-ref afc4af1a373925f5a6e78747e9b5c2b69ed13c1a --report /tmp/dense-before.json
node --expose-gc apps/local-app/scripts/transcript-paged-load.js --text-kib 4 --report /tmp/dense-after.json
```
