import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { AgentMessageDeliveryModule } from '../../modules/agent-message-delivery/agent-message-delivery.module';
import { EventsCoreModule } from '../../modules/events/events-core.module';
import { TerminalModule } from '../../modules/terminal/terminal.module';

type AllowlistEntry = {
  path: string;
  kind: string;
  rationale: string;
  expiry: string;
};

const EVENTS_DOMAIN_MODULE_TOKEN = 'Events' + 'DomainModule';
const APP_ROOT = resolve(__dirname, '..', '..', '..');
const SRC_ROOT = join(APP_ROOT, 'src');
const MODULES_ROOT = join(SRC_ROOT, 'modules');
const ALLOWLIST_PATH = join(APP_ROOT, 'scripts', 'cycle-allowlist.json');
const BOARD_PAGE_VIEW_PATH = join(SRC_ROOT, 'ui', 'pages', 'board', 'BoardPageView.tsx');
const PROJECTS_PAGE_ROOT = join(SRC_ROOT, 'ui', 'pages', 'projects');
const PROJECTS_RENDER_PATHS = [
  join(PROJECTS_PAGE_ROOT, 'ProjectsPageView.tsx'),
  join(PROJECTS_PAGE_ROOT, 'ProjectsTable.tsx'),
  join(PROJECTS_PAGE_ROOT, 'ProjectsDialogs.tsx'),
] as const;
const IN_MEMORY_PROJECTS_API_PATH = join(
  APP_ROOT,
  'test',
  'helpers',
  'in-memory-projects-page-api',
);
const MCP_ROOT = join(MODULES_ROOT, 'mcp');
const MCP_METADATA_ENTRYPOINT = join(MCP_ROOT, 'tool-descriptors', 'index.ts');
const MCP_SERVICE_PATH = join(MCP_ROOT, 'services', 'mcp.service.ts');
const MCP_BINDING_FILES = [
  'agent.bindings.ts',
  'chat.bindings.ts',
  'epic.bindings.ts',
  'project.bindings.ts',
  'prompt.bindings.ts',
  'record.bindings.ts',
  'review.bindings.ts',
  'session.bindings.ts',
  'skill.bindings.ts',
  'team.bindings.ts',
] as const;

type BoardViewBoundaryViolation = 'routing' | 'url-policy' | 'http-adapter' | 'storage';
type ProjectsRenderBoundaryViolation =
  | 'routing'
  | 'query'
  | 'projects-api'
  | 'orchestration-hook'
  | 'react-state-effect'
  | 'fetch'
  | 'storage';

const BOARD_VIEW_FORBIDDEN_IMPORTS = new Map<string, BoardViewBoundaryViolation>([
  [join(SRC_ROOT, 'ui', 'lib', 'url-filters'), 'url-policy'],
  [join(SRC_ROOT, 'ui', 'pages', 'board', 'lib', 'board-api'), 'http-adapter'],
  [join(SRC_ROOT, 'ui', 'hooks', 'useFetchFactory'), 'http-adapter'],
]);

function listTypeScriptFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  return entries.flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return listTypeScriptFiles(path);
    }
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

