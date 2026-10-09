import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { MODULE_METADATA } from '@nestjs/common/constants';
import ts from 'typescript';
import { AgentMessageDeliveryModule } from '../../modules/agent-message-delivery/agent-message-delivery.module';
import { EventsCoreModule } from '../../modules/events/events-core.module';
import { PROVIDER_TRAITS } from '../../modules/providers/adapters/provider-traits';
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
const UI_ROOT = join(SRC_ROOT, 'ui');
const OWNED_QUERY_ROOTS = new Map([
  ['agents', join(UI_ROOT, 'lib', 'agents.ts')],
  ['health', join(UI_ROOT, 'lib', 'health.ts')],
  ['provider-efforts', join(UI_ROOT, 'lib', 'provider-efforts.ts')],
  ['provider-configs', join(UI_ROOT, 'lib', 'provider-configs.ts')],
  ['provider-configs-by-profile', join(UI_ROOT, 'lib', 'provider-configs.ts')],
  ['statuses', join(UI_ROOT, 'lib', 'statuses.ts')],
  ['profiles', join(UI_ROOT, 'lib', 'profiles.ts')],
  ['project-presets', join(UI_ROOT, 'lib', 'project-presets.ts')],
  ['prompts', join(UI_ROOT, 'lib', 'prompts.ts')],
  ['settings', join(UI_ROOT, 'lib', 'settings.ts')],
]);
const MODULES_ROOT = join(SRC_ROOT, 'modules');
const ALLOWLIST_PATH = join(APP_ROOT, 'scripts', 'cycle-allowlist.json');
const BOARD_PAGE_VIEW_PATH = join(SRC_ROOT, 'ui', 'pages', 'board', 'BoardPageView.tsx');
const PROJECTS_PAGE_ROOT = join(SRC_ROOT, 'ui', 'pages', 'projects');
const PROJECTS_RENDER_PATHS = [
  join(PROJECTS_PAGE_ROOT, 'ProjectsPageView.tsx'),
  join(PROJECTS_PAGE_ROOT, 'ProjectsTable.tsx'),
  join(PROJECTS_PAGE_ROOT, 'ProjectsDialogs.tsx'),
] as const;
/** Test-only API modules that production UI code must not import. */
const TEST_ONLY_API_PATHS = {
  Projects: join(APP_ROOT, 'test', 'helpers', 'in-memory-projects-page-api'),
  'Remote VM': join(APP_ROOT, 'test', 'helpers', 'in-memory-remote-vm-api'),
} as const;
const REMOTE_VM_VIEW_PATH = join(UI_ROOT, 'pages', 'cloud', 'RemoteVmSectionView.tsx');
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
type RenderBoundaryViolation =
  | 'routing'
  | 'query'
  | 'projects-api'
  | 'remote-vm-api'
  | 'transport'
  | 'orchestration-hook'
  | 'react-state-effect'
  | 'fetch'
  | 'storage';

interface RenderBoundaryRules {
  apiPath: RegExp;
  apiViolation: 'projects-api' | 'remote-vm-api';
  orchestrationPaths: RegExp[];
  transportPaths?: Set<string>;
}

const PROJECTS_RENDER_RULES: RenderBoundaryRules = {
  apiPath: /^ui\/pages\/projects\/lib\/projects-(?:http-api|page-api)$/,
  apiViolation: 'projects-api',
  orchestrationPaths: [
    /^ui\/hooks\/(?:useProjectsPageController|useCreateProjectWizard|useImportProjectWizard|useProjectSetupWizard|useTemplateForm)$/,
    /^ui\/pages\/projects\/hooks\/useProjectImportSource$/,
  ],
};
const REMOTE_VM_RENDER_RULES: RenderBoundaryRules = {
  apiPath: /^ui\/pages\/cloud\/lib\/remote-vm-(?:api|http-api|api-context)$/,
  apiViolation: 'remote-vm-api',
  orchestrationPaths: [
    /^ui\/hooks\//,
    /^ui\/pages\/cloud\/(?:project-action-intent|useFileSyncSuggestions)$/,
  ],
  transportPaths: new Set(['ui/lib/api-transport', 'ui/lib/runtime']),
};

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

