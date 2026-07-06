# Bundled DevChain Skills

Git-tracked home for first-party skills shipped with the DevChain repo. Each subdirectory here is one skill; this file and other non-directory entries are ignored by the scanner.

## Layout contract

The local skill source adapter scans `<folderPath>/skills/<skill-name>/SKILL.md` — see `SKILLS_DIRECTORY` and `listSkillNamesFromLocalFolder()` in `apps/local-app/src/modules/skills/adapters/local-skill-source.adapter.ts`. To make **this** folder the scanned root, register the local source with `folderPath` set to the absolute path of `apps/local-app` (not of this `skills/` folder).

- **Slug = `<source-name>/<directory-name>`** (`buildSkillSlug` in `apps/local-app/src/modules/skills/services/skill-sync.service.ts`). Frontmatter `name` feeds display only — keep it equal to the directory name for consistency.
- **Multi-file skills are supported.** Sync copies the whole skill directory recursively; list supporting files in frontmatter `resources:` (exact, case-sensitive filenames) so `devchain_get_skill` reports them, and reference them in the body via the returned `contentPath`.
- **Consumers read the materialized copy** under `~/.devchain/skills/<source>/<skill>/`, not this folder. Repo edits reach agents only after a re-sync.

## How to register this source (per machine — not git-portable)

`folderPath` is stored as an absolute path and validated at registration time (both `folderPath` and `folderPath/skills` must already exist — `validateAndNormalizeFolderPath` in `apps/local-app/src/modules/skills/services/local-sources.service.ts`). Every clone/machine registers its own path:

1. **Register:** Skills page → Sources → add a *local folder* source — name `devchain`, folder path `<absolute-repo-path>/apps/local-app`. (API: `POST /api/skills/local-sources`.)
2. **Enable for your project:** new local sources are seeded **disabled for every project** (`createLocalSource` → `seedSourceProjectDisabled`). Toggle the `devchain` source on for the target project in the Sources popover, or skills won't appear in project-scoped listings.
3. **Sync:** press Sync (or `POST /api/skills/sync`). Verify with `devchain_get_skill` on the skill's slug — it works regardless of the enable toggle (enablement affects discovery/browsing only; `skillsRequired` consumption resolves either way).

## Editing caveat — resync is keyed on SKILL.md only

Change detection hashes only each skill's `SKILL.md` mtime (`getLatestCommit()` in the local adapter). After editing **only** resource files, bump `SKILL.md`'s mtime (`touch SKILL.md` or any edit) and re-sync — the Sync button alone will skip an "unchanged" skill.

## Adding a future skill

1. Create `apps/local-app/skills/<skill-name>/SKILL.md` — YAML frontmatter (`name` = directory name, trigger-focused `description`, `resources:` list) + markdown instructions.
2. Add supporting files beside it; list them in `resources:`.
3. Re-sync (see caveat above). The new slug is `devchain/<skill-name>`.

## Skills

| Skill | Purpose |
|---|---|
| `improve-codebase-architecture` | Architect workflow: find deepening opportunities, report candidates, interview the user through the chosen design, decompose into epics. Adapted from the MIT-licensed [mattpocock/skills](https://github.com/mattpocock/skills) family. |
