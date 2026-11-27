> **Type:** agent-reference (v1.3)
> **Priority:** mandatory

Code Review Method

How to review a change set for real defects. The lead Code Reviewer and the Peer Reviewers of its team use the same method.

The review bar:

  - Findings anchor to the change. Unchanged code is in scope when the change newly calls it, composes it or relies on its guarantees — the composed behavior belongs to this change. Issues in code that the change neither modified nor newly depends on are out of scope: do not report them. One exception, the PRE-EXISTING SEVERE problem: an out-of-scope problem that holds after verification (Step 4) and whose consequence is severe and hard to undo (lost or corrupted data, a wrong write to an external system, a security flaw). Report it in its own section. It never blocks the review. Do not search for such problems: report one only when you meet it while you review the change.
  - No cosmetic findings: formatting, naming, comment wording, import order, duplication or "could be simpler" without a concrete cost, or anything a linter enforces. Also not findings: missing docstrings, magic numbers, dead code without effect, and "while you are at it" requests.

Context, for every epic under review:
  - Read its tasks and descriptions. Their business intent and acceptance criteria define what the change was SUPPOSED to do: that is your review target.
  - Read docs/development-standards.md (if present): it is the review bar (Step 5).
  - Note deferrals and accepted risks ("Deferred: <X> — backlog" or "Accepted: <X>" in the epic/plan, Backlog CONCERN items). They are settled decisions: do NOT resurrect them as findings. A deferral counts only when the tracker records the specific risk and the decision to accept it. Docs, plans, comments and passing tests are claims to verify, not proof; untracked or gitignored documents are context, not acceptance.
  - A Peer Reviewer takes the acceptance criteria, the standards sections and the deferrals from the review request, and reads a task only when a criterion is unclear.

The change set:

Changes live where the flow puts them: the root working tree by default; lanes or a range only when the flow uses them. Collect from each source that applies:
  - Root working tree: `git status`, `git diff`, `git diff --cached`, untracked files.
  - Lanes: when devchain_get_epic_by_id lists `worktrees` (path, baseBranch), `git -C <path> diff <baseBranch>...HEAD` plus the lane's uncommitted changes.
  - A range that the review request names (e.g. `main...phase/x`).
  - Commits: when the epic's work is already committed and no range is named, its commits from the epic, its comments or `git log` (on a re-review, the commits since your last review).
Review source, tests, config, migrations, CI and deploy files, and docs that state behavior; skip lockfiles, binary assets and generated code.
Read each changed hunk with its enclosing function, plus what the change newly calls or relies on: callers, callees, client or transport config, and the process runner (entry point, error handling, exit). Read a whole file when it is small, or when the change depends on state that the file keeps. The surrounding code is context; the change is the review subject.
A Peer Reviewer reads only the sources that the review request names.

**Step 1 — System view** (before judging any line): describe how the change behaves in the running system — its trigger, the durable and in-memory state it keeps, its external effects, and what happens when a step repeats, arrives late, runs concurrently, fails partway, runs for minutes, or the process restarts. When the change calls or waits on an external system, or changes its client, timers, retries or lifecycle, note the contract that the diff does not show for that system: timeouts and liveness intervals, leases, limits, delivery semantics, error mapping. Otherwise skip that note. Findings may come from this model, not only from changed lines.

**Step 2 — Discovery:** write every candidate down (`file:line — suspected failure`) before judging any; never drop one because it seems fine. Angles:
  A. Line by line, with the enclosing function: wrong condition or boundary, wrong variable, missing await, swallowed error, mixed units; the error paths of new code.
  B. Removed behavior: where does the new code re-establish each deleted guard, validation, error path or test? Did moved code lose a guard?
  C. Callers and callees: new preconditions, exceptions, return shapes or ordering; a new use that breaks a callee's contract, infrastructure included.
  D. Time and lifecycle (only when the change touches timers, waits, retries, concurrency or shutdown): a window or threshold equal to or longer than an external timeout; a wait that stops polling, heartbeats or lease renewal; a state with no exit; a hot loop; thresholds without hysteresis; in-memory state lost on restart; duplicates and reordering under retries.
  E. Bounds and volume (only when the change touches a limit, a hot-path query or a loop over data): when a limit rises or disappears, re-check what it protected; hot-path queries at realistic and maximum volume.
  F. Config and compatibility: new or flipped defaults against related defaults, partial overrides, validation that rejects a once-valid value, every place that sets it; API, schema, event and log-field contracts; migrations and rollback.
  G. Claims: each guarantee in the epic, plan, docs or comments ("always", "never", "safe") is a hypothesis to break; test each acceptance criterion's hardest stated case.
  H. Tests: would each new test fail if its behavior broke? Are its preconditions real, and its fakes true to the real contract? Is each candidate's path tested?
  I. Language pitfalls; security on reachable paths (injection, AuthZ, secrets or personal data in logs, input validation).

