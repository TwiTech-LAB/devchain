import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

type AccessCategory =
  | 'feature-store'
  | 'documented-exception'
  | 'settings-owner'
  | 'main-db-reader'
  | 'seeder';

type AccessEntry = { path: string; category: AccessCategory };
type SourceFile = { path: string; source: string };

const SRC_ROOT = resolve(__dirname, '../..');
const ACCESS_SYMBOLS = new Set(['getRawSqliteClient', 'DB_CONNECTION']);

// This is the list of record for main-database access imports, not all SQL.
// Raw clients passed as parameters (e.g. settings/local/delegates/*) are invisible.
// Categories describe ownership, not transaction-policy compliance.
const RETAINED_ACCESS: readonly AccessEntry[] = [
  { path: 'modules/cloud-tunnel/services/tunnel-keypair.service.ts', category: 'feature-store' },
  { path: 'modules/cloud/services/encrypted-token-store.service.ts', category: 'feature-store' },
  { path: 'modules/cloud/services/project-egress-config.service.ts', category: 'feature-store' },
  { path: 'modules/core/services/normal-readiness-checker.service.ts', category: 'main-db-reader' },
  { path: 'modules/e2ee/services/e2ee-device-store.service.ts', category: 'feature-store' },
  { path: 'modules/e2ee/services/e2ee-keypair.service.ts', category: 'feature-store' },
  {
    path: 'modules/e2ee/services/paired-device-workspace-access.service.ts',
    category: 'feature-store',
  },
  { path: 'modules/epic-time/services/epic-time.store.ts', category: 'documented-exception' },
  { path: 'modules/events/services/committed-event.store.ts', category: 'documented-exception' },
  { path: 'modules/events/services/event-log.service.ts', category: 'feature-store' },
  { path: 'modules/file-sync/file-sync-auto-fix.store.ts', category: 'feature-store' },
  { path: 'modules/file-sync/file-sync-ignores.store.ts', category: 'feature-store' },
  { path: 'modules/file-sync/file-sync-managed-exclusions.store.ts', category: 'feature-store' },
  { path: 'modules/file-sync/syncthing-settings.store.ts', category: 'feature-store' },
  { path: 'modules/remotes/connect-choices.store.ts', category: 'feature-store' },
  { path: 'modules/remotes/git-coordinator/git-coordinator.store.ts', category: 'feature-store' },
  { path: 'modules/remotes/git-owner.store.ts', category: 'feature-store' },
  { path: 'modules/remotes/git-writes/home-git-write.store.ts', category: 'feature-store' },
  {
    path: 'modules/remotes/host/host-docker-volume-associations.store.ts',
    category: 'feature-store',
  },
  { path: 'modules/remotes/host/host-shared-vm.store.ts', category: 'feature-store' },
  {
    path: 'modules/remotes/operations/docker-import-inventory.store.ts',
    category: 'feature-store',
  },
  {
    path: 'modules/remotes/services/remote-forced-detach.store.ts',
    category: 'feature-store',
  },
  { path: 'modules/remotes/services/remote-shared-vm.store.ts', category: 'feature-store' },
  { path: 'modules/remotes/transcripts/transcript-files.service.ts', category: 'main-db-reader' },
  {
    path: 'modules/runtime-context-capture/runtime-context-capture.service.ts',
    category: 'main-db-reader',
  },
  { path: 'modules/seeders/seeders/0002_seed_replace_permission_mode_plan.ts', category: 'seeder' },
  {
    path: 'modules/seeders/seeders/0004_seed_disable_microsoft_source_default.ts',
    category: 'seeder',
  },
  { path: 'modules/seeders/seeders/0006_seed_rename_template_slugs.ts', category: 'seeder' },
  { path: 'modules/seeders/seeders/0009_seed_remove_gemini_provider.ts', category: 'seeder' },
  { path: 'modules/seeders/seeders/0013_seed_prompt_type_tags.ts', category: 'seeder' },
  {
    path: 'modules/seeders/seeders/0014_seed_preserve_project_egress_defaults.ts',
    category: 'seeder',
  },
  { path: 'modules/seeders/services/data-seeder.service.ts', category: 'seeder' },
  {
    path: 'modules/session-reader/services/codex-provider-session-id-backfill.service.ts',
    category: 'main-db-reader',
  },
  {
    path: 'modules/session-reader/services/transcript-persistence.listener.ts',
    category: 'main-db-reader',
  },
  {
    path: 'modules/session-terminal-runtime/session-terminal-runtime.service.ts',
    category: 'main-db-reader',
  },
  {
    path: 'modules/sessions/services/session-runtime/session-launch-pipeline.service.ts',
    category: 'main-db-reader',
  },
  {
    path: 'modules/sessions/services/session-runtime/session-restore-pipeline.service.ts',
    category: 'main-db-reader',
  },
  { path: 'modules/sessions/services/sessions.service.ts', category: 'documented-exception' },
  { path: 'modules/settings/services/settings.service.ts', category: 'settings-owner' },
  { path: 'modules/skills/services/skills.service.ts', category: 'feature-store' },
  { path: 'modules/teams/storage/teams.store.ts', category: 'feature-store' },
  {
    path: 'modules/terminal/services/terminal-activity.service.ts',
    category: 'main-db-reader',
  },
];

