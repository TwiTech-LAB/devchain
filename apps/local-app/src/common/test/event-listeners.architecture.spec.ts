import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { eventNames } from '../../modules/events/catalog';

const SRC_ROOT = resolve(__dirname, '../..');
const CATALOG_EVENTS: ReadonlySet<string> = new Set(eventNames);
const INTERNAL_SIGNALS = new Set([
  'SESSION_TURN_HOOK_SIGNAL',
  'SESSION_TRANSCRIPT_TURN_SIGNAL',
  'RUNTIME_CONTEXT_CAPTURE_TUPLE_CHANGED_EVENT',
  'WORKSPACE_MODE_CHANGED_EVENT',
  'PAIRED_DEVICE_WORKSPACE_ACCESS_REVOKED_EVENT',
  'PROJECT_WORKSPACE_CHANGED_EVENT',
]);

// Activity bypasses event-log writes; settings validates before emit; project deletion supports a missing publisher.
const RETAINED_CATALOG_EMITS = [
  'modules/terminal/services/terminal-activity.service.ts:markBusy:emit:session.activity.changed',
  'modules/terminal/services/terminal-activity.service.ts:transitionToIdle:emit:session.activity.changed',
  'modules/settings/local/delegates/core-settings.delegate.ts:updateSettings:emit:settings.terminal.changed',
  'modules/projects/services/projects.service.ts:deleteProject:emit:epic.relations.invalidated',
].sort();

type Source = { path: string; source: string };
type Audit = {
  violations: string[];
  retainedEmits: string[];
  broadcastEnvelopes: string[];
};

function productionSources(dir: string): Source[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        file === join(SRC_ROOT, 'common/test') ||
        entry.name === '__test-utils__' ||
        entry.name === '__fixtures__'
      ) {
        return [];
      }
      return productionSources(file);
    }
    if (!/\.tsx?$/.test(entry.name) || /\.(?:spec|test)\.tsx?$/.test(entry.name)) return [];
    return [
      { path: relative(SRC_ROOT, file).replace(/\\/g, '/'), source: readFileSync(file, 'utf8') },
    ];
  });
}

const COMPILER_OPTIONS = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(SRC_ROOT, '../tsconfig.json'), ts.sys.readFile).config,
  ts.sys,
  resolve(SRC_ROOT, '..'),
).options;

