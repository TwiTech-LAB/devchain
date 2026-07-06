# Design It Twice (optional, advanced)

An opt-in side-path for Phase 3 of the workflow: when the user wants to explore radically different interfaces for a chosen deepening candidate. Based on "Design It Twice" (Ousterhout) — your first idea is unlikely to be the best. The core workflow never depends on this file.

Uses the vocabulary in VOCABULARY.md — **module, interface, seam, adapter, leverage** — plus its dependency categories.

## Process

### 1. Frame the problem space

Before generating designs, write a user-facing explanation of the problem space for the chosen candidate:

- The constraints any new interface would need to satisfy.
- The dependencies it would rely on, and which category they fall into (VOCABULARY.md dependency categories).
- A rough illustrative code sketch to ground the constraints — not a proposal, just a way to make the constraints concrete.

Show this to the user, then proceed immediately to Step 2 — the user reads and thinks while the designs are produced.

### 2. Produce 3+ radically different designs

**Parallel path (preferred when your environment provides subagents):** spawn 3+ subagents concurrently, each with a separate technical brief (file paths, coupling details, dependency category, what sits behind the seam) and a *different* design constraint:

- Design 1: "Minimize the interface — aim for 1–3 entry points max. Maximise leverage per entry point."
- Design 2: "Maximise flexibility — support many use cases and extension."
- Design 3: "Optimise for the most common caller — make the default case trivial."
- Design 4 (if applicable): "Design around ports & adapters for cross-seam dependencies."

Include both the VOCABULARY.md terms and the project's domain glossary in each brief so every design names things consistently.

**Sequential fallback (mandatory when subagents are unavailable):** produce the same 3+ designs yourself, one at a time, deliberately switching constraint between designs. Do not let an earlier design anchor a later one — restate only the brief, not the prior design, before starting each.

Each design outputs:

1. Interface (types, methods, params — plus invariants, ordering, error modes).
2. Usage example showing how callers use it.
3. What the implementation hides behind the seam.
4. Dependency strategy and adapters (per the VOCABULARY.md categories).
5. Trade-offs — where leverage is high, where it's thin.

### 3. Present and compare

Present designs sequentially so the user can absorb each one, then compare them in prose. Contrast by **depth** (leverage at the interface), **locality** (where change concentrates), and **seam placement**.

After comparing, give your own recommendation: which design is strongest and why. If elements from different designs would combine well, propose a hybrid. Be opinionated — the user wants a strong read, not a menu.

Return to the Phase 3 design interview with the chosen (or hybrid) design.

---

*Adapted from the MIT-licensed `codebase-design` DESIGN-IT-TWICE.md by Matt Pocock — [github.com/mattpocock/skills](https://github.com/mattpocock/skills) — with a mandatory sequential fallback for provider-agnostic use in devchain.*
