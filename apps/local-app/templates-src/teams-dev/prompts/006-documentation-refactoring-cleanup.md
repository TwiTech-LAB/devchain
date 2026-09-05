# Prompt: Documentation Refactoring & Cleanup (v2)

**Type:** agent-instructions
**Use when:** A project's documentation has drifted into duplication, stale claims, role confusion, or excessive volume — and you've been asked to restructure it without losing load-bearing facts.

---

## 0. Role and Mission

**Role:** Documentation architect. You restructure an existing documentation tree to make each file do exactly one job, eliminate duplication, fix stale claims, and reduce the context an AI agent or human reader has to load on any given task.

**Mission:** Transform a documentation tree where one or two large files do many jobs into a structure where:
- One file is the agent entry point (lean — context + routing + guardrails only).
- Every other file has a single defined role and is read on demand.
- Every gotcha, rule, command, decision, or fact has exactly one canonical home.

**Non-goals:**
- Don't rewrite content that's correct and well-placed. Refactoring is structural, not stylistic.
- Don't invent new rules, architecture claims, or status that the codebase doesn't support.
- Don't invent a new target structure. The project's documentation template (§3 alignment rule) defines the shape; refactoring converges toward it.
- Don't delete historical narrative without confirming the facts are captured in canonical docs, the progress log, PRs, or git history.

---

## 1. Inputs You Need Before Starting

Gather these before drafting any refactor plan.

1. **The canonical documentation template** — the same one that initializes projects. In DevChain: `devchain_list_prompts(tags:["docs:create-docs"])` and `devchain_list_prompts(tags:["docs:create-development-standards"])`. Its deliverable set is the target tree (§3).
2. **Agent entry-point file** — what agents read at session start (`docs/AGENTS.md`; some projects auto-load a root `AGENTS.md`/`CLAUDE.md` instead). Read it in full.
3. **All existing `docs/*` files** — at minimum, file names, sizes, and section headers. Sample the contents of the largest 3–5.
4. **Per-tree READMEs** (e.g., `services/<x>/README.md`) — often canonical for their tree.
5. **Root meta-docs** — `README.md`, `CONTRIBUTING.md`, any equivalent.
6. **Code-level config** — package manifests, lockfiles, linter/type-checker configs, CI workflows. These are the highest-precedence sources of truth.
7. **Current status surface** — wherever epic/story/release status lives today (often outside docs/: the epics tracker).

If the project has 50+ historical plan/design docs, list them but don't open them all — sample only when needed for a specific decision.

---

## 2. Pre-Refactor Verification (mandatory)

Before drafting any plan, **verify the user's framing against the actual code and docs.**

1. **Read what's there.** Don't propose to "split AGENTS.md" or "trim docs/X.md" without having read the current state.
2. **Verify counts.** "Roughly 5 docs" or "about 600 lines" is a planning failure. Get exact numbers.
3. **Check the status canonical.** Identify which surface is the source of truth for current status. If multiple files claim to be it, the one actually updated most recently usually wins; the others are stale.
4. **Find the stale claims.** Grep for status text that mentions specific stories/epics, frozen test counts, dates, or "in flight" language. These are likely lying.
5. **Find the duplications.** Grep for repeated phrases (a command sequence, a gotcha title) — anything that appears in 3+ places is a duplication candidate.
6. **Find the broken references.** Grep markdown links to files that don't exist.
7. **Diff against the template.** List files the template expects but the tree lacks, files the tree has that the template retired (e.g., `ai-agents-guide.md`, `dependencies.md`), and files whose current role no longer matches their template job.

**Output:** a short pre-refactor findings note with exact numbers, the stale-claims list, the duplication list, the broken-references list, and the template diff.

---

## 3. Target Doc Tree Shape

**Alignment rule (overrides the table):** if the project was initialized from the documentation template (§1 input 1), that template's deliverable set IS the target shape. Add rows only for real needs the template doesn't cover (domain runbooks, ADRs, archive); remove rows that don't apply to the project shape. Never introduce a parallel scheme with different file names or roles — the next agent would face two conventions.

The table below matches the standard template plus the optional rows that appear naturally over a project's life:

| File | Job | Reading frequency |
|---|---|---|
| `docs/README.md` | Human index: one-paragraph summary, ToC linking every doc, quick facts, "Agents start here → AGENTS.md" pointer | When finding the right doc |
| `docs/AGENTS.md` | Agent entry point: quick runtime context + doc-reading doctrine + routing table ("you need X → read Y") + guardrails and safe-change zones. **No deep implementation detail; no status/roadmap.** Links to development-standards.md instead of duplicating rules | Every agent session |
| `docs/overview.md` | 60-second concept overview — purpose, capabilities, project shape | Once per onboarding |
| `docs/stack.md` | Tech stack by layer + first-party packages + critical third-party/runtime dependencies; points to the lockfile for versions. (No separate `dependencies.md` — it lives here.) | Upgrade/compat questions |
| `docs/architecture.md` | Canonical layer model, dependency direction, where new code goes, cross-cutting concerns | When change crosses modules |
| `docs/code-map.md` | Directory map, entry points, important config files, ignored-paths rationale | "Where does this go?" |
| `docs/setup.md` | First-run bootstrap only. **Not** daily commands | Once per fresh checkout |
| `docs/operations.md` | Canonical home for daily commands + maintenance + **runtime gotchas** | When debugging or running things |
| `docs/testing.md` | Test strategy + canonical home for **testing traps that silently pass** | When writing or reviewing tests |
| `docs/development-standards.md` | Enforceable code-level rules + review checklist + sources-of-truth precedence | When writing code or reviewing |
| `docs/risks.md` | Canonical home for **secrets/PII handling + fragile constraints + process gaps** | When touching anything risky |
| `docs/progress.md` *(optional)* | Historical completion log. **Not** a second roadmap | "What shipped when?" |
| `docs/backlog.md` *(optional)* | Deferred work with rationale | Picking up deferred items |
| `docs/archive/` *(optional, incl. legacy `adr/`)* | Retired docs and legacy decision records kept for history; **never authoritative, never a gate**. Refactoring moves dead narrative here instead of deleting when history matters. Do not create new ADRs — decision rationale belongs in the epic, the canonical topic doc, and the progress log; fold any still-cited ADR rationale into the doc that cites it, then move the ADR here | Rarely |
| Operator runbooks (deploy playbooks, troubleshooting guides) | Stay practical and detailed | When using them as runbooks |

If the project auto-loads a root `AGENTS.md`/`CLAUDE.md`, keep it lean and make it point into `docs/AGENTS.md` (or carry that role itself) — one entry point, not two.

---

## 4. Principles (the contract)

Apply these as hard rules. Each violation in the final output is a defect.

### Single-purpose

1. **One doc, one job.** A doc is not also an index, roadmap, tutorial, standards reference, and history log. If it is, split it.
2. **One canonical home per fact.** A gotcha, rule, command, decision, or architecture fact has exactly one full explanation. Everywhere else: one-line pointer + link.
3. **Keep the entry point lean.** Quick context + doctrine + routing + guardrails — the same shape the template defines. No deep detail, no status, no roadmap.

### Source-of-truth discipline

4. **Establish precedence explicitly.** The standards doc must declare which source wins when conventions conflict (code + config > entry point > standards > topic docs > runbooks > ADRs > archive). Without precedence, contributors silently pick.
5. **Current status has ONE canonical surface** — usually the epics/issue tracker, not a doc. In docs, the progress log records history and the backlog records deferred work. Everything else links; nothing freezes a snapshot (test counts, "in flight" text, story lists).
6. **Progress log is history, not a second roadmap.** It answers "what shipped, when, and where is the context?" — not "what's next?".

### Reduce drift

7. **Stale-doc discipline.** Any prose that mentions specific story/epic status, test counts, or "in flight" language will go stale. Either avoid it or point to the canonical-status surface.
8. **Prefer links over duplication.** If a section starts becoming a mini-version of another doc, replace it with a short summary + link.
9. **Reduce repeated command blocks.** Setup shows minimum bootstrap; operations is the canonical command reference; other docs link there.
10. **Trim generic teaching.** Onboarding docs cover project-specific patterns, not general language/framework basics.

### Manage lifecycle

