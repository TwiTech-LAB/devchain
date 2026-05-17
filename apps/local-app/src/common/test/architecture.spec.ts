import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AgentMessageDeliveryModule } from '../../modules/agent-message-delivery/agent-message-delivery.module';
import { EventsCoreModule } from '../../modules/events/events-core.module';
import { TerminalModule } from '../../modules/terminal/terminal.module';

type AllowlistEntry = {
  path: string;
  kind: string;
};

const EVENTS_DOMAIN_MODULE_TOKEN = 'Events' + 'DomainModule';
const APP_ROOT = resolve(__dirname, '..', '..', '..');
const REPO_ROOT = resolve(APP_ROOT, '..', '..');
const SRC_ROOT = join(APP_ROOT, 'src');
const MODULES_ROOT = join(SRC_ROOT, 'modules');
const ALLOWLIST_PATH = join(REPO_ROOT, 'docs', 'cycle-allowlist.md');

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return listSourceFiles(path);
    }
    return entry.endsWith('.ts') ? [path] : [];
  });
}

function listNonSpecSourceFiles(dir: string): string[] {
  return listSourceFiles(dir).filter((file) => !file.endsWith('.spec.ts'));
}

function readText(file: string): string {
  return readFileSync(file, 'utf8');
}

function moduleName(value: unknown): string | undefined {
  if (typeof value === 'function') {
    return value.name;
  }
  if (
    value &&
    typeof value === 'object' &&
    'forwardRef' in value &&
    typeof (value as { forwardRef?: unknown }).forwardRef === 'function'
  ) {
    const resolved = (value as { forwardRef: () => unknown }).forwardRef();
    return typeof resolved === 'function' ? resolved.name : undefined;
  }
  return undefined;
}

function parseAllowlistFile(filePath: string): AllowlistEntry[] {
  const content = readText(filePath);
  const yamlBlocks = content.match(/```yaml\n([\s\S]*?)```/g);
  if (!yamlBlocks) return [];

  const entries: AllowlistEntry[] = [];
  for (const block of yamlBlocks) {
    const lines = block.split('\n');
    let currentPath: string | null = null;
    let currentKind: string | null = null;

    for (const line of lines) {
      const pathMatch = line.match(/^\s*-?\s*path:\s*"(.+)"$/);
      if (pathMatch) {
        if (currentPath) {
          entries.push({ path: currentPath, kind: currentKind ?? '' });
        }
        currentPath = pathMatch[1];
        currentKind = null;
        continue;
      }

      const kindMatch = line.match(/^\s*kind:\s*([A-Za-z0-9_-]+)\s*$/);
      if (kindMatch && currentPath) {
        currentKind = kindMatch[1];
      }
    }

    if (currentPath) {
      entries.push({ path: currentPath, kind: currentKind ?? '' });
    }
  }

  return entries;
}

describe('Phase 7 architecture invariants', () => {
  it('EventsCoreModule has zero domain imports', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, EventsCoreModule) ?? []) as unknown[];
    const forbidden = new Set([
      'ChatModule',
      'SessionsModule',
      'TerminalModule',
      'AgentMessageDeliveryModule',
      'TeamsModule',
      'ReviewsModule',
      'EpicsModule',
      'WatchersModule',
      'SubscribersModule',
      'HooksModule',
      'CloudModule',
      'ProjectsModule',
      'RegistryModule',
      'AgentsModule',
      'GuestsModule',
    ]);

    const forbiddenHits = imports
      .map(moduleName)
      .filter((name): name is string => Boolean(name && forbidden.has(name)));

    expect(forbiddenHits).toEqual([]);
  });

  it('AgentMessageDeliveryModule does not import full SessionsModule/TerminalModule/ChatModule', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AgentMessageDeliveryModule) ??
      []) as unknown[];
    const forbidden = new Set(['SessionsModule', 'TerminalModule', 'ChatModule']);

    const forbiddenHits = imports
      .map(moduleName)
      .filter((name): name is string => Boolean(name && forbidden.has(name)));

    expect(forbiddenHits).toEqual([]);
  });

  it('AMD source files contain zero ModuleRef.get() for Chat/Sessions/Terminal services', () => {
    const amdFiles = listNonSpecSourceFiles(join(MODULES_ROOT, 'agent-message-delivery'));
    const offenders = amdFiles.flatMap((file) => {
      const content = readText(file);
      const violations = [
        /moduleRef\s*\.\s*get\(\s*Chat\w+/,
        /moduleRef\s*\.\s*get\(\s*Sessions\w+/,
        /moduleRef\s*\.\s*get\(\s*Terminal\w+/,
      ].filter((rule) => rule.test(content));
      return violations.length > 0
        ? [`${relative(APP_ROOT, file)} matched ${violations.length} forbidden ModuleRef.get pattern(s)`]
        : [];
    });

    expect(offenders).toEqual([]);
  });

  it('AMD source files contain zero references to SessionsMessagePoolService (facade-only)', () => {
    const amdFiles = listNonSpecSourceFiles(join(MODULES_ROOT, 'agent-message-delivery'));
    const offenders = amdFiles
      .filter((file) => readText(file).includes('SessionsMessagePoolService'))
      .map((file) => relative(APP_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('No non-test source file references the deleted events domain module (Phase 7 7D.5)', () => {
    const files = listNonSpecSourceFiles(SRC_ROOT);
    const offenders = files
      .filter((file) => readText(file).includes(EVENTS_DOMAIN_MODULE_TOKEN))
      .map((file) => relative(APP_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('TerminalModule.providers does not contain TerminalIOService (relocated to TerminalDeliveryModule)', () => {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TerminalModule) ?? []) as unknown[];
    const providerNames = providers.map(moduleName).filter((name): name is string => Boolean(name));
    expect(providerNames).not.toContain('TerminalIOService');
  });

  it('Feature-module non-test source files contain zero forwardRef calls (post-Phase-7)', () => {
    const featureModuleDirs = [
      'chat',
      'epics',
      'reviews',
      'teams',
      'projects',
      'registry',
      'agents',
      'subscribers',
    ];

    const offenders = featureModuleDirs.flatMap((dir) => {
      const files = listNonSpecSourceFiles(join(MODULES_ROOT, dir));
      return files
        .filter((file) => /forwardRef\s*\(/.test(readText(file)))
        .map((file) => relative(APP_ROOT, file));
    });

    expect(offenders).toEqual([]);
  });

  it('Registry source files contain zero ProjectsService references', () => {
    const files = listNonSpecSourceFiles(join(MODULES_ROOT, 'registry'));
    const offenders = files
      .filter((file) => readText(file).includes('ProjectsService'))
      .map((file) => relative(APP_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('events/index.ts and events/events.module.ts have no stale EventsDomain exports/imports', () => {
    const eventsIndex = readText(join(MODULES_ROOT, 'events', 'index.ts'));
    const eventsModule = readText(join(MODULES_ROOT, 'events', 'events.module.ts'));
    const staleDomainImportPattern = /from\s+['"]\.\/events-domain\.module['"]/;

    expect(eventsIndex).not.toMatch(staleDomainImportPattern);
    expect(eventsModule).not.toMatch(staleDomainImportPattern);
  });

  it('Cycle allowlist contains only file-structure or nest-module-structural kinds', () => {
    const entries = parseAllowlistFile(ALLOWLIST_PATH);
    const allowedKinds = new Set(['file-structure', 'nest-module-structural']);
    const invalid = entries.filter((entry) => !allowedKinds.has(entry.kind));

    expect(entries.length).toBeGreaterThan(0);
    expect(invalid).toEqual([]);
  });
});
