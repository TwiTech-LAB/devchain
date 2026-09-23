---
name: create-commit
displayName: Create Commit
description: "Create a git commit whose message records why the change exists, not just what changed. Keeps one logical change per commit, stages only the files that belong to it, matches the repo's existing commit style, keeps the body to decisions and traps rather than implementation, and shows the message and staged files for user approval before committing. Use when asked to commit work or write a commit message. Triggers: create a commit, commit this, commit the changes, write a commit message."
version: 0.2.0
license: "MIT"
---

# Create Commit

Create a commit for the work done. Your commit message is the only durable record of
*why* this change exists. The diff already says what changed. If you only restate the
diff, the reasoning dies with your session.

## One logical change per commit

- A commit contains one change a reviewer can accept or revert as a unit. If the
  working tree holds two independent changes (a feature and an unrelated fix, code and
  a skill edit), make two commits.
- A feature and the cleanup pass that reshaped it before anyone saw it are one change.
  A cleanup of code that already landed is its own commit.
- Use `git add -p` when one file mixes both.

## Subject line

- Conventional prefix + scope, matching this repo's existing style — run
  `git log --oneline -15` and match what you see, don't impose a new convention.
- Imperative mood, 50 characters as the target, 72 as the hard limit, no trailing
  period.
- Describe the change in the reader's terms, not the file's: "render event pulses as
  glowing dots", not "update AgentEventBus.tsx".
- A change that breaks an existing contract (API, schema, stored format, CLI flag) adds
  `!` after the scope and a `BREAKING CHANGE:` footer that says what breaks and what to
  do about it.

## Body — spend your context here

Wrap at 72 chars. Blank line after the subject. Cover, in rough priority order:

1. **What was wrong before.** State the old behaviour concretely, with the values or
   paths that made it wrong.
2. **Why the obvious fix doesn't work.** If you hit a trap that cost you time, record
   it. The next person will otherwise hit it too. This is the highest value content in
   the message.
3. **Non-obvious constraints** that shaped the approach — a platform limit, an
   invariant, a rule you had to work around.
4. **Misleading diffs.** If a file's line count overstates the real change
   (autoformatting, reindentation, generated output), say so and say what the real
   change is. This saves a reviewer from hunting.
5. **Collateral fixes** and why they were needed — e.g. a test that was stale for an
   unrelated reason you discovered while working.

### Length

- A paragraph earns its place only if it records a decision the diff cannot show, or a
  trap. A paragraph that describes what the code now does is the diff in prose; delete
  it.
- Most bodies fit in three to twelve lines. A body past twenty lines usually contains
  implementation narration; re-read it against the rule above.
- A trivial change (a version bump, a typo, a renamed constant) needs no body. The
  subject alone is the message: `chore(templates): bump version`.
- The plan, the epic, and the review already hold the full design. The commit records
  what a reader of `git log` cannot get elsewhere.

## Never

- Never invent rationale. If you did not do the work and cannot recover the "why" from
  the diff, prior commits, code comments, or the linked task, then either ask, or write
  only what you can verify. Plausible-sounding invented reasoning is worse than none.
- Never claim verification you didn't run. Don't write "all tests pass" unless you ran
  them and saw them pass.
- No marketing language, no adjectives like "robust" / "improved" / "comprehensive".
  State the mechanism, let the reader judge.
- No process narration. "First I tried X, then Y" belongs nowhere. State the resulting
  facts.
- No filler trailers unless this repo actually uses them.

## Scope discipline

- Commit only files belonging to this change. If the working tree contains unrelated
  work (common in shared worktrees), stage selectively, leave the rest, and say in your
  report what you left and why.
- Before staging a file with a suspiciously large diff, check `git diff -w` to confirm
  what's actually semantic.
- Don't push unless asked.
- Never use `--no-verify` or skip hooks.

## Before committing

- Re-read your own message and delete every sentence that only restates the diff. What
  remains is the message.
- Show the user the final message and the list of files you staged, then stop and wait.
  Commit only after the user approves. If the user asks for changes, update the message
  and show it again.
