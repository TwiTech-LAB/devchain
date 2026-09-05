# Prompt: Initialize Project Documentation (v2)

You are an AI engineer performing a first-pass discovery of an unknown codebase. Determine the stack and architecture, map the code at a high level, and produce concise, high-signal documentation for future AI agents. Be fast and selective; avoid reading unnecessary files.

## Mission

- Identify the project stack, build/deploy tooling, and key runtime components.
- Infer the architecture (monolith vs. multi-service/monorepo, data stores, entry points).
- Produce the fixed set of documentation files under docs/ listed in Deliverables.
- Rely on manifests, metadata, and targeted file sampling — not exhaustive reads.
- Never guess; mark `Unknown` when evidence is insufficient.

## Operating Constraints

- Work from the repository root (current working directory).
- No network access. Do not install or run the project.
- Read only what's needed. Prefer manifests and top-level files.
- Respect existing docs/: update the deliverable files, do not delete others.
- Keep each document short and scannable; prefer bullets and small tables.

## Ignore Rules

Principle: read only source-of-truth text files that inform stack/architecture. Skip bulky, generated, binary, or vendor content unless it is a manifest/config.

- **Hard ignores** (note existence only): VCS/IDE dirs (`.git`, `.hg`, `.idea`, `.vscode`), build/cache outputs (`dist/`, `build/`, `out/`, `target/`, `coverage/`, `.next/`, `.nuxt/`, `.cache/`, `.gradle/`), dependency dirs (`node_modules/`, `vendor/`, `.venv/`, `venv/`, `.m2/`, `.terraform/`), archives (`*.zip`, `*.tar*`, `*.jar`), state files (`terraform.tfstate*`).
- **Heuristic ignores**: binary/media (high non-ASCII ratio in first 4KB; `*.png`, `*.pdf`, `*.woff*`, …); minified/bundled (avg line length >2000 chars, `*.min.*`, large `*.map`); generated code ("generated"/"do not edit" headers, `*.gen.*`, `*.pb.*`, `generated/`); large data/logs (`*.db`, `*.sqlite*`, `*.log`, `*.csv`/`*.ndjson` >256KB); `vendor/`/`third_party/` trees.
- **Secrets**: never read `.env` content; `.env.example`/`.env.sample` for variable names only.
- **Size caps**: skip files >1MB; for unknown file types read only the first 32KB to classify; for unknown directories, list up to 10 filenames and open 1–2 small representative files.
- **Override**: if a manifest/config references a file (e.g., the entry file in package.json), a brief targeted read is allowed even when heuristics say skip.
- Record an "Ignored paths and rationale" note in docs/code-map.md.

## Key Files to Prefer

- Package/language manifests: `package.json`, `pnpm-workspace.yaml`, `pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml`, `composer.json`, `pom.xml`, `build.gradle*`, `*.csproj`, `Gemfile`, `Package.swift`, `mix.exs`.
- Build/exec: `Makefile`, `Taskfile.yml`, `Justfile`, `Procfile`.
- Runtime/deploy: `Dockerfile*`, `docker-compose*.yml`, `helm/`, k8s manifests, `serverless.yml`, `terraform/`.
- App entry/config: `main.*`, `index.*`, `app.*`, `manage.py`, `wsgi.py`/`asgi.py`, `config/`, `.env.example`.
- Docs/meta: `README*`, `AGENTS.md`, `CONTRIBUTING.md`, `LICENSE`, `CODEOWNERS`.

## Procedure

1. **Inventory (metadata-first):** list top-level directories and notable files; triage manifests and runtime/deploy files to infer the stack; in monorepos, identify package/service boundaries from workspace files and per-package manifests.
2. **Targeted reads:** open only the most informative files to confirm inferences (entry points, primary configs, one representative module per major component); capture build/run/test/lint commands from manifests and task files.
3. **Write docs:** create the Deliverables under docs/ (create the folder if missing); concise bullets; cap each section at the most important 5–10 points; mark `Unknown` when not evident.
4. **Sanity pass:** consistent terminology across docs; every claim tied to an observed file; no speculation.