function listNonTestSourceFiles(dir: string, srcRoot = SRC_ROOT): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        path === join(srcRoot, 'modules', 'storage') ||
        path === join(srcRoot, 'common', 'test') ||
        entry.name === '__test-utils__' ||
        entry.name === '__fixtures__'
      ) {
        return [];
      }
      return listNonTestSourceFiles(path, srcRoot);
    }
    return entry.name.endsWith('.ts') && !/\.(?:spec|test)\.ts$/.test(entry.name) ? [path] : [];
  });
}

function importsMainDatabaseAccess(source: string): boolean {
  if (![...ACCESS_SYMBOLS].some((symbol) => source.includes(symbol))) return false;
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  return file.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement)) return false;
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((entry) => ACCESS_SYMBOLS.has((entry.propertyName ?? entry.name).text))
    );
  });
}

function accessViolations(
  files: readonly SourceFile[],
  allowlist: readonly AccessEntry[],
): string[] {
  const importers = new Set(
    files
      .filter((file) => !file.path.startsWith('modules/storage/'))
      .filter((file) => importsMainDatabaseAccess(file.source))
      .map((file) => file.path),
  );
  const allowed = new Set(allowlist.map((entry) => entry.path));
  return [
    ...[...importers]
      .filter((path) => !allowed.has(path))
      .map((path) => `Unreviewed importer: ${path}`),
    ...[...allowed].filter((path) => !importers.has(path)).map((path) => `Stale entry: ${path}`),
  ].sort();
}

// Source-level unit checks are the cheapest layer for this import-only boundary.
describe('Retained main-database access imports', () => {
  it('keeps production importers outside storage on the reviewed list', () => {
    const files = listNonTestSourceFiles(SRC_ROOT).map((path) => ({
      path: relative(SRC_ROOT, path).replace(/\\/g, '/'),
      source: readFileSync(path, 'utf8'),
    }));
    expect(accessViolations(files, RETAINED_ACCESS)).toEqual([]);
  });

  // Real temporary directories exercise discovery without mocking away traversal errors.
  it('scans ordinary test/mock directories and fixture filenames while excluding only support paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'raw-db-access-discovery-'));
    const scanned = [
      'modules/example/test/importer.ts',
      'modules/example/__tests__/importer.ts',
      'modules/example/__mocks__/importer.ts',
      'modules/example/mocks/importer.ts',
      'modules/example/importer.fixture.ts',
    ].sort();
    const excluded = [
      'modules/storage/local/importer.ts',
      'common/test/importer.ts',
      'modules/example/__test-utils__/importer.ts',
      'modules/example/__fixtures__/importer.ts',
      'modules/example/importer.spec.ts',
      'modules/example/importer.test.ts',
    ];
    try {
      for (const path of [...scanned, ...excluded]) {
        const file = join(root, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, "import { DB_CONNECTION } from '../storage/db/db.provider';");
      }
      const files = listNonTestSourceFiles(root, root).map((path) => ({
        path: relative(root, path).replace(/\\/g, '/'),
        source: readFileSync(path, 'utf8'),
      }));
      expect(files.map((file) => file.path).sort()).toEqual(scanned);
      expect(accessViolations(files, [])).toEqual(
        scanned.map((path) => `Unreviewed importer: ${path}`),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['getRawSqliteClient', 'DB_CONNECTION'])(
    'rejects a new %s importer, including an aliased multiline import',
    (symbol) => {
      expect(
        accessViolations(
          [
            {
              path: 'modules/new/new.service.ts',
              source: `import {\n ${symbol} as rawAccess\n} from '../storage/db';`,
            },
          ],
          [],
        ),
      ).toEqual(['Unreviewed importer: modules/new/new.service.ts']);
    },
  );

  it.each(['removed', 'no longer imports either symbol'])(
    'rejects a stale entry whose file is %s',
    (scenario) => {
      const path = 'modules/old/old.store.ts';
      const files = scenario === 'removed' ? [] : [{ path, source: 'export const value = 1;' }];
      expect(accessViolations(files, [{ path, category: 'feature-store' }])).toEqual([
        `Stale entry: ${path}`,
      ]);
    },
  );

  it('ignores storage-owned imports, comments, and clients received as parameters', () => {
    expect(
      accessViolations(
        [
          {
            path: 'modules/storage/local/store.ts',
            source: "import { DB_CONNECTION } from '../db/db.provider';",
          },
          {
            path: 'modules/e2ee/services/history.ts',
            source:
              '// DB_CONNECTION getRawSqliteClient\nexport function write(sqlite: any) { sqlite.prepare("DELETE FROM settings").run(); }',
          },
        ],
        [],
      ),
    ).toEqual([]);
  });
});
