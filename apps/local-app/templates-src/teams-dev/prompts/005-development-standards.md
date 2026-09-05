# Prompt: Create Project Development Standards Documentation (v2)

You are an AI engineer creating a compact, project-specific development standards guide for future developers and AI agents. Work from the repository root and produce or update `docs/development-standards.md`.

## Mission

- Turn observed repository conventions into actionable development standards.
- Keep the document useful for any project type: application, library, CLI, monorepo, infrastructure, data, game, or mixed repository.
- Prefer existing project evidence over generic best practices.
- Do not invent architecture patterns, compliance obligations, APIs, layers, tools, versions, or workflows.
- Mark missing evidence as `Unknown`; mark irrelevant sections as `Not applicable`.
- Keep the output concise, enforceable, and easy to scan.

## Operating Constraints

- Do not use network access.
- Do not install dependencies or run long project tasks.
- Read only the files needed to infer standards.
- Never read secret values. You may read `.env.example` or `.env.sample` for variable names only.
- Respect existing documentation. Update `docs/development-standards.md`; do not delete other docs.
- If existing files conflict, document the conflict in `Unknowns and Decisions Needed` instead of silently choosing one.

## Evidence to Prefer

- Project guidance: `README*`, `AGENTS.md`, `CONTRIBUTING.md`, `docs/**`, `CODEOWNERS`.
- Build and task files: `Makefile`, `Taskfile.yml`, `Justfile`, `package.json`, `pyproject.toml`, `composer.json`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle*`, `.csproj`, `mix.exs`.
- Tooling config: formatter, linter, type checker, test runner, dependency manager, pre-commit, editorconfig.
- CI/CD config: `.github/workflows/**`, `.gitlab-ci.yml`, CircleCI, Jenkins, deployment manifests.
- App structure: top-level directories, package/service manifests, entry points, config directories, migrations, schemas, generated-code locations.

## Procedure

1. Inventory the repository standards sources listed above.
2. Identify the project type, primary languages, package/service boundaries, and toolchain.
3. Extract actual commands for build, test, lint, format, type-check, migrations, and local run when present.
4. Draft `docs/development-standards.md` using the required structure below.
5. Sanity-check that each standard is supported by evidence or clearly labeled as `Unknown`, `Not applicable`, or `Recommended default`.
6. Make the document discoverable: if `docs/AGENTS.md` exists, add or refresh its routing-table row for `docs/development-standards.md`; if `docs/README.md` exists, add or refresh the table-of-contents link.

## Required Document Structure

### 1. Purpose and Scope

- What this standards guide covers.
- Project type and main technology stack.
- Who should use it: developers, reviewers, AI agents, operators.

### 2. Sources of Truth and Precedence

- Files that define project standards.
- Which source wins when conventions conflict.
- Gaps or conflicts that need a maintainer decision.

### 3. Architecture and Boundaries

- Observed architecture shape: monolith, package, service, plugin system, pipeline, infrastructure repo, or `Unknown`.
- Main modules/services/packages and their responsibilities.
- Dependency direction or layer rules, only if evident.
- Where new features, tests, config, migrations, and generated code should go.

### 4. Coding Conventions

- Formatting, linting, typing, naming, comments, and file organization.
- Framework-specific patterns that are already used.
- Generated-code rules and files that should not be hand-edited.
- Keep code examples out unless a tiny snippet is necessary to disambiguate a rule.

### 5. Build, Test, and Validation Before Review

- Required checks before sending a change for review.
- Use project commands from manifests, task files, or CI whenever available.
- If no command is present, write `Unknown`; do not pretend a command exists.
- If a common ecosystem fallback is obvious, label it as `Recommended default`, not as a project rule.

Use this table format:

| Purpose | Command | Source | When to run |
| --- | --- | --- | --- |
| Build | `Unknown` | `Unknown` | Before review when build tooling is identified |

Helpful fallback examples, only when labeled `Recommended default`:

| Ecosystem | Build | Format/Lint |
| --- | --- | --- |
| pnpm monorepo | `pnpm --filter <pkg> build` | `pnpm --filter <pkg> lint --fix` |
| npm/yarn | `npm run build` | `npm run lint -- --fix` |
| Python with Ruff | `Unknown` | `ruff check --fix .` and `ruff format .` |
| Python legacy | `mypy .` | `black .` and `flake8` |
| Rust | `cargo build` | `cargo fmt` and `cargo clippy` |
| Go | `go build ./...` | `go fmt ./...` and `golangci-lint run` |
| Makefile | `make build` | `make lint` or `make fmt` |

### 6. Testing Standards

- Test frameworks, locations, naming, fixture strategy, and coverage gates.
- Unit/integration/e2e expectations only if the repository shows them.
- Mocking, external service, database, and test data rules if evident.

### 7. Data, API, and Contract Standards

- API formats, DTOs, schemas, migrations, serialization, versioning, and validation rules when applicable.
- Database or storage conventions when applicable.
- Mark `Not applicable` for projects without data contracts or persistence.

### 8. Configuration and Secrets

- Configuration sources and precedence.
- Required environment variables by name only.
- Secret handling, local overrides, and environment-specific config.
- Files or values agents must not read, print, or commit.

### 9. Errors, Logging, and Observability

- Error handling patterns, user-facing vs. internal errors, and error code conventions.
- Logging levels, structured fields, sensitive-data restrictions.
- Metrics, tracing, health checks, and log locations if present.

### 10. Security and Dependency Hygiene

- Authentication and authorization boundaries if present.
- Secure coding rules supported by repository evidence.
- Dependency update, vulnerability scanning, license, and supply-chain practices if present.
- Do not add compliance requirements such as GDPR, HIPAA, or SOC 2 unless the repository explicitly requires them.

### 11. Resilience and Operations

- Retry, timeout, idempotency, queue, cache, migration, deployment, and rollback practices if present.
- Common maintenance tasks and operational checks.
- Mark `Not applicable` for libraries or projects without runtime operations.

### 12. Review Checklist

- Short checklist reviewers and AI agents can apply before opening or approving a change.
- Include validation commands, docs updates, tests, security/secrets checks, and generated-file checks.

### 13. Unknowns and Decisions Needed

- Missing standards that matter for safe development.
- Conflicting conventions.
- Areas where maintainers should make an explicit decision.

## Output Rules

- Write Markdown to `docs/development-standards.md`.
- Include a table of contents with links.
- Use concise bullets and small tables; avoid long prose.
- Prefer repository-relative paths when citing evidence.
- Keep each section to the most important 3-8 bullets.
- Avoid duplicate content already covered by other docs; link to it instead.
- Do not add external links unless they already appear in the repository.
- Use `Unknown`, `Not applicable`, and `Recommended default` exactly as labels when needed.

## Definition of Done

- `docs/development-standards.md` exists and follows the required structure.
- Every project-specific claim is backed by observed files or clearly labeled.
- The validation checklist tells an agent what to run before review.
- The document is generic enough to fit any project type without forcing irrelevant sections.
- The document is strict enough to guide real changes.
- `docs/AGENTS.md` and `docs/README.md` link to the document when those files exist.