**Step 3 — Triage (before you verify):** remove a candidate now, without verification, when it is not a finding (the review bar) or when its trigger is unlikely in this system: it needs two or more rare conditions at the same time, a configuration that no environment has, an operator action outside the documented procedure, a timing window of seconds, or a scale that the system does not reach. The test: do you expect the trigger at least once in a year of normal operation? If not, remove the candidate. Exception: keep it when the consequence is severe and hard to undo (lost or corrupted data, a wrong write to an external system, a security flaw); it is then a DEFECT, never a CRITICAL, and the finding says that the trigger is rare. The exception needs a real producer. Name what produces the trigger in this system: a caller, a retry, a restart, a failing dependency, existing data, or untrusted input. Remove a candidate whose trigger only a test double can produce. On a re-review, a variant of an earlier finding is a new candidate: triage it here. It does not inherit the tier of the earlier finding.

**Step 4 — Verification:** try to disprove each candidate with the cheapest method that settles it: read the full path from trigger to effect; check the effective config and defaults; check the base branch for the same problem; run the tests that cover the touched code (one test file or one test); write a scratch test or script against the real library or code path. Never write to shared or production systems. Verdict: CONFIRMED (classify it, keep the evidence), REFUTED (drop it), or UNSETTLED (a non-blocking question: never CRITICAL or DEFECT, never dropped silently). A false must-fix costs the team a remediation cycle; an unrecorded dismissal ships a bug. Do not run the full test suite: the Epic Manager runs it once on the combined change before the review.

**Step 5 — Classification.** docs/development-standards.md and the codebase's own conventions are the review bar. Do NOT demand patterns the project does not use (DI containers, domain-error hierarchies, strict layering, schema middleware); a new codebase-wide pattern is planning work, not review feedback. Where the project is silent: keep the existing layering and dependency wiring; no swallowed errors; security on reachable paths (SQL injection, input validation, AuthZ); performance where the data volume matters (N+1, nested loops).

Classify each CONFIRMED finding into exactly one tier. A pre-existing issue in a touched file that the change does not newly rely on, or a gap outside the acceptance criteria, has no tier: drop it, unless it is a PRE-EXISTING SEVERE problem (the review bar).

* **CRITICAL** (blocks approval; must be fixed) — ALL of:
  1. Introduced or materially modified by this change, including pre-existing behavior that it newly relies on or makes certain;
  2. Breaks the epic's stated goal or fails under NORMAL expected use — or is a security flaw on a realistic path, or violates a documented project standard;
  3. file:line plus a concrete failure scenario ("given X input/state, Y happens"), with proof. When the failure is visible in the quoted lines, quote them. When it depends on library behavior, configuration or a path across functions, the proof must have run: a failing test, a script or a reproduction. If it cannot be run, say why in one sentence.
  Normal use includes what the architecture makes routine: repeats, concurrency, partial failure, late arrival, restarts, long waits. Misuse-only paths, features that don't exist yet and speculative scale are NOT critical — downgrade them, or drop them if validly deferred.
* **DEFECT** (blocks approval until fixed) — a real bug with a concrete scenario that misses the CRITICAL bar: rarer condition that still passes Step 3, recoverable impact, partial degradation, or no regression (the base branch behaves the same). It gets its own section, never folded into improvements.
* **IMPROVEMENT** (never blocks) — the code works, but has a concrete cost: a misleading doc, a slow path at realistic volume, a test that cannot catch a regression, a config trap. At most 3, ranked by consequence.

Drop anything with no failure and no cost. Rank by blast radius; merge related items into one finding per theme.

**Rule and trigger.** Each CRITICAL and DEFECT also states:
  - The rule that the code breaks, in one sentence. Write the rule, not the example: "every write path checks the input before it saves", not "add a check to the import form". Name the other sites that you saw break the rule or obey it. Do not search the codebase for every site: the Brainstormer lists them before the fix.
  - The trigger: routine, or rare with its real producer and the reason why you kept it (Step 3).

### End of Method
