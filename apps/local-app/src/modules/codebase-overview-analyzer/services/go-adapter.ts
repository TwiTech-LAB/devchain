import { dirname, basename, extname, join } from 'path';
import type { FileRole, LanguageAdapter } from '@devchain/codebase-overview';

const GO_EXTENSIONS = ['.go'];

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

const IMPORT_BLOCK_RE = /import\s*\(\s*([\s\S]*?)\)/g;
const IMPORT_SINGLE_RE = /^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm;
const IMPORT_LINE_RE = /(?:[\w.]+\s+)?"([^"]+)"/g;

function extractGoImports(content: string): string[] {
  const specifiers = new Set<string>();

  IMPORT_BLOCK_RE.lastIndex = 0;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = IMPORT_BLOCK_RE.exec(content)) !== null) {
    const block = blockMatch[1]!;
    IMPORT_LINE_RE.lastIndex = 0;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = IMPORT_LINE_RE.exec(block)) !== null) {
      if (lineMatch[1]) specifiers.add(lineMatch[1]);
    }
  }

  IMPORT_SINGLE_RE.lastIndex = 0;
  let singleMatch: RegExpExecArray | null;
  while ((singleMatch = IMPORT_SINGLE_RE.exec(content)) !== null) {
    if (singleMatch[1]) specifiers.add(singleMatch[1]);
  }

  return [...specifiers];
}

// ---------------------------------------------------------------------------
// Symbol counting
// ---------------------------------------------------------------------------

const FUNC_RE = /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/gm;
const TYPE_DECL_RE = /^type\s+([A-Za-z_]\w*)\s+/gm;
const TYPE_BLOCK_RE = /^type\s*\(\s*([\s\S]*?)\)/gm;
const VAR_CONST_BLOCK_RE = /^(?:var|const)\s*\(\s*([\s\S]*?)\)/gm;
const VAR_CONST_SINGLE_RE = /^(?:var|const)\s+([A-Za-z_]\w*)/gm;
const BLOCK_NAME_RE = /^\s*([A-Za-z_]\w*)\s+/gm;

function countGoSymbols(content: string): number {
  const symbols = new Set<string>();

  for (const re of [FUNC_RE, TYPE_DECL_RE, VAR_CONST_SINGLE_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) symbols.add(m[1]);
    }
  }

  for (const blockRe of [TYPE_BLOCK_RE, VAR_CONST_BLOCK_RE]) {
    blockRe.lastIndex = 0;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = blockRe.exec(content)) !== null) {
      const block = blockMatch[1]!;
      BLOCK_NAME_RE.lastIndex = 0;
      let nameMatch: RegExpExecArray | null;
      while ((nameMatch = BLOCK_NAME_RE.exec(block)) !== null) {
        if (nameMatch[1] && nameMatch[1] !== '//' && nameMatch[1] !== '/*') {
          symbols.add(nameMatch[1]);
        }
      }
    }
  }

  return symbols.size;
}

// ---------------------------------------------------------------------------
// Complexity estimation
// ---------------------------------------------------------------------------

const GO_BRANCH_RE = /\b(?:if|else|for|case|default)\b/g;
const GO_LOGICAL_RE = /&&|\|\|/g;

function computeGoComplexity(content: string): number {
  if (!content) return 1;
  let complexity = 1;
  complexity += (content.match(GO_BRANCH_RE) ?? []).length;
  complexity += (content.match(GO_LOGICAL_RE) ?? []).length;
  return complexity;
}

// ---------------------------------------------------------------------------
// Test-pair detection
// ---------------------------------------------------------------------------

function detectGoTestPair(filePath: string, allPaths: Set<string>): string | null {
  const ext = extname(filePath);
  const dir = dirname(filePath);
  const base = basename(filePath, ext);

  if (base.endsWith('_test')) {
    const sourceBase = base.slice(0, -5);
    const sourcePath = join(dir, `${sourceBase}${ext}`);
    if (allPaths.has(sourcePath)) return sourcePath;
    return null;
  }

  const testPath = join(dir, `${base}_test${ext}`);
  if (allPaths.has(testPath)) return testPath;
  return null;
}

