# Project Skill Review

A DevChain first-party skill. An agent loads it to review the skills stored for a project: it proposes skill enables and disables, source bundles and source disables, and a catalog sync. It writes only after the user approves. A shorter, more relevant skill list helps agents pick the right skill.

## What the skill does

The skill runs these steps in a fixed order:

1. **Offer a sync** with `devchain_skills_sync` — named sources preferred, run only after approval. A timeout, `already_running`, `failed > 0`, or errors mean "catalog not confirmed fresh"; the skill says so and works with the last stored catalog.
2. **Read the usage statistics** with `devchain_skills_usage_stats` — before any `devchain_get_skill` call, because each call creates a usage event.
3. **Read the project specifications**: the docs entry point, the root `README`, the package manifests. Derive the areas of usage. Judge the statistics: sufficient only when the span `lastEventAt − firstEventAt` is ≥30 days and `totalEvents` is ≥100.
4. **List all stored skills** with `devchain_list_skills` and `includeDisabled: true`. Each item carries four independent flags: `disabled` (effective), `skillDisabled`, `sourceProjectEnabled`, `sourceGloballyEnabled`.
5. **Find the protected skills**: slugs that an open epic references (`epicReferences`), and slugs or bare names that a project prompt contains.
6. **Classify each enabled skill**: Protected, Keep (used or relevant), Disable (no use, no relevance, not protected), or Unsure (kept).
7. **Classify each disabled skill of a globally enabled source**: Enable (required) when an open epic or prompt references it; Enable when it clearly matches an area and no enabled skill shares its name segment; Unsure (stay disabled) on past-usage-alone or a name collision; otherwise Stay disabled. Past usage alone never justifies an enable.
8. **Build source bundles**: for a project-disabled source with at least one Enable-class skill — enable the source plus companion disables for its other non-matching skills. One approval covers the whole bundle; the companion disables run first, and a nonempty `notFound` on them stops the source enable.
9. **Propose source disables** from the final approved state: disable a source when every enabled skill of it is Disable-class.
10. **Handle globally disabled sources** as read-only: recommendations only ("enable source X in Settings, then sync X"); never a write.
11. **Report** in eight groups — Enable, Disable, Source bundles, Source disables, Unsure, Keep, Protected, Globally disabled — one reason per item; the user approves each group separately.
12. **Apply after approval** in the order: source bundles → skill enables → skill disables → source disables. Undo calls use only the changed slugs (the request minus `unchanged` and `notFound`) and the sources that changed.

After a local skill edit, the skill edits the authoritative local source folder (never the materialized `contentPath`) and proposes a sync of that source.

## Safety rules

- The skill never writes without explicit user approval.
- The skill never disables a protected skill.
- The skill never writes to a globally disabled source.
- Undo calls use only the changed slugs and the actually changed sources, so a rollback restores exactly what the review changed.

## Usage

Available as `devchain/project-skill-review` after the built-in `devchain` source syncs.
Trigger it with:

```
Review the skills for this project and propose enables, disables, and bundles
Shorten the skill list for this project
Enable the skills this repo actually needs and disable the rest
Sync the skill sources and review the catalog
```

To test unpublished changes locally, use a local source such as `devchain-dev`; see the
[skills README](../README.md).