function listNonSpecSourceFiles(dir: string): string[] {
  return listTypeScriptFiles(dir).filter(
    (file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'),
  );
}

function listProductionTypeScriptFiles(dir: string): string[] {
  return listTypeScriptFiles(dir).filter((file) => !/\.spec\.tsx?$/.test(file));
}

function readText(file: string): string {
  return readFileSync(file, 'utf8');
}

function sourceImportSpecifiers(source: string): string[] {
  return [...source.matchAll(/\b(?:from\s+|import\s*(?:\(\s*)?)["']([^"']+)["']/g)].map(
    (match) => match[1],
  );
}

function resolveSourceImport(importerPath: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) {
    return resolve(SRC_ROOT, specifier.slice(2)).replace(/\.[cm]?[jt]sx?$/, '');
  }
  if (specifier.startsWith('.')) {
    return resolve(dirname(importerPath), specifier).replace(/\.[cm]?[jt]sx?$/, '');
  }
  return null;
}

function resolveLocalTypeScriptImport(importerPath: string, specifier: string): string | null {
  const unresolved = resolveSourceImport(importerPath, specifier);
  if (!unresolved) return null;

  const candidates = [`${unresolved}.ts`, join(unresolved, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function localTypeScriptImportGraph(entrypoint: string): string[] {
  const pending = [entrypoint];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);

    for (const specifier of sourceImportSpecifiers(readText(file))) {
      const dependency = resolveLocalTypeScriptImport(file, specifier);
      if (dependency && !visited.has(dependency)) {
        pending.push(dependency);
      }
    }
  }

  return [...visited].sort();
}

function isForbiddenMcpServiceImport(specifier: string): boolean {
  const resolvedImport = resolveSourceImport(MCP_SERVICE_PATH, specifier);
  if (!resolvedImport) return false;

  const sourcePath = relative(SRC_ROOT, resolvedImport).replaceAll('\\', '/');
  return (
    /^modules\/mcp\/tool-descriptors\/(?:runtime-bindings|[^/]+\.bindings)$/.test(sourcePath) ||
    /^modules\/mcp\/services\/handlers\/(?:[^/]+-context|null-adapter)$/.test(sourcePath) ||
    /^modules\/(?!mcp(?:\/|$))[^/]+\/services\//.test(sourcePath) ||
    /^modules\/(?!mcp(?:\/|$))[^/]+\/(?:[^/]+\/)*[^/]+\.service$/.test(sourcePath)
  );
}

function boardViewBoundaryViolations(
  source: string,
  importerPath = BOARD_PAGE_VIEW_PATH,
): BoardViewBoundaryViolation[] {
  const violations = new Set<BoardViewBoundaryViolation>();

  for (const specifier of sourceImportSpecifiers(source)) {
    if (specifier === 'react-router-dom') {
      violations.add('routing');
      continue;
    }

    const resolvedImport = resolveSourceImport(importerPath, specifier);
    const violation = resolvedImport && BOARD_VIEW_FORBIDDEN_IMPORTS.get(resolvedImport);
    if (violation) {
      violations.add(violation);
    }
  }

  if (/\bfetch\s*\(/.test(source)) {
    violations.add('http-adapter');
  }
  if (/\blocalStorage\b/.test(source)) {
    violations.add('storage');
  }

  return [...violations].sort();
}

function projectsRenderBoundaryViolations(
  source: string,
  importerPath = PROJECTS_RENDER_PATHS[0],
): ProjectsRenderBoundaryViolation[] {
  const violations = new Set<ProjectsRenderBoundaryViolation>();
  const namespaceReactOwnsStateOrEffect = [
    ...source.matchAll(/\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s*from\s*['"]react['"]/g),
  ].some((match) => {
    const namespace = match[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `\\b${namespace}\\s*\\.\\s*use(?:State|Reducer|Effect|LayoutEffect)\\s*\\(`,
    ).test(source);
  });

  for (const specifier of sourceImportSpecifiers(source)) {
    if (specifier === 'react-router-dom') {
      violations.add('routing');
      continue;
    }
    if (specifier === '@tanstack/react-query' || specifier.startsWith('@tanstack/react-query/')) {
      violations.add('query');
      continue;
    }

    const resolvedImport = resolveSourceImport(importerPath, specifier);
    if (!resolvedImport) continue;
    const sourcePath = relative(SRC_ROOT, resolvedImport).replaceAll('\\', '/');

    if (/^ui\/pages\/projects\/lib\/projects-(?:http-api|page-api)$/.test(sourcePath)) {
      violations.add('projects-api');
    }
    if (
      /^ui\/hooks\/(?:useProjectsPageController|useCreateProjectWizard|useImportProjectWizard|useProjectSetupWizard|useTemplateForm)$/.test(
        sourcePath,
      ) ||
      sourcePath === 'ui/pages/projects/hooks/useProjectImportSource'
    ) {
      violations.add('orchestration-hook');
    }
  }

  if (
    /\buse(?:State|Reducer|Effect|LayoutEffect)\s*\(/.test(source) ||
    /\bimport(?:\s+type)?\s*{[^}]*\buse(?:State|Reducer|Effect|LayoutEffect)\b[^}]*}\s*from\s*['"]react['"]/s.test(
      source,
    ) ||
    namespaceReactOwnsStateOrEffect
  ) {
    violations.add('react-state-effect');
  }
  if (/\bfetch\s*\(/.test(source)) {
    violations.add('fetch');
  }
  if (/\b(?:localStorage|sessionStorage)\b/.test(source)) {
    violations.add('storage');
  }

  return [...violations].sort();
}

function importsInMemoryProjectsApi(source: string, importerPath: string): boolean {
  return sourceImportSpecifiers(source).some((specifier) => {
    const resolvedImport = resolveSourceImport(importerPath, specifier);
    return resolvedImport === IN_MEMORY_PROJECTS_API_PATH;
  });
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

function parseAllowlistFile(filePath: string): unknown {
  return JSON.parse(readText(filePath));
}

describe('Phase 7 architecture invariants', () => {
  it('EventsCoreModule has zero domain imports', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, EventsCoreModule) ??
      []) as unknown[];
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
        ? [
            `${relative(APP_ROOT, file)} matched ${violations.length} forbidden ModuleRef.get pattern(s)`,
          ]
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
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, TerminalModule) ??
      []) as unknown[];
    const providerNames = providers.map(moduleName).filter((name): name is string => Boolean(name));
    expect(providerNames).not.toContain('TerminalIOService');
  });

  it('TerminalModule does not import SessionsModule', () => {
    const imports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, TerminalModule) ??
      []) as unknown[];
    const importNames = imports.map(moduleName).filter((name): name is string => Boolean(name));

    expect(importNames).not.toContain('SessionsModule');
  });

  it('Terminal source does not depend on broad SessionsService', () => {
    const files = listNonSpecSourceFiles(join(MODULES_ROOT, 'terminal'));
    const offenders = files
      .filter((file) => readText(file).includes('SessionsService'))
      .map((file) => relative(APP_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('terminal prompt protection never synthesizes editor preservation keys', () => {
    const forbiddenFragments = [
      ['st', 'ash'].join(''),
      ['ya', 'nk'].join(''),
      ['prompt', 'clear'].join('-'),
      ['kill', 'ring'].join('-'),
      ['C', 'u'].join('-'),
      ['C', 'k'].join('-'),
      ['C', 'y'].join('-'),
      ['M', 'y'].join('-'),
    ];
    const offenders = listTypeScriptFiles(SRC_ROOT).flatMap((file) => {
      const content = readText(file);
      const hits = forbiddenFragments.filter((fragment) => content.includes(fragment));
      return hits.length > 0 ? [`${relative(APP_ROOT, file)} contains ${hits.join(', ')}`] : [];
    });

    expect(offenders).toEqual([]);
  });

  it('PtyService does not import TerminalGateway', () => {
    const ptyService = readText(join(MODULES_ROOT, 'terminal', 'services', 'pty.service.ts'));

    expect(ptyService).not.toMatch(/from\s+['"][^'"]*terminal\.gateway['"]/);
  });

  it('Session-terminal runtime source imports neither Sessions nor Terminal', () => {
    const files = listNonSpecSourceFiles(join(MODULES_ROOT, 'session-terminal-runtime'));
    const forbiddenImport = /from\s+['"][^'"]*(?:\/sessions\/|\/terminal\/)[^'"]*['"]/;
    const offenders = files
      .filter((file) => forbiddenImport.test(readText(file)))
      .map((file) => relative(APP_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('Feature-module non-test source files contain zero forwardRef calls (post-Phase-7)', () => {
    const featureModuleDirs = [
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

  it('Cycle allowlist has valid required fields, kinds, and unique paths', () => {
    const parsed = parseAllowlistFile(ALLOWLIST_PATH);
    expect(Array.isArray(parsed)).toBe(true);

    const entries = parsed as unknown[];
    const allowedKinds = new Set(['file-structure', 'nest-module-structural']);
    const requiredFields: (keyof AllowlistEntry)[] = ['path', 'kind', 'rationale', 'expiry'];
    const errors: string[] = [];
    const paths: string[] = [];

    entries.forEach((candidate, index) => {
      if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
        errors.push(`$[${index}] must be an object`);
        return;
      }

      const entry = candidate as Record<string, unknown>;
      for (const field of requiredFields) {
        const value = entry[field];
        if (typeof value !== 'string' || value.trim() === '') {
          errors.push(`$[${index}].${field} must be a non-empty string`);
        }
      }
      if (!allowedKinds.has(entry.kind as string)) {
        errors.push(`$[${index}].kind is invalid`);
      }
      if (typeof entry.path === 'string') {
        paths.push(entry.path);
      }
    });

    expect(errors).toEqual([]);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('MCP binding ownership boundaries', () => {
  it('keeps the metadata entrypoint import graph free of bindings, handlers, and MCP services', () => {
    const graph = localTypeScriptImportGraph(MCP_METADATA_ENTRYPOINT);
    const offenders = graph
      .map((file) => relative(MCP_ROOT, file).replaceAll('\\', '/'))
      .filter(
        (file) =>
          file === 'tool-descriptors/runtime-bindings.ts' ||
          file.endsWith('.bindings.ts') ||
          file.startsWith('services/'),
      );

    expect(offenders).toEqual([]);
  });

  it('keeps McpService free of domain contexts, domain services, binding groups, and null adapters', () => {
    const forbiddenImports = sourceImportSpecifiers(readText(MCP_SERVICE_PATH)).filter(
      isForbiddenMcpServiceImport,
    );

    expect(forbiddenImports).toEqual([]);
  });

  it('classifies relative and alias McpService imports by their resolved ownership boundary', () => {
    const forbidden = [
      './handlers/agent-context',
      '@/modules/mcp/services/handlers/agent-context',
      './handlers/null-adapter',
      '@/modules/mcp/services/handlers/null-adapter',
      '../../epics/services/epics.service',
      '@/modules/epics/services/epics.service',
      '../../agent-message-delivery/agent-message-delivery.service',
      '@/modules/agent-message-delivery/agent-message-delivery.service',
      '../../project-communication/project-communication.service',
      '@/modules/project-communication/project-communication.service',
      '../tool-descriptors/agent.bindings',
      '@/modules/mcp/tool-descriptors/agent.bindings',
    ];
    const allowed = [
      './mcp-tool-binding.registry',
      '@/modules/mcp/services/mcp-tool-binding.registry',
      './utils/resource-resolver',
      '@/modules/mcp/services/utils/resource-resolver',
      '../../storage/interfaces/storage.interface',
      '@/modules/storage/interfaces/storage.interface',
    ];

    expect(forbidden.filter((specifier) => !isForbiddenMcpServiceImport(specifier))).toEqual([]);
    expect(allowed.filter(isForbiddenMcpServiceImport)).toEqual([]);
  });

  it('keeps all ten binding groups free of double-cast escapes', () => {
    const bindingRoot = join(MCP_ROOT, 'tool-descriptors');
    const discovered = readdirSync(bindingRoot)
      .filter((file) => file.endsWith('.bindings.ts'))
      .sort();
    const offenders = discovered.filter((file) =>
      /\bas\s+unknown\s+as\b/.test(readText(join(bindingRoot, file))),
    );

    expect(discovered).toEqual([...MCP_BINDING_FILES].sort());
    expect(offenders).toEqual([]);
  });

  it('keeps the MCP forwardRef delta at nine registry injections and seven module imports', () => {
    const callsByFile = Object.fromEntries(
      listNonSpecSourceFiles(MCP_ROOT)
        .map(
          (file) =>
            [
              relative(APP_ROOT, file).replaceAll('\\', '/'),
              [...readText(file).matchAll(/\bforwardRef\s*\(/g)].length,
            ] as const,
        )
        .filter(([, count]) => count > 0),
    );

    expect(callsByFile).toEqual({
      'src/modules/mcp/mcp-full.module.ts': 7,
      'src/modules/mcp/services/mcp-tool-binding.registry.ts': 9,
    });
  });
});

describe('UI feature boundaries', () => {
  it('keeps the in-memory Projects API outside production imports', () => {
    const offenders = listProductionTypeScriptFiles(join(SRC_ROOT, 'ui'))
      .filter((file) => importsInMemoryProjectsApi(readText(file), file))
      .map((file) => relative(SRC_ROOT, file).replaceAll('\\', '/'));

    expect(offenders).toEqual([]);
  });

  it.each([
    ["import { InMemoryProjectsPageApi } from '@/../test/helpers/in-memory-projects-page-api';"],
    [
      "import type { InMemoryProjectsPageApi } from '../../../../test/helpers/in-memory-projects-page-api';",
    ],
  ])('rejects production imports of the in-memory Projects API: %s', (source) => {
    expect(importsInMemoryProjectsApi(source, PROJECTS_RENDER_PATHS[0])).toBe(true);
  });

  it.each(PROJECTS_RENDER_PATHS)(
    'keeps %s free of state, effects, routing, query, transport, orchestration, and storage ownership',
    (file) => {
      expect(projectsRenderBoundaryViolations(readText(file), file)).toEqual([]);
    },
  );

  it.each([
    ['router import', "import { useNavigate } from 'react-router-dom';", 'routing'],
    ['TanStack Query import', "import { useQuery } from '@tanstack/react-query';", 'query'],
    [
      'Projects HTTP alias',
      "import { projectsHttpApi } from '@/ui/pages/projects/lib/projects-http-api';",
      'projects-api',
    ],
    [
      'Projects API relative type import',
      "import type { ProjectsPageApi } from './lib/projects-page-api';",
      'projects-api',
    ],
    [
      'controller alias',
      "import { useProjectsPageController } from '@/ui/hooks/useProjectsPageController';",
      'orchestration-hook',
    ],
    [
      'wizard relative type import',
      "import type { ProjectSetupWizardController } from '../../hooks/useProjectSetupWizard';",
      'orchestration-hook',
    ],
    [
      'feature-local source hook',
      "import { useProjectImportSource } from './hooks/useProjectImportSource';",
      'orchestration-hook',
    ],
    ['direct fetch', "void window.fetch('/api/projects');", 'fetch'],
    ['local storage', "localStorage.setItem('projects', 'value');", 'storage'],
    ['session storage', "window.sessionStorage.getItem('projects');", 'storage'],
    [
      'aliased useState import',
      "import { useState as ownState } from 'react'; const value = ownState(false);",
      'react-state-effect',
    ],
    [
      'namespace React useState call',
      "import * as React from 'react'; const value = React.useState(false);",
      'react-state-effect',
    ],
    ['useEffect call', 'useEffect(() => undefined, []);', 'react-state-effect'],
  ] as const)('rejects %s ownership in Projects render files', (_name, source, violation) => {
    expect(projectsRenderBoundaryViolations(source)).toContain(violation);
  });

  it('allows presentation contracts and rendered child imports in Projects render files', () => {
    const source = [
      "import type { ProjectsDialogsModel } from './projects-page-presentation';",
      "import { EditProjectDialog } from '@/ui/components/project/EditProjectDialog';",
    ].join('\n');

    expect(projectsRenderBoundaryViolations(source)).toEqual([]);
  });

  it('keeps BoardPageView free of routing, URL, HTTP, and storage ownership', () => {
    const boardPageView = readText(BOARD_PAGE_VIEW_PATH);

    expect(boardViewBoundaryViolations(boardPageView)).toEqual([]);
  });

  it.each([
    ['router import', "import { useNavigate } from 'react-router-dom';", 'routing'],
    ['URL-policy alias', "import { parseBoardFilters } from '@/ui/lib/url-filters';", 'url-policy'],
    [
      'URL-policy relative path',
      "import { parseBoardFilters } from '../../lib/url-filters';",
      'url-policy',
    ],
    [
      'HTTP-adapter alias',
      "import { fetchEpics } from '@/ui/pages/board/lib/board-api';",
      'http-adapter',
    ],
    ['HTTP-adapter relative path', "import { fetchEpics } from './lib/board-api';", 'http-adapter'],
    [
      'fetch-factory alias',
      "import { useFetchFactory } from '@/ui/hooks/useFetchFactory';",
      'http-adapter',
    ],
    [
      'fetch-factory relative path',
      "import { useFetchFactory } from '../../hooks/useFetchFactory';",
      'http-adapter',
    ],
    ['direct fetch', "void fetch('/api/epics');", 'http-adapter'],
    ['local storage', "localStorage.setItem('board', 'value');", 'storage'],
  ] as const)('rejects %s ownership in BoardPageView', (_name, source, expectedViolation) => {
    expect(boardViewBoundaryViolations(source)).toContain(expectedViolation);
  });
});