// ---------------------------------------------------------------------------
// Role classification
// ---------------------------------------------------------------------------

const GO_TEST_RE = /^func\s+Test[A-Z]/m;
const GO_HANDLER_RE =
  /func\s+\(\s*\w+\s+\*?\w*(?:Handler|Server|Controller)\s*\)\s+(?:ServeHTTP|Handle)/;
const GO_HTTP_FRAMEWORK_RE =
  /\b(?:gin\.Context|echo\.Context|chi\.Router|mux\.Router|fiber\.Ctx)\b/;
const GO_HTTP_HANDLER_FUNC_RE =
  /\bfunc\s+\w+\s*\(\s*\w+\s+http\.ResponseWriter\s*,\s*\w+\s+\*http\.Request\s*\)/;
const GO_MODEL_RE = /\b(?:gorm\.Model|sqlx\b|`db:"|`json:.*`\s*$)/m;
const GO_STRUCT_DB_TAG_RE = /`(?:db|gorm|bson):/;
const GO_CONFIG_RE = /\b(?:viper\.|envconfig\.|godotenv\.)/;
const GO_SERVICE_RE = /(?:Service|Svc)\b/;

function classifyGoRole(filePath: string, content: string): FileRole | null {
  const base = basename(filePath);
  if (base.endsWith('_test.go')) return 'test';
  if (GO_TEST_RE.test(content)) return 'test';

  if (
    GO_HANDLER_RE.test(content) ||
    GO_HTTP_FRAMEWORK_RE.test(content) ||
    GO_HTTP_HANDLER_FUNC_RE.test(content)
  )
    return 'controller';

  if (GO_STRUCT_DB_TAG_RE.test(content) || GO_MODEL_RE.test(content)) return 'model';

  if (base === 'config.go' || GO_CONFIG_RE.test(content)) return 'config';

  if (GO_SERVICE_RE.test(content)) return 'service';

  return null;
}

// ---------------------------------------------------------------------------
// Import resolution — pure suffix heuristic
// ---------------------------------------------------------------------------

function isStdlib(specifier: string): boolean {
  const firstSegment = specifier.split('/')[0]!;
  return !firstSegment.includes('.');
}

function resolveGoImport(
  specifier: string,
  importerPath: string,
  allPaths: ReadonlySet<string>,
): string | null {
  if (!specifier) return null;
  if (isStdlib(specifier)) return null;

  const segments = specifier.split('/');
  for (let start = 1; start < segments.length; start++) {
    const suffix = segments.slice(start).join('/');
    const candidates: string[] = [];

    for (const p of allPaths) {
      if (!p.endsWith('.go')) continue;
      const pDir = dirname(p);
      if (pDir === suffix || pDir.endsWith('/' + suffix)) {
        candidates.push(p);
      }
    }

    if (candidates.length === 0) continue;

    const dirs = new Set(candidates.map((c) => dirname(c)));
    if (dirs.size === 1) return candidates[0]!;

    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const goAdapter: LanguageAdapter = {
  id: 'go',
  extensions: GO_EXTENSIONS,

  classifyRole(filePath: string, content: string): FileRole | null {
    return classifyGoRole(filePath, content);
  },

  extractImports(content: string): string[] {
    return extractGoImports(content);
  },

  countSymbols(content: string): number {
    return countGoSymbols(content);
  },

  computeComplexity(content: string): number {
    return computeGoComplexity(content);
  },

  resolveImport(
    specifier: string,
    importerPath: string,
    allPaths: ReadonlySet<string>,
  ): string | null {
    return resolveGoImport(specifier, importerPath, allPaths);
  },

  detectTestPair(filePath: string, allPaths: Set<string>): string | null {
    return detectGoTestPair(filePath, allPaths);
  },
};
