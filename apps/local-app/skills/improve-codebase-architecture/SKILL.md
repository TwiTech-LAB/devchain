---
name: improve-codebase-architecture
displayName: Improve Codebase Architecture
description: "Plan architecture improvements and refactoring for a codebase: scan for deepening opportunities (shallow modules, leaky seams, low-leverage interfaces), present candidates as a markdown report with before/after diagrams, interview the user through the chosen design, and decompose the outcome into devchain epics. Use when asked to review or improve code architecture, plan a project refactoring, refactor for testability or maintainability, hunt design debt or technical debt, or prepare an architecture-improvement plan."
license: "MIT — adapted from mattpocock/skills (https://github.com/mattpocock/skills)"
compatibility: "Any devchain-managed project; intended for architect/planner agent roles"
resources:
  - VOCABULARY.md
  - REPORT-FORMAT.md
  - DESIGN-IT-TWICE.md
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability. The output is not code: it is a validated design plus a devchain epic breakdown a worker agent can execute.

## Step 0 — Load supporting files (mandatory, do this first)

This skill is multi-file. Call `devchain_get_skill` with slug `devchain/improve-codebase-architecture` and note the returned `contentPath`. Then, with your file-read tool:

1. Read `<contentPath>/VOCABULARY.md` **now** — every term you use in this workflow comes from it.
2. Read `<contentPath>/REPORT-FORMAT.md` before writing the Phase 2 report.
3. Read `<contentPath>/DESIGN-IT-TWICE.md` **only** if the optional exploration in Phase 3 is invoked.

Do not proceed to Phase 1 until VOCABULARY.md is read. Use its terms exactly — **module, interface, implementation, depth, seam, adapter, leverage, locality** — and never substitute "component," "service," "API," or "boundary."

## When to Use

- The user asks to review, assess, or improve the architecture of a project.
- Planning a refactor whose goal is testability, maintainability, or easier navigation.
- A codebase feels hard to change and the user wants to know where the friction lives.
- Preparing an architecture-improvement phase that must end as devchain epics.

## When NOT to Use

- Bug hunting or correctness review — use a code-review skill instead.
- Security auditing — use a security-review skill instead.
- Small, pre-scoped refactors where the design is already decided — go straight to epic decomposition.
- Greenfield design with no existing code — there is nothing to deepen yet.

## Essential Principles

1. **Vocabulary discipline.** All architectural claims use VOCABULARY.md terms exactly. Consistent language is what makes candidates comparable and the report legible. Project-native names stay as-is when citing concrete artifacts (a NestJS service class, a docs section that says "boundary") — the vocabulary governs your claims and never overrides the target project's documented standards (see the Scope section of VOCABULARY.md).
2. **Diagnose before prescribing.** Phases 0–2 name problems and sketch solutions in one sentence each; interfaces are designed only in Phase 3, after the user picks a candidate.
3. **Evidence over vibes.** Every candidate cites concrete files. Apply the deletion test before calling a module shallow.
4. **Decisions get recorded.** Accepted designs become epics; load-bearing rejections are offered as ADRs so future reviews don't re-suggest them.
5. **This skill never writes application code.** The end state is a report, recorded decisions, and epics for worker agents.

## Workflow (linear — run the phases in order)

### Phase 0 — Context intake

**Entry:** user has named a target project/codebase.

1. Read the project's documentation entry point if one exists (`docs/AGENTS.md`, `docs/README.md`, or the repo root README) and its architecture docs.
2. Read the domain glossary if one exists (`CONTEXT.md`, a glossary section, or equivalent). Use its terms for domain concepts throughout.
3. Read `docs/adr/` (or equivalent decision records). List the decisions you must not re-litigate.
4. Note any documented architectural guardrails (module-boundary rules, dependency policies, cycle allowlists).

**Exit:** you can name the project's documented conventions, glossary terms (or their absence), and standing decisions.

### Phase 1 — Explore for deepening opportunities

**Entry:** Phase 0 complete; VOCABULARY.md read.

If your environment provides read-only exploration subagents (an Agent/Explore tool), fan the sweep out; otherwise explore sequentially yourself. Don't follow rigid heuristics — walk the code organically and note where you experience friction:

1. Where does understanding one concept require bouncing between many small modules?
2. Where are modules **shallow** — interface nearly as complex as the implementation?
3. Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
4. Where do tightly-coupled modules leak across their seams?
5. Which parts are untested, or hard to test through their current interface?

