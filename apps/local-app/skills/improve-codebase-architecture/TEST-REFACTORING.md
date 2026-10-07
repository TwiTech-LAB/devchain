# Test Refactoring (optional)

An opt-in track for Phases 1, 2 and 5. It runs only when the user includes test refactoring in the run (Phase 0). It reduces the test suite without losing defect detection: it collapses duplicates, removes tests that prove nothing, merges sibling spec files and cuts fixture cost. It never changes application code.

Uses VOCABULARY.md: a test exercises a **module** through its **interface**, and a wiring test sits at a **seam**. "Replace, don't layer" applies.

## Phase 1 — Test sweep

Measure before you judge. Run the suite once with per-file timing (for example, Jest `--json --outputFile`). Rank folders by summed file time and test count, then look for:

1. **Duplicates.** Two tests with the same setup, input partition and observable outcome.
2. **Layer copies.** One rule asserted at several layers. The cheapest layer that can catch the bug owns it; keep one wiring test per seam.
3. **Tautological tests.** Tests that never call application code, or that assert only on values or mocks they built themselves.
4. **Sibling files.** Test files with the same subject and the same setup. Each file pays its own environment and module-load cost.
5. **Fixture cost.** Per-test schema migrations, app boots, real sleeps and fixed timeouts. Prefer a per-file snapshot, a shared boot, fake timers or shorter test-only timeouts.
6. **Dead tests.** Skipped or empty tests.
7. **Low-value tests.** Tests that match a low-value rule below.

Labels such as "mock echo", "metadata" or "shape" mark candidates. They are not evidence.

## Removal rule

Remove a test when one of these holds:

- **Duplicate:** a kept test has the same setup and input partition, and asserts the same observable outcome.
- **Tautological:** it never calls application code, or asserts only values or mocks it built.
- **Low value:** it matches a "do not write" rule in the project's testing standards. If the project has none, use these. The test:
  - only checks a call on an internal mock, unless the call is the contract (event, process, network);
  - checks static UI text, markup or styling;
  - checks rules a library enforces;
  - repeats another test with only different input; fold it into one table-driven test or drop cases that hit the same branch;
  - only checks existence or no error;
  - unit-tests code that only forwards calls, with mocked dependencies; keep one test through the real entry point;
  - re-tests a child component or shared helper that has its own tests.

Keep these, even when they look repetitive: race and ordering invariants, retries and reconnects, events at module boundaries, real-database round trips, query-count guards, security checks, error mapping that changes the result, and the only test of a seam (wiring, recovery, shutdown). When unsure, keep the test and mark it borderline. Never delete on textual similarity alone.

## Phase 2 — Test candidate cards

Add a `## Test candidates` section after the architecture candidates, with one card per module group:

- **Badge row:** strength (`Strong`, `Worth exploring`, `Speculative`) and kind (`duplicate`, `layer copy`, `tautological`, `low value`, `merge`, `fixture cost`).
- **Files:** a fenced block.
- **Problem:** one sentence, with numbers (tests, files, seconds).
- **Solution:** one sentence.
- **Wins:** tests removed, files merged, seconds saved, labelled as estimates.

No diagrams. The user picks which test candidates to include. They need no design interview unless a removal needs a decision.

## Phase 5 — Test cleanup epics

Create one sub-epic per module group, with its item list in the epic. Each DoD requires:

- Before and after numbers for the same file set and settings: test count, file count, wall time and summed file time.
- Coverage that drops only on pass-through, static or library-enforced code, with a replacement test where a removal leaves real behavior untested.
- A list of kept test → removed test.
- Table-driven folds reported as maintenance, not as fewer tests.
