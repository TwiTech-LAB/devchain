---
name: code-simplifier
displayName: Code Simplifier
description: "Review a change set for reuse, simplification, efficiency, and altitude problems, then apply the fixes while preserving exact behavior. Scopes to the diff, applies the target project's coding standards, runs four independent review angles (in parallel when the runtime can spawn sub-agents, otherwise as separate sequential passes), verifies with the project's own commands, and reports what was fixed and what was skipped. Use at phase close, before a commit, or when asked to simplify, clean up, or polish code. Triggers: simplify this code, clean up, refine, make this more readable, reduce complexity, quality pass."
version: 0.2.0
license: "Adapted from the @claude-plugins-official code-simplifier agent prompt and the Claude Code /simplify command"
---

# Code Simplifier

Improve the quality of a change set without changing what it does. The goal is code that
is easier to understand, reuse, debug, and extend — not code with fewer lines. This skill
does not hunt for correctness bugs; a code review does that.

## Phase 0 — Scope the change set

1. Build the unified diff under review, in this order of preference:
   - `git diff @{upstream}...HEAD`; if there is no upstream, `git diff main...HEAD` or
     `git diff HEAD~1`.
   - If the range diff is empty, or there are uncommitted changes, also run
     `git diff HEAD` and include untracked files (`git status --short`, then
     `git diff --no-index /dev/null <file>` for each `??` entry).
   - If the user named a target (PR number, branch, path, or epic), review that instead.
2. Save the diff to a scratch file. Every reviewer reads the same file.
3. Treat the diff as the review scope. Read the full current version of a touched file
   only when the diff context is not enough to judge a finding.

## Phase 1 — Load the project's standards

Before any review or edit:

- Read the project's standards documentation if it exists (for example
  `docs/development-standards.md`, `CONTRIBUTING.md`, `CLAUDE.md`, or `AGENTS.md`), and
  the validation commands it names (build, lint, tests, module-graph check).
- Respect lint and formatter configuration (ESLint, Prettier, EditorConfig, or the
  language's equivalent).
- Match the surrounding code's idiom: import style and ordering, function declaration
  style, type annotations, error-handling patterns, naming conventions.
- Where no standard exists, follow the dominant style already present in the file.

Pass these standards to every reviewer in Phase 2. A finding that contradicts a documented
standard is dropped.

## Phase 2 — Review from four angles

Run four independent reviews. Each reviewer gets the diff, the standards, and ONE angle.

- If the runtime can spawn sub-agents, launch all four in one step so they run in parallel.
- If it cannot, run the four angles as separate sequential passes. Finish one angle and
  write its findings to the scratch file before starting the next. Do not fix anything
  between passes; a fix made mid-review changes what later angles see.

Every finding has: `file`, `line` (new-file numbering), a one-line `summary`, the concrete
`cost` (what is duplicated, wasted, or harder to maintain), and the `alternative` that keeps
behavior identical. A reviewer that finds nothing says so.

### Angle 1 — Reuse

Flag new code that re-implements something the codebase already has. Search shared and
utility modules and files adjacent to the change (helpers next to the touched files,
`common/`, `lib/`, `utils/`, shared UI primitives, test fixtures). Name the existing
helper, component, or pattern to call instead. Include duplication inside the diff itself
(the same function copied into a server file and a UI file, the same fixture in three
specs).

### Angle 2 — Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state, copy-paste with
slight variation, deep nesting, nested ternaries, dead branches, intermediate collections
that only repackage another, comments that restate the code, types spelled out inline more
than once, and documentation paragraphs repeated for sibling features. Name the simpler
form that does the same job.

### Angle 3 — Efficiency

Flag wasted work the diff introduces: repeated I/O or queries where one would do, results
fetched and then discarded (rows requested when only a count is read), independent
operations run sequentially when the backend is truly asynchronous, blocking work added to
startup or hot paths, and long-lived objects built from closures that capture large scopes.
Name the cheaper alternative and state why behavior stays identical. Ignore
micro-optimizations with no practical cost, and say when the backend is synchronous so
that parallelizing awaits would buy nothing.

### Angle 4 — Altitude

Check that each change is made at the right depth. Flag special cases layered onto shared
infrastructure where a simpler, more general change to the underlying mechanism would do:
a branch keyed on one input's name instead of on its declared kind, the same contract
(input definition, error text, result shape) owned by two call sites instead of one
module, two components in one file disagreeing about what an option's identity is, a
name or message that is specific when the mechanism is generic. Name the deeper change.
Respect design decisions the user or plan already made; list them as "intended, not
flagged".

## Phase 3 — Reconcile

1. Merge the four lists. Deduplicate findings that point at the same line or mechanism;
   keep the version with the best evidence.
2. Verify every claim that depends on a dependency's behavior by reading the installed
   code (for example how the ORM renders a zero limit, or what a delegate does with an
   option) before acting on it.
3. Skip a finding, and record the reason, when its fix would:
   - change intended or observable behavior (including timing: a fetch moved later, a
     validation that can now run before its data arrives);
   - require changes well outside the reviewed diff, or new shared structure that the
     plan did not ask for (a new hook, a new primitive, a new module);
   - merge two branches that differ in a rule nobody chose to unify (for example
     case-sensitive versus case-insensitive matching);
   - contradict a documented project standard;
   - be a false positive.
4. Order what remains by payoff: shared ownership and duplication first, cosmetic last.

## Phase 4 — Apply

Fix each remaining finding directly, in the reviewed files only. Keep every edit
behavior-neutral. Prefer explicit, readable code over compact or clever code. Avoid nested
ternaries; use `if`/`else` or `switch` for several conditions. Do not combine unrelated
concerns into one function, and do not remove an abstraction that improves organization.

## Phase 5 — Verify

Run the project's own validation commands from Phase 1 for the touched scope: lint with
auto-fix, the type check or build, and the tests that cover the touched files (including
UI bundle build when a new cross-boundary import was added).

A test that fails after a simplification is evidence against the simplification, not
against the test. Revert that change, keep the test, and record the finding as skipped
with the observed failure as the reason. Never edit a test to make a quality change pass.

## Phase 6 — Report

Report, briefly:

- **Fixed:** each applied finding in one line, grouped by mechanism, not narrated edit by
  edit.
- **Skipped:** each skipped finding with its reason from Phase 3 or Phase 5.
- **Verification:** the commands run and their results, stated plainly.
- **Suspected bugs:** anything that looked wrong but was left alone because this skill
  does not change behavior.

If the code was already clean, say so.

## Limits

- Quality only. No bug hunting, no new features, no security review.
- Never "fix" behavior while simplifying, even if it looks wrong; flag it in the report.
- Do not reformat or restructure untouched files just because they were opened for
  context.
- Do not commit. The user commits at their discretion.