Apply the **deletion test** (VOCABULARY.md) to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? "Concentrates" is the signal you want. Classify each candidate's dependencies using the dependency categories in VOCABULARY.md — the category determines the testing story you'll claim.

**Exit:** a list of 3–7 candidates, each with concrete file references, a suspected diagnosis in vocabulary terms, and a dependency category.

### Phase 2 — Candidate report

**Entry:** Phase 1 candidate list exists; REPORT-FORMAT.md read.

1. Write the report in markdown exactly per REPORT-FORMAT.md: one card per candidate (files, problem, solution, wins, before/after diagram, recommendation strength, ADR-conflict callout where applicable) and a closing **Top recommendation** section.
2. **ADR conflicts:** if a candidate contradicts a standing decision, surface it only when the friction is real enough to warrant revisiting; mark the card clearly. Don't list every theoretical refactor an ADR forbids.
3. Deliver the report as a chat message. If the user wants it persisted, write it to `docs/architecture-reviews/<YYYY-MM-DD>.md` in the target project.
4. Do **NOT** propose interfaces yet. End by asking: "Which of these would you like to explore?"

**Exit:** report delivered; user has picked a candidate (or ended the session).

### Phase 3 — Design interview (per chosen candidate)

**Entry:** user picked a candidate.

Interview the user relentlessly about the design until you reach shared understanding. Walk down each branch of the design tree — constraints, dependencies, the shape of the deepened module, what sits behind the seam, which tests survive — resolving dependencies between decisions one by one.

1. Ask **one question at a time**; wait for the answer before the next. Multiple questions at once is bewildering.
2. For every question, state your recommended answer and why.
3. If a question can be answered by exploring the codebase, explore instead of asking.
4. *Optional:* if the user wants to compare radically different interfaces for the deepened module, run the process in DESIGN-IT-TWICE.md. It is an advanced side-path — the core workflow never depends on it.

**Exit:** the deepened module's interface, seam placement, adapter set, and test surface are agreed with the user.

### Phase 4 — Record decisions

**Entry:** the design interview produced agreements or load-bearing rejections.

1. If the project keeps a domain glossary, add or sharpen terms that crystallized during the interview — the moment they crystallize, not batched.
2. If the user rejects a candidate for a load-bearing reason, offer an ADR **only** when all three hold: hard to reverse, surprising without context, the result of a real trade-off. Frame it as: "Want me to record this as an ADR so future architecture reviews don't re-suggest it?" Skip ephemeral reasons.

**Exit:** glossary/ADR updates written or explicitly declined.

### Phase 5 — Decompose into epics

**Entry:** an accepted design from Phases 3–4.

1. Decompose the accepted design into devchain epics following your architect profile's decomposition SOP if you have one; otherwise create a parent epic for the improvement with sub-epics per independently testable step (verb-first titles, file references, acceptance criteria stated as observable behavior through the deepened module's interface).
2. Testing tasks follow the **replace, don't layer** rule from VOCABULARY.md: new tests at the deepened interface; deleting obsolete shallow-module tests is part of the work, not an afterthought.
3. Attach relevant skills to sub-epics via `skillsRequired`, including this skill's slug `devchain/improve-codebase-architecture` where the worker benefits from the vocabulary.
4. Out-of-scope discoveries go to a backlog epic, not into the sub-epics.

**Exit:** epics exist and reference the recorded decisions; nothing is left only in chat.

## Success Criteria

- [ ] VOCABULARY.md terms used exactly; no substitute terminology anywhere in the report or epics.
- [ ] Every candidate has concrete file references, a dependency category, and passed (or explicitly failed) the deletion test.
- [ ] Report follows REPORT-FORMAT.md, ends with a top recommendation, and proposes no interfaces.
- [ ] The design interview asked one question at a time, each with a recommended answer.
- [ ] Load-bearing rejections were offered as ADRs; accepted designs are traceable to epics.
- [ ] No application code was written by this workflow.

## Attribution

Adapted for DevChain from the MIT-licensed skill family by Matt Pocock — `improve-codebase-architecture`, `codebase-design`, `grilling`, and `domain-modeling` at [github.com/mattpocock/skills](https://github.com/mattpocock/skills). Key adaptations: markdown report instead of HTML, devchain epics as the execution sink, and provider-agnostic subagent guidance.