function auditSources(sources: readonly Source[]): Audit {
  const virtualSources = new Map(
    sources.map((source) => [join(SRC_ROOT, source.path), source.source]),
  );
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = virtualSources.get(file);
    return source === undefined
      ? readSource(file, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(file, source, languageVersion, true);
  };
  const program = ts.createProgram([...virtualSources.keys()], COMPILER_OPTIONS, host);
  const checker = program.getTypeChecker();
  const audit: Audit = { violations: [], retainedEmits: [], broadcastEnvelopes: [] };

  function resolvedSymbol(expression: ts.Expression): ts.Symbol | undefined {
    const symbol = checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(expression) ? expression.name : expression,
    );
    if (!symbol) return undefined;
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  }

  function symbolName(expression: ts.Expression): string | undefined {
    return resolvedSymbol(expression)?.getName();
  }

  function literalName(
    expression: ts.Expression,
    visited: ReadonlySet<ts.Symbol> = new Set(),
  ): string | undefined {
    const type = checker.getTypeAtLocation(expression);
    if (type.isStringLiteral()) return type.value;
    const symbol = resolvedSymbol(expression);
    if (!symbol || visited.has(symbol)) return undefined;
    const declaration = symbol.valueDeclaration;
    if (
      declaration &&
      (ts.isPropertyAssignment(declaration) ||
        (ts.isVariableDeclaration(declaration) &&
          ts.isVariableDeclarationList(declaration.parent) &&
          (declaration.parent.flags & ts.NodeFlags.Const) !== 0)) &&
      declaration.initializer
    ) {
      return literalName(declaration.initializer, new Set([...visited, symbol]));
    }
    return undefined;
  }

  function memberName(node: ts.Node): string {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent)) {
        return parent.name?.getText() ?? '<anonymous>';
      }
    }
    return '<module>';
  }

  for (const input of sources) {
    if (input.path.startsWith('modules/events/catalog/')) continue;
    const source = program.getSourceFile(join(SRC_ROOT, input.path));
    if (!source) throw new Error(`Source missing from event audit: ${input.path}`);
    const inspect = (node: ts.Node): void => {
      if (ts.isDecorator(node) && ts.isCallExpression(node.expression)) {
        const call = node.expression;
        if (symbolName(call.expression) === 'OnEvent') {
          const argument = call.arguments[0];
          const event = argument ? literalName(argument) : undefined;
          const site = `${input.path}:${memberName(node)}:${event ?? '<unresolved>'}`;
          if (event && CATALOG_EVENTS.has(event)) {
            audit.violations.push(`Raw catalog listener: ${site}`);
          } else if (!argument || !INTERNAL_SIGNALS.has(symbolName(argument) ?? '')) {
            audit.violations.push(`Unclassified raw listener: ${site}`);
          }
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if ((method === 'emit' || method === 'emitAsync') && node.arguments[0]) {
          const event = literalName(node.arguments[0]);
          const site = `${input.path}:${memberName(node)}:${method}:${event}`;
          if (event === 'epic.broadcast') {
            audit.broadcastEnvelopes.push(site);
          } else if (event && CATALOG_EVENTS.has(event)) {
            if (RETAINED_CATALOG_EMITS.includes(site)) audit.retainedEmits.push(site);
            else audit.violations.push(`Raw catalog emit: ${site}`);
          }
        }
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  for (const sites of Object.values(audit)) sites.sort();
  return audit;
}

const eventForms = [
  { name: 'literal', declarations: '', expression: "'session.started'" },
  {
    name: 'constant',
    declarations: "const EVENT: string = 'session.started';",
    expression: 'EVENT',
  },
  {
    name: 'member',
    declarations:
      "import { sessionStartedEvent as event } from '../events/catalog/session.started';",
    expression: 'event.name',
  },
  {
    name: 'widened-member',
    declarations: "const event = { name: 'session.started' };",
    expression: 'event.name',
  },
];
const fixtures: Source[] = eventForms.flatMap((form) => [
  {
    path: `modules/event-guard-fixtures/${form.name}-listener.ts`,
    source: `import { OnEvent as RawListener } from '@nestjs/event-emitter';
      ${form.declarations}
      class Listener { @RawListener(${form.expression}) handle() {} }`,
  },
  ...['emit', 'emitAsync'].map((method) => ({
    path: `modules/event-guard-fixtures/${form.name}-${method}.ts`,
    source: `import { EventEmitter2 } from '@nestjs/event-emitter';
      ${form.declarations}
      class Sender { send(emitter: EventEmitter2) { emitter.${method}(${form.expression}, {}); } }`,
  })),
]);

// Compiler-backed source checks are the cheapest layer for resolved decorator/dispatch boundaries.
describe('Catalog listener and raw dispatch boundaries', () => {
  let production: Audit;
  let regressions: Audit;
  beforeAll(() => {
    production = auditSources(productionSources(SRC_ROOT));
    regressions = auditSources(fixtures);
  });

  it('uses typed catalog decorators with only the exact retained emits', () => {
    expect(production.violations).toEqual([]);
    expect(production.retainedEmits).toEqual(RETAINED_CATALOG_EMITS);
    expect(production.broadcastEnvelopes).toContain(
      'modules/epics/services/epics.service.ts:emitBroadcast:emit:epic.broadcast',
    );
  });

  it.each(eventForms)('rejects new raw catalog listeners and dispatches named by $name', (form) => {
    expect(regressions.violations.filter((site) => site.includes(`/${form.name}-`))).toEqual(
      [
        `Raw catalog emit: modules/event-guard-fixtures/${form.name}-emit.ts:send:emit:session.started`,
        `Raw catalog emit: modules/event-guard-fixtures/${form.name}-emitAsync.ts:send:emitAsync:session.started`,
        `Raw catalog listener: modules/event-guard-fixtures/${form.name}-listener.ts:handle:session.started`,
      ].sort(),
    );
  });
});
