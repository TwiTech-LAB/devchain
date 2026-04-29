import { extname, dirname, basename, join } from 'path';
import type { FileRole, LanguageAdapter } from '@devchain/codebase-overview';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TS_JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Matches ES module `import … from '…'` and `import '…'` statements,
 * plus dynamic `import('…')` calls.
 */
const ES_IMPORT_RE = /(?:^|\n)\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Matches CommonJS `require('…')` calls.
 */
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Matches re-export statements: `export … from '…'`
 */
const REEXPORT_RE = /(?:^|\n)\s*export\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g;

function extractImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();

  for (const re of [ES_IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE, REEXPORT_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const specifier = match[1];
      if (specifier) specifiers.add(specifier);
    }
  }

  return [...specifiers];
}

// ---------------------------------------------------------------------------
// Symbol counting
// ---------------------------------------------------------------------------

/**
 * Counts exported declarations: functions, classes, interfaces, types,
 * enums, and const/let/var. This is a lightweight regex heuristic,
 * not a full AST parse.
 */
const EXPORTED_SYMBOL_RE =
  /^export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?\s+\w|class\s+\w|interface\s+\w|type\s+\w|enum\s+\w|const\s+\w|let\s+\w|var\s+\w)/gm;

function countExportedSymbols(content: string): number {
  EXPORTED_SYMBOL_RE.lastIndex = 0;
  let count = 0;
  while (EXPORTED_SYMBOL_RE.exec(content) !== null) count++;
  return count;
}

// ---------------------------------------------------------------------------
// Test-pair detection
// ---------------------------------------------------------------------------

const TEST_SUFFIXES = ['.test', '.spec', '_test', '-spec'];

function detectTestPairPath(filePath: string, allPaths: Set<string>): string | null {
  const ext = extname(filePath);
  const dir = dirname(filePath);
  const base = basename(filePath, ext);

  // Check if this file IS a test file — find its source
  for (const suffix of TEST_SUFFIXES) {
    if (base.endsWith(suffix)) {
      const sourceBase = base.slice(0, -suffix.length);
      const sourcePath = join(dir, `${sourceBase}${ext}`);
      if (allPaths.has(sourcePath)) return sourcePath;

      // Check parent directory (tests in __tests__/ or tests/)
      const parentDir = dirname(dir);
      const parentSourcePath = join(parentDir, `${sourceBase}${ext}`);
      if (allPaths.has(parentSourcePath)) return parentSourcePath;

      return null;
    }
  }

  // This file is a source file — find its test
  for (const suffix of TEST_SUFFIXES) {
    const testPath = join(dir, `${base}${suffix}${ext}`);
    if (allPaths.has(testPath)) return testPath;
  }

  // Check __tests__ subdirectory
  for (const suffix of TEST_SUFFIXES) {
    const testPath = join(dir, '__tests__', `${base}${suffix}${ext}`);
    if (allPaths.has(testPath)) return testPath;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Complexity estimation
// ---------------------------------------------------------------------------

/**
 * Lightweight cyclomatic-complexity proxy for TS/JS files.
 * Counts branching constructs: if, else if, for, while, do, switch, case,
 * catch, ternary (?), logical operators (&&, ||, ??).
 * Starts at 1 (baseline for a straight-through path).
 */
const BRANCH_KEYWORD_RE = /\b(?:if|else\s+if|for|while|do|switch|case|catch)\s*\(/g;
const TERNARY_RE = /[^?]\?[^?.:]/g;
const LOGICAL_OP_RE = /&&|\|\||\?\?/g;

function computeTsComplexity(content: string): number {
  if (!content) return 1;
  let complexity = 1;
  complexity += (content.match(BRANCH_KEYWORD_RE) ?? []).length;
  complexity += (content.match(TERNARY_RE) ?? []).length;
  complexity += (content.match(LOGICAL_OP_RE) ?? []).length;
  return complexity;
}

// ---------------------------------------------------------------------------
// Role classification (content-aware)
// ---------------------------------------------------------------------------

const TEST_FRAMEWORK_RE =
  /\b(?:describe|it|test|expect|jest|vitest|mocha|chai|beforeEach|afterEach|beforeAll|afterAll)\s*\(/;
const REACT_COMPONENT_RE = /\b(?:React\.createElement|jsx|tsx)\b|<[A-Za-z]\w*[\s/>]/;
const CONTROLLER_DECORATOR_RE = /@Controller\s*\(/;
const INJECTABLE_SERVICE_RE = /@Injectable\s*\(/;

function classifyRoleFromContent(filePath: string, content: string): FileRole | null {
  // Test detection via content (catches files without test/spec in name)
  if (TEST_FRAMEWORK_RE.test(content)) return 'test';

  const ext = extname(filePath).toLowerCase();

  // TSX/JSX with React component patterns → view
  if ((ext === '.tsx' || ext === '.jsx') && REACT_COMPONENT_RE.test(content)) return 'view';

  // NestJS decorators
  if (CONTROLLER_DECORATOR_RE.test(content)) return 'controller';
  if (INJECTABLE_SERVICE_RE.test(content)) return 'service';

  // Return null to fall back to path-based classification
  return null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const typescriptAdapter: LanguageAdapter = {
  id: 'typescript',
  extensions: TS_JS_EXTENSIONS,

  classifyRole(filePath: string, content: string): FileRole | null {
    return classifyRoleFromContent(filePath, content);
  },

  extractImports(content: string): string[] {
    return extractImportSpecifiers(content);
  },

  countSymbols(content: string): number {
    return countExportedSymbols(content);
  },

  computeComplexity(content: string): number {
    return computeTsComplexity(content);
  },

  detectTestPair(filePath: string, allPaths: Set<string>): string | null {
    return detectTestPairPath(filePath, allPaths);
  },
};
