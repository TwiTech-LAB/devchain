# Native DevChain Skills

This directory is the Git-tracked home of DevChain's first-party skills. The built-in
`devchain` source synchronizes this exact directory from the
[DevChain repository on the `main` branch](https://github.com/TwiTech-LAB/devchain/tree/main/apps/local-app/skills).
It is registered by `apps/local-app/src/modules/skills/skills.module.ts` through the
reusable `GitHubDirectorySkillSourceAdapter`; it is not a special-case filesystem
scanner or a local source.

Local edits do not change the published source. They become available through the native
`devchain` source only after they are merged into GitHub `main` and a skill sync runs.

## Authoring contract

Each immediate subdirectory is one skill and must contain a `SKILL.md` file:

```text
apps/local-app/skills/
└── <skill-name>/
    ├── SKILL.md
    └── <supporting files and directories>
```

- The published slug is `devchain/<skill-name>`. Slugs use the source name and directory
  name; frontmatter `name` controls skill metadata and should match the directory name.
- `SKILL.md` contains YAML frontmatter followed by the skill instructions. Include a
  trigger-focused `description` and list resource paths in `resources:` using their exact,
  case-sensitive names.
- Synchronization copies the whole skill directory recursively, including files and nested
  directories that are not listed in `resources:`. The resource list tells
  `devchain_get_skill` which supporting files to advertise; it does not limit copying.
- Consumers read the materialized copy under
  `~/.devchain/skills/<source-name>/<skill-name>/`. Repository edits become visible to
  consumers only after synchronization.

## Test unpublished changes locally

Use a separate local source named `devchain-dev` while authoring. The built-in name
`devchain` is reserved and must not be used for a manual local source.

1. Create or edit `apps/local-app/skills/<skill-name>/` in your checkout.
2. In **Skills → Sources → Add Source**, add a local-folder source named `devchain-dev`.
   Set its folder path to the absolute path of `apps/local-app`; the local adapter scans
   its `skills/` child directory.
3. Enable `devchain-dev` for the target project in the Sources popover. New local sources
   are project-disabled initially, so global enablement alone is not enough for discovery.
4. Run a skill sync. The unpublished test slug is
   `devchain-dev/<skill-name>`; use that slug until the change is published on `main`.

Local-source freshness hashes every non-hidden file under each skill directory (path,
modification time, and size), so editing any supporting resource is enough to mark the skill
changed; the next sync refreshes the local test copy.