## Deliverables (fixed set; always create/update)

- `docs/README.md` — human index
- `docs/AGENTS.md` — agent entry point and routing table
- `docs/overview.md`
- `docs/stack.md`
- `docs/architecture.md`
- `docs/code-map.md`
- `docs/setup.md`
- `docs/operations.md`
- `docs/testing.md`
- `docs/risks.md`

## Document Templates (required sections)

### docs/README.md

- Title + one-paragraph executive summary.
- "Agents start here: `docs/AGENTS.md`" pointer near the top.
- Table of contents linking every docs/* file.
- Repository quick facts (languages, frameworks, packages/services count, deployment style).

### docs/AGENTS.md

The entry point agents read once at session start; everything else loads on demand.

- Quick runtime context: 5–8 bullets — what the project is, main stack, entry points, notable runtime facts.
- Doc-reading doctrine: read this file once, then load topic docs on demand; never preload everything; code + config win over docs when they conflict.
- Routing table: "You need to… → read …" with one row per deliverable doc (add a row for `docs/development-standards.md` when it exists).
- Conventions and guardrails observed in the repo: format/lint/test commands, safe-change zones, things agents must not do. Once `docs/development-standards.md` exists, link to it here instead of duplicating rules.

### docs/overview.md

- Purpose and scope (what this project is for).
- High-level capabilities and domain.
- Primary entry points (CLI/HTTP/UI/background jobs).
- Project shape (monolith vs. multi-service/monorepo) with 1-line rationale.
- Key directories and their roles (top 5–10).

### docs/stack.md

- Languages and versions (name the source-of-truth file; do not re-list versions inline).
- Frameworks/libraries by layer (app/UI/API).
- Build tools and package managers.
- Datastores and brokers.
- First-party packages/services (monorepo): name, path, role.
- Critical third-party and runtime dependencies (top 10 by importance; DBs, brokers, external APIs); note license if obvious.
- Infrastructure-as-code / deployment tooling; observability (logging/metrics/tracing) if present.

### docs/architecture.md

- System shape (monolith/multi-service) and boundaries.
- Main modules/services and responsibilities (2–5 bullets each).
- Data flow and external integrations.
- Cross-cutting concerns (authN/Z, config, errors, caching).
- Deployment topology (local vs. cloud; containers, functions, k8s) if evident.

### docs/code-map.md

- Directory map (top 10 paths with 1-line purpose).
- Application entry points (by language).
- Important configuration files and what they control.
- Notable scripts/Make targets.
- Generated code or build outputs (where they land).
- Ignored paths and rationale (from the Ignore Rules pass).

### docs/setup.md

- Prerequisites (languages, package managers, runtimes).
- Install steps (commands).
- Environment variables and secrets (names only, placeholders; never values).
- How to run (dev and production, if relevant).
- How to run tests and linters quickly.

### docs/operations.md

- Common tasks (build, run, test, format, lint).
- Maintenance routines (migrations, data seeding, cache clear).
- Troubleshooting tips (top issues + fixes).
- Logs/metrics locations if applicable.

### docs/testing.md

- Test frameworks and locations.
- How to run tests; typical commands.
- Coverage or quality gates if present.
- Test data, fixtures, and e2e notes.

### docs/risks.md

- Known risks and gaps (facts only).
- Security and secrets handling notes.
- Fragile areas / hard-to-change parts.
- Unknowns and open questions.

## Output Rules

- Write the deliverables under docs/ with crisp, bulleted content.
- Use repository-relative file paths when referencing files (e.g., `src/app.ts:42`).
- When evidence is weak, state `Unknown`; do not speculate.
- If a section does not apply, keep the heading with "Not applicable".
- Avoid redundancy across docs — state a fact in one doc and link to it from the others.

## Definition of Done

- All deliverables exist under docs/ and are internally consistent.
- `docs/AGENTS.md` routes to every other doc; `docs/README.md` links to all docs and points agents to AGENTS.md.
- The stack and architecture are identified or explicitly marked `Unknown`.
- The code map and setup instructions let a new agent navigate and run basics.
- No large/binary/vendor/cache files were scanned for content.