function bareStorageConstructorInjections(source: string): string[] {
  if (!source.includes('STORAGE_SERVICE')) return [];
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isConstructorDeclaration(node)) {
      for (const parameter of node.parameters) {
        const type = parameter.type;
        if (
          !type ||
          !ts.isTypeReferenceNode(type) ||
          !ts.isIdentifier(type.typeName) ||
          type.typeName.text !== 'StorageService' ||
          type.typeArguments?.length
        ) {
          continue;
        }
        const injectsStorage = (ts.getDecorators(parameter) ?? []).some((decorator) => {
          const call = decorator.expression;
          if (
            !ts.isCallExpression(call) ||
            !ts.isIdentifier(call.expression) ||
            call.expression.text !== 'Inject'
          ) {
            return false;
          }
          const token = call.arguments[0];
          return (
            token &&
            (ts.isIdentifier(token) || ts.isStringLiteral(token)) &&
            token.text === 'STORAGE_SERVICE'
          );
        });
        if (injectsStorage) violations.push(parameter.name.getText(file));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return violations;
}

function listProductionTypeScriptFiles(dir: string): string[] {
  // Colocated fixtures are test sources even though they live under src.
  return listTypeScriptFiles(dir).filter((file) => !/\.(?:spec|fixture)\.tsx?$/.test(file));
}

function readText(file: string): string {
  return readFileSync(file, 'utf8');
}

function ownedQueryRootViolations(source: string, filePath: string): string[] {
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const violations = new Set<string>();
  const initializers = new Map<string, ts.Expression>();
  const collectInitializers = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectInitializers);
  };
  collectInitializers(file);

  const inspectKey = (expression: ts.Expression, seen = new Set<string>()): void => {
    if (
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isParenthesizedExpression(expression)
    ) {
      inspectKey(expression.expression, seen);
    } else if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
      seen.add(expression.text);
      const initializer = initializers.get(expression.text);
      if (initializer) inspectKey(initializer, seen);
    } else if (ts.isArrayLiteralExpression(expression)) {
      const root = expression.elements[0];
      if (root && ts.isStringLiteralLike(root)) inspectRoot(root.text);
    }
  };
  const inspectRoot = (root: string): void => {
    const owner = OWNED_QUERY_ROOTS.get(root);
    if (owner && resolve(filePath) !== owner) violations.add(root);
  };
  const isQueryKeyHead = (node: ts.Expression): boolean =>
    ts.isElementAccessExpression(node) &&
    ts.isNumericLiteral(node.argumentExpression) &&
    node.argumentExpression.text === '0' &&
    ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'queryKey') ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'queryKey'));
  const keyArgumentMethods = new Set([
    'getQueryData',
    'getQueryState',
    'setQueryData',
    'getQueriesData',
    'setQueriesData',
    'invalidateQueries',
    'refetchQueries',
    'resetQueries',
    'removeQueries',
    'cancelQueries',
    'fetchQuery',
    'prefetchQuery',
    'ensureQueryData',
  ]);
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === 'queryKey'
    ) {
      inspectKey(node.initializer);
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'queryKey') {
      inspectKey(node.name);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      keyArgumentMethods.has(node.expression.name.text) &&
      node.arguments[0]
    ) {
      inspectKey(node.arguments[0]);
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      if (isQueryKeyHead(node.left) && ts.isStringLiteral(node.right)) {
        inspectRoot(node.right.text);
      }
      if (isQueryKeyHead(node.right) && ts.isStringLiteral(node.left)) {
        inspectRoot(node.left.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...violations];
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

function renderBoundaryViolations(
  source: string,
  importerPath = PROJECTS_RENDER_PATHS[0],
  rules = PROJECTS_RENDER_RULES,
): RenderBoundaryViolation[] {
  const violations = new Set<RenderBoundaryViolation>();
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

    if (rules.apiPath.test(sourcePath)) {
      violations.add(rules.apiViolation);
    }
    if (rules.orchestrationPaths.some((path) => path.test(sourcePath))) {
      violations.add('orchestration-hook');
    }
    if (rules.transportPaths?.has(sourcePath)) violations.add('transport');
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

function importsInMemoryApi(source: string, importerPath: string, apiPath: string): boolean {
  return sourceImportSpecifiers(source).some((specifier) => {
    const resolvedImport = resolveSourceImport(importerPath, specifier);
    return resolvedImport === apiPath;
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

describe('Storage consumer boundaries', () => {
  it.each([
    ['@Inject(STORAGE_SERVICE) private readonly storage: StorageService', ['storage']],
    ["@Inject('STORAGE_SERVICE') storage: StorageService", ['storage']],
    ['@Inject("STORAGE_SERVICE") storage: StorageService', ['storage']],
    ['@Inject(STORAGE_SERVICE) storage: AgentStorage & ProjectStorage', []],
    ["@Inject(STORAGE_SERVICE) storage: Pick<StorageService, 'getAgent'>", []],
    ['storage: StorageService', []],
    ['@Inject(OTHER_SERVICE) storage: StorageService', []],
  ])('detects bare storage only in injected constructor parameters: %s', (parameter, expected) => {
    expect(
      bareStorageConstructorInjections(`class Consumer { constructor(${parameter}) {} }`),
    ).toEqual(expected);
  });

  it('ignores storage annotations outside injected constructor parameters', () => {
    expect(
      bareStorageConstructorInjections(`
        const token = STORAGE_SERVICE;
        interface Fixture { storage: StorageService; }
        const provider = { useFactory: (storage: StorageService) => storage };
      `),
    ).toEqual([]);
  });

  it('requires role slices for storage injected outside the storage module', () => {
    // Source inspection checks the dependency contract without booting the application.
    const violations = listNonSpecSourceFiles(SRC_ROOT).flatMap((file) => {
      const sourcePath = relative(SRC_ROOT, file).replaceAll('\\', '/');
      if (sourcePath.startsWith('modules/storage/')) return [];
      return bareStorageConstructorInjections(readText(file)).map(
        (parameter) => `${sourcePath}: ${parameter}`,
      );
    });
    expect(violations).toEqual([]);
  });
});

describe('provider-seam', () => {
  const providerNames = new Set(Object.keys(PROVIDER_TRAITS));
  const neutralFiles = [
    'terminal/services/terminal-activity.service.ts',
    'terminal/services/human-prompt-state.service.ts',
    'session-reader/services/transcript-watcher.service.ts',
    'sessions/services/provider-runtime-preparation/provider-runtime-preparation.service.ts',
    'sessions/services/sessions.service.ts',
    'sessions/services/session-runtime/session-launch-pipeline.service.ts',
    'session-terminal-runtime/session-terminal-runtime.service.ts',
  ];

  function providerNameLiterals(source: string): string[] {
    const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
    const violations: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        providerNames.has(node.text.toLowerCase())
      ) {
        violations.push(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return violations;
  }

  // AST inspection enforces the complete source boundary without running lifecycle services.
  it.each(neutralFiles)('keeps provider-name literals out of %s', (file) => {
    expect(providerNameLiterals(readText(join(MODULES_ROOT, file)))).toEqual([]);
  });

  // An in-memory fixture proves rejection of both literal kinds without altering repository files.
  it('rejects provider names in string and template literals regardless of case', () => {
    const source = [
      "const a = 'ClAuDe';",
      'const b = `CODEX`;',
      'const c = "OpenCode";',
      'const d = `AgY`;',
      "const e = 'COPILOT';",
      '// claude is allowed in comments',
      "const other = 'claude-launch';",
    ].join('\n');

    expect(providerNameLiterals(source)).toEqual(['ClAuDe', 'CODEX', 'OpenCode', 'AgY', 'COPILOT']);
  });
});

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

  // Source inspection is the cheapest layer for enforcing ownership across every production caller.
  it('human prompt mutations and barrier publication stay inside HumanPromptInputService', () => {
    const owner = join(MODULES_ROOT, 'terminal/services/human-prompt-input.service.ts');
    const offenders = listNonSpecSourceFiles(SRC_ROOT)
      .filter((file) => file !== owner)
      .filter((file) => {
        const content = readText(file);
        return (
          /\.\s*(?:recordPromptText|recordControlInput|confirmPromptTextWritten)\s*\(/.test(
            content,
          ) || /\bimport\s+(?:type\s+)?[^;]*\bemitHumanPromptStateChangedBarrier\b/.test(content)
        );
      })
      .map((file) => relative(APP_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it.each([
    ['agent-message-delivery', 'SessionsMessagePoolService'],
    ['', EVENTS_DOMAIN_MODULE_TOKEN],
    ['terminal', 'SessionsService'],
  ])('%s source excludes %s', (domain, token) => {
    const files = listNonSpecSourceFiles(domain ? join(MODULES_ROOT, domain) : SRC_ROOT);
    expect(
      files
        .filter((file) => readText(file).includes(token))
        .map((file) => relative(APP_ROOT, file)),
    ).toEqual([]);
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

  it('Only remotes source imports remotes/admission', () => {
    const offenders = listNonSpecSourceFiles(MODULES_ROOT)
      .filter((file) => !relative(MODULES_ROOT, file).startsWith('remotes/'))
      .filter((file) =>
        sourceImportSpecifiers(readText(file)).some((specifier) =>
          /remotes\/admission(?:\/|$)/.test(specifier),
        ),
      )
      .map((file) => relative(APP_ROOT, file));

    expect(offenders).toEqual([]);
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
  // Parsing production code is the cheapest layer that can enforce cache ownership.
  it('keeps owned query roots in their resource modules', () => {
    const offenders = listProductionTypeScriptFiles(UI_ROOT).flatMap((file) =>
      ownedQueryRootViolations(readText(file), file).map(
        (root) => `${relative(SRC_ROOT, file)}: ${root}`,
      ),
    );

    expect(offenders).toEqual([]);
  });

  it.each([
    "useQuery({ queryKey: ['agents', pid] });",
    "useQuery({ 'queryKey': ['agents', pid] as const });",
    "const key = ['agents', pid] as const; useQuery({ queryKey: key });",
    "const queryKey = ['agents', pid]; useQuery({ queryKey });",
    "queryClient.setQueryData(['agents', pid], data);",
    "queryClient.invalidateQueries({ queryKey: ['agents', pid] });",
    "queryClient.invalidateQueries({ predicate: q => q.queryKey[0] === 'agents' });",
    "queryClient.removeQueries({ predicate: q => 'agents' === q.queryKey[0] });",
  ])('rejects owned query roots outside the owner: %s', (source) => {
    expect(ownedQueryRootViolations(source, join(UI_ROOT, 'pages', 'Example.tsx'))).toEqual([
      'agents',
    ]);
  });

  it.each([...OWNED_QUERY_ROOTS])(
    'keeps the %s root literal in its owner module',
    (root, owner) => {
      expect(readText(owner)).toContain(`'${root}'`);
    },
  );

  it.each([
    "type TemplateAgent = NonNullable<ExportData['agents']>[number];",
    'useQuery({ queryKey: agentQueryKeys.list(pid) });',
    "queryClient.invalidateQueries({ queryKey: ['agent-presence', pid] });",
  ])('allows types and delegated or unowned keys: %s', (source) => {
    expect(ownedQueryRootViolations(source, join(UI_ROOT, 'pages', 'Example.tsx'))).toEqual([]);
  });

  it.each([...OWNED_QUERY_ROOTS])(
    'allows %s key definitions in its owner module',
    (root, owner) => {
      expect(
        ownedQueryRootViolations(`queryClient.setQueryData(['${root}', pid], data);`, owner),
      ).toEqual([]);
    },
  );

  it('keeps the in-memory Projects and Remote VM APIs outside production imports', () => {
    const offenders = listProductionTypeScriptFiles(UI_ROOT).flatMap((file) => {
      const source = readText(file);
      return Object.entries(TEST_ONLY_API_PATHS)
        .filter(([, apiPath]) => importsInMemoryApi(source, file, apiPath))
        .map(
          ([name]) =>
            `${relative(SRC_ROOT, file).replaceAll('\\', '/')} imports the in-memory ${name} API`,
        );
    });

    expect(offenders).toEqual([]);
  });

  it.each([
    [
      'Projects',
      "import { InMemoryProjectsPageApi } from '@/../test/helpers/in-memory-projects-page-api';",
    ],
    [
      'Projects',
      "import type { InMemoryProjectsPageApi } from '../../../../test/helpers/in-memory-projects-page-api';",
    ],
    [
      'Remote VM',
      "import { InMemoryRemoteVmApi } from '@/../test/helpers/in-memory-remote-vm-api';",
    ],
    [
      'Remote VM',
      "import type { InMemoryRemoteVmApi } from '../../../../test/helpers/in-memory-remote-vm-api';",
    ],
  ] as const)('rejects production imports of the in-memory %s API: %s', (name, source) => {
    expect(importsInMemoryApi(source, PROJECTS_RENDER_PATHS[0], TEST_ONLY_API_PATHS[name])).toBe(
      true,
    );
  });

  it.each(PROJECTS_RENDER_PATHS)(
    'keeps %s free of state, effects, routing, query, transport, orchestration, and storage ownership',
    (file) => {
      expect(renderBoundaryViolations(readText(file), file)).toEqual([]);
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
    expect(renderBoundaryViolations(source)).toContain(violation);
  });

  it('allows presentation contracts and rendered child imports in Projects render files', () => {
    const source = [
      "import type { ProjectsDialogsModel } from './projects-page-presentation';",
      "import { EditProjectDialog } from '@/ui/components/project/EditProjectDialog';",
    ].join('\n');

    expect(renderBoundaryViolations(source)).toEqual([]);
  });

  it('keeps RemoteVmSectionView free of state, effects, routing, query, transport, orchestration, and storage ownership', () => {
    expect(
      renderBoundaryViolations(
        readText(REMOTE_VM_VIEW_PATH),
        REMOTE_VM_VIEW_PATH,
        REMOTE_VM_RENDER_RULES,
      ),
    ).toEqual([]);
  });

  it.each([
    ['router import', "import { useNavigate } from 'react-router-dom';", 'routing'],
    ['TanStack Query import', "import { useMutation } from '@tanstack/react-query';", 'query'],
    [
      'Remote VM HTTP alias',
      "import { remoteVmHttpApi } from '@/ui/pages/cloud/lib/remote-vm-http-api';",
      'remote-vm-api',
    ],
    [
      'Remote VM API relative type import',
      "import type { RemoteVmApi } from './lib/remote-vm-api';",
      'remote-vm-api',
    ],
    [
      'Remote VM API context import',
      "import { useRemoteVmApi } from './lib/remote-vm-api-context';",
      'remote-vm-api',
    ],
    [
      'controller alias',
      "import { useRemoteVmSectionController } from '@/ui/hooks/useRemoteVmSectionController';",
      'orchestration-hook',
    ],
    [
      'remote query hook',
      "import { useRemotes } from '../../hooks/useRemotes';",
      'orchestration-hook',
    ],
    ['transport import', "import { apiFetch } from '@/ui/lib/api-transport';", 'transport'],
    ['direct fetch', "void window.fetch('/api/remotes');", 'fetch'],
    ['local storage', "localStorage.setItem('remotes', 'value');", 'storage'],
    ['session storage', "window.sessionStorage.getItem('remotes');", 'storage'],
    [
      'useState',
      "import { useState } from 'react'; const value = useState(false);",
      'react-state-effect',
    ],
    ['useEffect', 'useEffect(() => undefined, []);', 'react-state-effect'],
  ] as const)('rejects %s ownership in RemoteVmSectionView', (_name, source, violation) => {
    expect(renderBoundaryViolations(source, REMOTE_VM_VIEW_PATH, REMOTE_VM_RENDER_RULES)).toContain(
      violation,
    );
  });

  it('allows presentation contracts and rendered child imports in RemoteVmSectionView', () => {
    const source = [
      "import type { RemoteVmSectionPresentation } from './remote-vm-section-presentation';",
      "import { ConnectDialog } from './ConnectDialog';",
    ].join('\n');

    expect(renderBoundaryViolations(source, REMOTE_VM_VIEW_PATH, REMOTE_VM_RENDER_RULES)).toEqual(
      [],
    );
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

describe('Registry/Projects boundary', () => {
  it('keeps Registry source free of Projects-owned service/module tokens', () => {
    const registryDir = join(MODULES_ROOT, 'registry');
    const forbiddenTokens = [
      'Projects' + 'Service',
      'Projects' + 'Module',
      'Project' + 'TemplateUpgradeService',
      'Project' + 'RegistryImportService',
      'ModuleRef',
    ];
    const offenders = listTypeScriptFiles(registryDir).flatMap((file) => {
      const source = readText(file);
      return forbiddenTokens
        .filter((token) => source.includes(token))
        .map((token) => `${relative(registryDir, file)} contains ${token}`);
    });
    expect(offenders).toEqual([]);
  });
});

describe('Home-to-host contract imports', () => {
  // Source inspection is the cheapest layer that can check every production import without booting apps.
  it('keeps the route contract free of host implementation modules', () => {
    const contractRoot = join(MODULES_ROOT, 'remotes', 'contract');
    const violations = listNonSpecSourceFiles(contractRoot).flatMap((file) =>
      sourceImportSpecifiers(readText(file))
        .filter((specifier) =>
          /\.(?:service|controller|module)(?:\.[cm]?[jt]sx?)?$/.test(specifier),
        )
        .map((specifier) => `${relative(SRC_ROOT, file)} -> ${specifier}`),
    );
    expect(violations).toEqual([]);
  });

  it('keeps the host client on host and file-sync DTO modules only', () => {
    const client = join(MODULES_ROOT, 'remotes', 'operations', 'remote-host.client.ts');
    const violations: string[] = [];
    for (const specifier of sourceImportSpecifiers(readText(client))) {
      const imported = resolveSourceImport(client, specifier);
      if (!imported) continue;
      const sourcePath = relative(MODULES_ROOT, imported).replaceAll('\\', '/');
      if (/^(?:remotes\/host|file-sync)(?:\/|$)/.test(sourcePath) && !sourcePath.endsWith('.dto')) {
        violations.push(`${relative(SRC_ROOT, client)} -> ${specifier}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
