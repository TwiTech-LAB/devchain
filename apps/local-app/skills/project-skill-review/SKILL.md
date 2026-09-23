---
name: project-skill-review
displayName: Project Skill Review
description: "Review the skills stored for a project. Read the project specifications and the skill usage statistics. Classify each enabled skill as Keep, Disable, Protected, or Unsure. Classify each disabled skill as Enable or Stay disabled. Propose source bundles, source disables, and a skill sync. Apply a change only after the user approves it. Use when the skill list is too long, when agents pick wrong skills, or when the user asks to enable, disable, prune, or sync skills. Triggers: review project skills, enable disabled skills, disable unused skills, shorten the skill list, sync skills, skill cleanup, project skill review."
version: 0.2.1
license: "MIT"
---

# Project Skill Review

Review all skills stored for this project. Propose enables, disables, source bundles, and source disables. The goal is a short, relevant skill list, so agents pick the right skill faster.

Never write without explicit user approval. Never disable a protected skill. Never write to a globally disabled source.

## Step 0 — Offer a sync

1. Propose `devchain_skills_sync` for the sources that matter to this review. Prefer a named source. Use a full sync only when no name fits.
2. Run the sync only after the user approves it. Continue when the user declines.
3. Treat the outcome as "catalog not confirmed fresh" when a timeout happens, when `status` is `already_running`, when `failed` is above 0, or when `errors` is not empty. Say so in the report.
4. Call the skill list "the last stored catalog".

## Step 1 — Read the statistics first

Call `devchain_skills_usage_stats` before any `devchain_get_skill` call. Each `devchain_get_skill` call creates a usage event. A call during the review changes the data that this review reads.

## Step 2 — Read the project specifications

1. Read the docs entry point. Use `docs/AGENTS.md`. Use `docs/README.md` when `docs/AGENTS.md` is absent.
2. Read the root `README`.
3. Read the package manifests.

Find the main languages and the main frameworks. Write a list of the areas of usage. Example: "backend: NestJS and SQLite", "UI: React and Vite".

## Step 3 — Judge the statistics

1. The span is `lastEventAt − firstEventAt`. Do not use the window that the request sent.
2. The statistics are sufficient only when both conditions hold: the span is 30 days or more, and `totalEvents` is 100 or more.
3. When the statistics are not sufficient, say so in the report. Decide from the specifications only.
4. State in the report: usage means successful `devchain_get_skill` loads. It does not prove that a skill helped.

## Step 4 — List all stored skills

Call `devchain_list_skills` with `includeDisabled: true`. The response is the last stored catalog. Each item carries four flags:

- `disabled`: the effective state. It is true when any of the other three blocks applies.
- `skillDisabled`: the project disabled this skill.
- `sourceProjectEnabled`: the project enables the source. The default is true.
- `sourceGloballyEnabled`: the settings enable the source. The default is true.

A skill is enabled when `disabled` is false. A skill is disabled when `disabled` is true.

## Step 5 — Find the protected skills

### From `epicReferences`

1. Choose the status labels that mean closed. Examples: `Done`, `Archive`.
2. Name these labels in the report.
3. A slug is protected when an epic that is not closed references it.
4. Treat an ambiguous label as open.

### From the prompts

1. Call `devchain_list_prompts`.
2. Call `devchain_get_prompt` for each prompt.
3. A prompt protects a skill when it contains the slug of that skill or the bare name of that skill.

### On failure

When a list call or a fetch call fails, say in the report that the protection is incomplete. Keep every skill that you could not check.

## Step 6 — Classify each enabled skill

The usage identity is the exact full slug. Review each skill with `disabled: false`. Do not skip a skill. Put each skill in exactly one class:

1. **Protected:** an open epic or a prompt requires the skill. Keep it.
2. **Keep:** the skill has usage in the statistics. Or the skill matches an area of usage.
3. **Disable:** all three conditions hold: the skill has no usage and the usage list is complete, so no usage means zero use; the skill matches no area of usage; the skill is not protected.
4. **Unsure (keep):** all other cases. Example: a skill has no usage, but a skill with the same name in another source has usage.

Skip skills with `sourceGloballyEnabled: false` here. Step 10 covers them.

## Step 7 — Classify each disabled skill

Review each skill with `disabled: true` and `sourceGloballyEnabled: true`. This covers skills the project disabled and skills of sources the project disabled. Apply the classes in this order:

1. **Enable (required):** an open epic or a prompt references the skill.
2. **Enable:** the skill clearly matches an area of usage, and no enabled skill has the same slug name segment.
3. **Unsure (stay disabled):** the skill has past usage without an area match. Or an enabled skill with the same name segment exists.
4. **Stay disabled:** all other cases.

Never propose Enable because of past usage alone.

## Step 8 — Build source bundles

A source bundle turns one project-disabled source on, without its noise. Build one bundle for each source with `sourceProjectEnabled: false` and `sourceGloballyEnabled: true`:

1. Propose "enable source X for this project" only when X holds at least one Enable-class skill.
2. Add a companion disable for every other skill of X that is not Enable-class and has `skillDisabled: false`.
3. The user approves or declines the whole bundle. When the user declines, X stays disabled.
4. Apply in this order: first the companion disables (`devchain_skills_set_enabled` with `enabled: false`), then the source enable (`devchain_skills_set_source_enabled` with `enabled: true`).
5. When the disable call returns a nonempty `notFound` or fails, do not enable the source. Report the bundle as not applied.

## Step 9 — Propose source disables

1. Compute these proposals from the final approved state. Count the approved bundles and skill enables first.
2. Propose "disable source X for this project" when every enabled skill of X is Disable-class.

## Step 10 — Handle globally disabled sources

1. A skill with `sourceGloballyEnabled: false` is read-only for MCP. Its stored content can be stale, because disabled sources do not sync.
2. Never write to these skills and never write to their source.
3. The report may recommend: "enable source X in Settings, then sync X".
4. When the user enables such a source in Settings, propose `devchain_skills_sync` for that source.

## Step 11 — Report and ask

Show the report in eight groups: Enable, Disable, Source bundles, Source disables, Unsure, Keep, Protected, Globally disabled. The Globally disabled group holds recommendations only. Give one short reason per skill. Show the statistics window, the sufficiency result, the closed labels, and the sync result.

The user approves each group separately. The user can remove items from a group.

## Step 12 — Apply only after approval

1. Apply in this order: source bundles, skill enables, skill disables, source disables.
2. Report `updatedCount` and the counts of `unchanged` and `notFound` for each write. A nonempty `notFound` means an incomplete application. Say so.
3. The changed slugs of a write are the requested slugs minus `unchanged` and `notFound`. Build each undo call from the changed slugs only. Use only the sources that changed. A bundle undo disables the source again, then re-enables its changed companion skills.
4. Give the undo calls in the report.

## Local skill edits

After an edit of a local skill, edit the authoritative local source folder, not the materialized `contentPath` copy. Then propose `devchain_skills_sync` for that source.

## Rules

- Never write without explicit user approval.
- Never disable a protected skill.
- Never write to a globally disabled source.
