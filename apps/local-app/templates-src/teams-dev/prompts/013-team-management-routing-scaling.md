# Team Management — Routing & Scaling (v1.15)

> **Type:** agent-reference
> **Priority:** mandatory

---

## Purpose
Route each sub-epic to the cheapest qualified worker. Optimize tokens; speed is secondary. Task tiers come from the planner — you manage the fleet, you do not re-classify the work.

## 1. Tier source (authoritative)
Every sub-epic carries `Recommended worker tier: junior | mid | senior`, set by the planner. This is the assignment floor.
- You may **raise** the tier only on evidence: a previous worker blocked or escalated on it, or execution revealed cross-module / security-sensitive scope the plan missed.
- **Never assign below the floor** — "I'll escalate if rework occurs" is not a valid reason; rework costs more than the tokens saved.
- Annotation missing (rare)? Classify by judgment surface, using the planner's own definitions:
  - **junior** — precise spec, one obvious approach, single module, failures caught loudly by existing tests.
  - **mid** — clear outcome, but requires picking patterns within a module or wiring a couple of touchpoints.
  - **senior** — cross-layer reasoning, multiple valid approaches with trade-offs, or non-obvious failure modes (perf, security, races).

## 2. Tier → config mapping
`devchain_teams_configs_list` → filter by `teamName`. Each config's description declares its tier ("Senior …" or "Junior/Mid …"). Junior/Mid configs serve both junior and mid tasks.
- junior or mid task → a Junior/Mid-tier config. senior task → a Senior-tier config.
- Several configs at the same tier → prefer the one existing same-profile members already use.
- A config whose description declares no tier is not routable — skip it, do not guess.
- Do not copy another member's `providerConfigName` reflexively; match the task's tier.

## 3. Routing procedure

**3.1 Plan upfront (mandatory, before any assignment).** Fetch each ready sub-epic individually with `devchain_get_epic_by_id` (full description). Record its tier. Group independent sub-epics — non-overlapping file/module scope and no dependency note — as parallelizable. Note tier transitions; provision each tier when its first task becomes eligible (§3.3), not at plan time. This plan governs all routing below; do not drift.

**3.2 Get team projection.** `devchain_team(sessionId, teamName?)` → `members[]` (each with `profileName`, `providerConfigName`, `isTeamLead`), `maxMembers`, `maxConcurrentTasks`, `currentMemberCount`, `busyMembersCount`, `freeSeats`, `freeConcurrentSlots`, `allowTeamLeadCreateAgents`. Member/busy/free counts exclude the lead. Do not filter by online status — agents that appear offline come online when assigned.

**3.3 Assign each task, in this order (never below the floor):**
1. **Reuse a free tier-matched worker** — right profile, config at the task's tier.
2. **Continuity exception (pre-empts creation only — never outranks step 1):** the higher-tier worker authored a prior revision of this same sub-epic, or the task is an explicitly marked continuation touching the same files → reuse it. Same phase or related feature never qualifies; related-work context transfers via the §3.6 pointer.
3. **Create a tier-matched worker just in time** when ALL hold: `allowTeamLeadCreateAgents === true`, `freeSeats > 0`, and the tier bundle meets the creation threshold — at least one substantial task (multi-file, or roughly an hour or more of agent work) or two routine tasks at that tier, **counted over the whole §3.1 plan, not the currently-ready batch**. Create the worker when its first task becomes eligible. Bundle consecutive same-tier tasks onto the new worker where practical. **Bootstrap exception:** if no qualified worker exists at all for this task, create one regardless of threshold.
4. **Reuse a free overqualified worker** — planned tier workload (§3.1) below the creation threshold, or no seats free.
5. **Replace a worker** only when seats are exhausted AND remaining planned work clearly favors the replacement tier over the existing worker's accumulated context.

**3.4 Creation flow.** Pick `configName` per §2 → `devchain_team` → name `<profileName> (N)` with lowest free N, project-wide, case-insensitive → `devchain_teams_create_agent(name, teamName, configName, profileName)`. Omit `description` to inherit from config. Creation sends no notification; a `devchain_update_epic` assignment change auto-notifies.

**3.5 Dispatch in parallel.** Fan the parallelizable groups from §3.1 out to distinct qualified workers in one pass — one worker per sub-epic, prefer tier-matched, dispatch while `freeConcurrentSlots > 0`. Do not queue work behind one worker while others sit free at the right tier. Using an idle overqualified worker to parallelize is acceptable to avoid creating a new one — never required. Parallelism alone never justifies creation; every creation must pass §3.3.

**3.6 Context pointer.** When a task directly builds on another worker's completed sub-epic, add a `Builds on: {sub_epic_id}` comment on the task before assigning — a pointer, not a summary; the prior sub-epic's comments and the working-tree diff already hold the context. Summaries are reserved for §4 escalation.

## 4. Escalation
When a worker blocks or produces rework: raise the task's tier (at least one level; senior if the failure is architectural or security-related), then route it per §3. Include the prior attempt in the assignment — what was tried, where it failed — so the new worker does not rediscover it.

## Guardrails
- Never delete a higher-tier worker merely to route one cheaper task. If seats allow and the threshold is met, provision the lower tier alongside it.
- Do not delete idle workers for tidiness; delete only to free a seat under §3.3 step 5.
- Junior on hard work → rework and escalation churn; senior on trivial work → wasted tokens. Both are routing failures.
- Relatedness is not a routing criterion — tier is: a related mid task goes to a mid worker with a §3.6 pointer, not to the senior from the neighboring task.

---

### End of Reference