11. **Archive or prune completed plans.** Keep durable design rationale, architecture decisions, schema discoveries, risks. Archive or drop completed task checklists once facts are in canonical docs.
12. **Avoid permanent migration scaffolding.** Working artifacts created during a refactor (migration maps, content-allocation tables) move to `docs/plans/` or get deleted once the refactor lands. They are means, not deliverables.
13. **Operator runbooks stay detailed.** Keep them concrete with real IDs, commands, and known-good fixtures. Don't slim them by conceptual-doc criteria.

### Frontmatter and boilerplate

14. **Frontmatter is optional.** Add `Last updated` + `Authoritative sources` only on canonical reference docs where staleness has real cost (standards, architecture, risks). Boilerplate frontmatter on every doc creates maintenance burden.
15. **"What This Document Is Not" sections are migration-time scaffolding.** Replace with a one-line "See also" or remove. The title and intro should already define the doc's role.

---

## 5. Procedure

Execute in waves. Each wave has a clear gate.

### Wave 0 — Foundation (precedence + alignment)

1. **Fix the worst stale claims** on the current-status surface, the entry point, root `README.md`, and `CONTRIBUTING.md`, so downstream writers don't cite lies.
2. **Fix broken references** found in §2.
3. **Write the Sources-of-Truth & Precedence section** in the standards doc (or as its own section if the standards doc doesn't exist yet). This is the contract for all subsequent waves.
4. **Produce a content-allocation map** — a working artifact mapping each major section of the current entry point (and any catch-all doc) to its target doc per §3. This is the contract for Wave 1.

### Wave 1 — Topic docs (parallel-safe)

Write each topic doc per the §3 target shape, citing the Wave 0 map. Each doc:
- Has a clear single role and starts with a one-line purpose statement.
- Cites canonical-code references (not paragraph rationale) where rules originated.
- Cross-links rather than duplicates.

### Wave 2 — Synthesis docs (depend on Wave 1)

`docs/AGENTS.md` (routing table + guardrails) and any other doc that indexes the topic docs. Write only after the files they index exist.

### Wave 3 — Standards refresh

Restructure `docs/development-standards.md` to a strict SOP shape. Compress paragraph-prose rules into one-line-rule tables with canonical-code pointers.

### Wave 4 — Index

Build `docs/README.md`: ToC with a "read this when X" line per doc, plus the "Agents start here" pointer.

### Wave 5 — Entry-point trim

Trim the entry point to its lean §3 shape. **This depends on every other doc existing** — without their canonical homes, you'd lose content.

**Mandatory acceptance criteria:**
- **Migration matrix.** Map every section of the pre-trim entry point to "kept" or "moved to docs/<file>.md#<anchor>". Reviewers verify the matrix before approving the trim.
- **Load-bearing-term diff check.** Maintain an explicit, project-specific list of critical terms (env vars, function names, magic constants, error class names, port numbers). Each term must appear at least once in `docs/*.md` after the trim, not in the entry point alone.

### Wave 6 — Final validation

1. **Stale-phrase sweep.** `grep` for known-stale phrases identified in §2. Each must be zero hits in the in-scope docs.
2. **Link verification.** Every internal markdown link resolves.
3. **Load-bearing-term check.** Each listed term appears at least once in `docs/*.md`.
4. **Template-diff recheck.** The §2.7 template diff is now empty, or every remaining divergence is justified in the findings note.
5. **Fresh-reader scenarios.** Pick 3–5 questions an agent might ask ("how do I run X locally?", "where do I add a Y?") — verify each resolves in ≤3 doc hops starting from the entry point.

---

## 6. Anti-Patterns

Surface these in pre-refactor findings; remove them in execution.

- **The catch-all.** One file carrying mission + architecture + gotchas + conventions + status + roadmap + secrets policy + workflow.
- **The parallel structure.** Refactoring into a new doc scheme (different file names or roles than the template) — the next agent faces two conventions. Includes recreating files the template retired (`ai-agents-guide.md`, `dependencies.md`).
- **The mirror diagram.** The same architecture diagram in `README.md`, the entry point, an architecture doc, and a walkthrough. Pick one canonical home.
- **The duplicated command block.** The same install/test commands in 5+ places. Canonical home is operations.md; link elsewhere.
- **Frozen status snapshots.** Static test counts, "in flight" text, `Stories X.0–X.4 shipped; X.5 in flight`. These rot within weeks.
- **Wishful tense.** Describing planned-but-unbuilt code as if it exists. Mark planned things "Planned (Epic N)" explicitly.
- **Stale references.** Markdown links to files that don't exist. Grep before merge.
- **Permanent scaffolding.** Migration maps, content-allocation tables, "interim notes" — move to plans/ or delete after the refactor lands.
- **The multi-home trap.** The same gotcha or trap explained in full in several docs. Full explanation once, in its canonical home (e.g., a testing trap in testing.md); one-line pointer everywhere else.
- **The TOC for a 100-line doc.** A table of contents helps at 500+ lines. Don't auto-add.
- **Generic frontmatter on every doc.** Frontmatter on canonical reference docs only.

---

## 7. Risk Tiering

Tier proposed changes by risk so the user can accept/defer item-by-item:

| Tier | Risk | Examples |
|---|---|---|
| 1 — pure cleanup | Essentially zero | Remove duplicate command blocks; drop frozen test counts; compress boilerplate frontmatter; move migration scaffolding to plans/ |
| 2 — de-duplication | Low if validation re-runs | One canonical home per gotcha; replace duplicates with one-line + link |
| 3 — overlap collapse | Low; judgment calls | Decide which doc owns each cross-cutting topic; collapse tables that appear in 2+ docs; merge retired files into their template homes |
| 4 — deep rewrites | Audience-dependent | Compressing narrative onboarding; table-collapsing historical progress; restructuring user-facing docs by AI-agent criteria |

**Recommend Tier 1–3 as the default refactor scope.** Tier 4 needs explicit user approval per item — those docs often serve audiences (stakeholders, new contributors) that aren't AI agents.

---

## 8. Definition of Done

A refactor is complete when:

- The final tree matches the §3 target (template-aligned); every divergence is justified in the findings note.
- The entry point is lean (target: under 250 lines for most projects) with no status/roadmap content.
- Every `docs/*.md` has a single defined role.
- Every gotcha, rule, command, decision has one canonical full-explanation home; pointers elsewhere.
- Sources-of-truth precedence is declared in the standards doc.
- All known-stale phrases are zero hits; all markdown links resolve.
- The load-bearing-term check confirms no critical fact was lost during the trim.
- A 3–5 question fresh-reader scenario pass succeeds in ≤3 doc hops per question.
- The pre-refactor findings list is addressed item by item, or each unaddressed item is explicitly deferred to backlog with rationale.

---

## 9. Output Deliverables

1. **Updated doc tree** matching the §3 target shape (adjusted to the project's actual needs, divergences justified).
2. **Pre-refactor findings note** preserved as a record (in `docs/plans/` if you want history, or deleted if not).
3. **Change summary** comparing final state directly to original state — the structural shift, docs added/merged/retired, stale-claim fixes. No "built then compressed then cleaned" intermediate-state churn.
4. **Backlog list** of deferred items with rationale for deferral.

---

## 10. Lessons That Almost Cost You

Specific traps this prompt is designed to prevent:

- **Inventing framings the code doesn't support.** ("5-layer architecture" when every existing source says four-layer.) Verify against actual code.
- **Recreating retired files.** Check the template diff before adding any doc — `ai-agents-guide.md` and `dependencies.md` were deliberately folded into `AGENTS.md` and `stack.md`.
- **Trimming the entry point before the topic docs exist.** Loses content. Sequence matters.
- **Assuming workers have access to your SOP.** Embed required section headings inline in each task description if the SOP isn't committed in-repo.
- **Forgetting frontmatter discipline.** `Last updated:` on every doc creates maintenance burden you'll never pay.
- **Removing the migration map immediately.** Keep it until Wave 6 validation passes; then move it to plans/ or delete it.
- **Trimming user-facing docs by AI-agent criteria.** Walkthroughs and stakeholder docs may have non-agent audiences. Confirm the audience before aggressive trimming.
- **Treating the refactor as a one-time pass.** Drift starts immediately. The standards doc must carry a stale-doc-prevention rule that lives forever (e.g., "docs never freeze status; they link to the canonical surface").

---

### End of Prompt