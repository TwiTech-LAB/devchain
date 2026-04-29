import { extname, dirname, basename, join, normalize } from 'path';
import type { FileRole, LanguageAdapter } from '@devchain/codebase-overview';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PYTHON_EXTENSIONS = ['.py', '.pyw'];

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/**
 * Matches `import foo`, `import foo.bar`, `import foo as f`.
 * Also matches `import foo, bar` (multiple imports on one line).
 */
const IMPORT_RE = /^import\s+(\S+)/gm;

/**
 * Matches `from foo import …` and `from . import …` (relative imports).
 * Captures the module path (e.g., `foo.bar`, `.`, `..utils`).
 */
const FROM_IMPORT_RE = /^from\s+(\S+)\s+import\b/gm;

function extractPythonImports(content: string): string[] {
  const specifiers = new Set<string>();

  IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMPORT_RE.exec(content)) !== null) {
    const raw = match[1];
    // Handle `import foo, bar` — take the first module
    const mod = raw.split(',')[0].trim();
    if (mod) specifiers.add(mod);
  }

  FROM_IMPORT_RE.lastIndex = 0;
  while ((match = FROM_IMPORT_RE.exec(content)) !== null) {
    const mod = match[1];
    if (mod) specifiers.add(mod);
  }

  return [...specifiers];
}

// ---------------------------------------------------------------------------
// Symbol counting
// ---------------------------------------------------------------------------

/**
 * Counts top-level public definitions: functions and classes that don't
 * start with underscore. This is a lightweight regex heuristic.
 * Matches lines starting at column 0 (no indentation).
 */
const TOP_LEVEL_DEF_RE = /^(?:def|class)\s+([A-Za-z]\w*)/gm;
const ASYNC_DEF_RE = /^async\s+def\s+([A-Za-z]\w*)/gm;

function countPythonSymbols(content: string): number {
  const symbols = new Set<string>();

  for (const re of [TOP_LEVEL_DEF_RE, ASYNC_DEF_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const name = match[1];
      // Skip private/dunder names (except __init__ which is a class, not standalone)
      if (name && !name.startsWith('_')) {
        symbols.add(name);
      }
    }
  }

  return symbols.size;
}

// ---------------------------------------------------------------------------
// Test-pair detection
// ---------------------------------------------------------------------------

/**
 * Python test naming conventions:
 * - `test_foo.py` → tests `foo.py`
 * - `foo_test.py` → tests `foo.py`
 * - `tests/test_foo.py` → tests `foo.py` in parent dir
 */
function detectPythonTestPair(filePath: string, allPaths: Set<string>): string | null {
  const ext = extname(filePath);
  const dir = dirname(filePath);
  const base = basename(filePath, ext);

  // Check if this file IS a test file — find its source
  if (base.startsWith('test_')) {
    const sourceBase = base.slice(5); // strip "test_"
    const sourcePath = join(dir, `${sourceBase}${ext}`);
    if (allPaths.has(sourcePath)) return sourcePath;

    // Check parent directory (tests in tests/ or test/)
    const parentDir = dirname(dir);
    const parentSourcePath = join(parentDir, `${sourceBase}${ext}`);
    if (allPaths.has(parentSourcePath)) return parentSourcePath;

    return null;
  }

  if (base.endsWith('_test')) {
    const sourceBase = base.slice(0, -5); // strip "_test"
    const sourcePath = join(dir, `${sourceBase}${ext}`);
    if (allPaths.has(sourcePath)) return sourcePath;

    const parentDir = dirname(dir);
    const parentSourcePath = join(parentDir, `${sourceBase}${ext}`);
    if (allPaths.has(parentSourcePath)) return parentSourcePath;

    return null;
  }

  // This file is a source file — find its test
  // Try test_<name>.py in same dir
  const testPrefixPath = join(dir, `test_${base}${ext}`);
  if (allPaths.has(testPrefixPath)) return testPrefixPath;

  // Try <name>_test.py in same dir
  const testSuffixPath = join(dir, `${base}_test${ext}`);
  if (allPaths.has(testSuffixPath)) return testSuffixPath;

  // Try tests/ subdirectory
  const testsSubdirPath = join(dir, 'tests', `test_${base}${ext}`);
  if (allPaths.has(testsSubdirPath)) return testsSubdirPath;

  // Try test/ subdirectory
  const testSubdirPath = join(dir, 'test', `test_${base}${ext}`);
  if (allPaths.has(testSubdirPath)) return testSubdirPath;

  return null;
}

// ---------------------------------------------------------------------------
// Complexity estimation
// ---------------------------------------------------------------------------

/**
 * Lightweight cyclomatic-complexity proxy for Python files.
 * Counts branching constructs: if, elif, for, while, try, except,
 * logical operators (and, or), assert, with.
 * Starts at 1 (baseline for a straight-through path).
 */
const PY_BRANCH_RE = /\b(?:if|elif|for|while|try|except|assert|with)\b/g;
const PY_LOGICAL_RE = /\b(?:and|or)\b/g;

function computePyComplexity(content: string): number {
  if (!content) return 1;
  let complexity = 1;
  complexity += (content.match(PY_BRANCH_RE) ?? []).length;
  complexity += (content.match(PY_LOGICAL_RE) ?? []).length;
  return complexity;
}

// ---------------------------------------------------------------------------
// Role classification (content-aware)
// ---------------------------------------------------------------------------

const PYTEST_RE = /\b(?:pytest|unittest)\b/;
const TEST_FUNC_RE = /^(?:def\s+test_|class\s+Test[A-Z])/m;
const FLASK_ROUTE_RE = /@(?:app|blueprint|bp)\.\s*(?:route|get|post|put|delete|patch)\s*\(/;
const DJANGO_VIEW_RE = /\bclass\s+\w+\(.*(?:View|ViewSet|APIView|ModelViewSet)\s*\)/;
const DJANGO_MODEL_RE = /\bclass\s+\w+\(.*(?:models\.Model|Model)\s*\)/;
const FASTAPI_ROUTE_RE = /@(?:router|app)\.\s*(?:get|post|put|delete|patch)\s*\(/;
const CLI_RE = /\b(?:argparse|click\.command|typer\.Typer|@click\.)/;

function classifyPythonRole(filePath: string, content: string): FileRole | null {
  // Test detection (highest priority)
  if (TEST_FUNC_RE.test(content) || PYTEST_RE.test(content)) return 'test';

  // Web framework controllers/views
  if (FLASK_ROUTE_RE.test(content) || FASTAPI_ROUTE_RE.test(content)) return 'controller';
  if (DJANGO_VIEW_RE.test(content)) return 'view';

  // Models
  if (DJANGO_MODEL_RE.test(content)) return 'model';

  // CLI scripts
  if (CLI_RE.test(content)) return 'script';

  return null;
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

const PY_RESOLVE_EXTENSIONS = ['.py', '.pyw'];

/**
 * Resolve a Python import specifier to a project file path.
 *
 * Handles two forms:
 * - Relative imports (start with `.`): `.utils`, `..models`, `.`
 *   Resolved relative to the importer's directory, one `..` per leading dot
 *   beyond the first.
 * - Absolute imports: `foo.bar.baz`
 *   Converted to `foo/bar/baz` and probed from the project root.
 *
 * For each candidate path, probes:
 * 1. Direct match (if the path already exists in allPaths)
 * 2. `<path>.py`, `<path>.pyw`
 * 3. `<path>/__init__.py`, `<path>/__init__.pyw`
 */
function resolvePythonImport(
  specifier: string,
  importerPath: string,
  allPaths: ReadonlySet<string>,
): string | null {
  if (!specifier) return null;

  let modulePath: string;

  if (specifier.startsWith('.')) {
    // Relative import: count leading dots
    let dots = 0;
    while (dots < specifier.length && specifier[dots] === '.') dots++;
    const remainder = specifier.slice(dots);

    // First dot = current package dir, each additional dot = one parent
    let base = dirname(importerPath);
    for (let i = 1; i < dots; i++) {
      base = dirname(base);
    }

    if (!remainder) {
      // `from . import foo` — points to the package itself (__init__.py)
      modulePath = base;
    } else {
      modulePath = normalize(join(base, remainder.replace(/\./g, '/')));
    }
  } else {
    // Absolute import: convert dots to path separators
    modulePath = specifier.replace(/\./g, '/');
  }

  // Probe: direct match
  if (allPaths.has(modulePath)) return modulePath;

  // Probe: append extensions
  for (const ext of PY_RESOLVE_EXTENSIONS) {
    if (allPaths.has(modulePath + ext)) return modulePath + ext;
  }

  // Probe: __init__ files (package directory)
  for (const ext of PY_RESOLVE_EXTENSIONS) {
    const initPath = join(modulePath, '__init__' + ext);
    if (allPaths.has(initPath)) return initPath;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const pythonAdapter: LanguageAdapter = {
  id: 'python',
  extensions: PYTHON_EXTENSIONS,

  classifyRole(filePath: string, content: string): FileRole | null {
    return classifyPythonRole(filePath, content);
  },

  extractImports(content: string): string[] {
    return extractPythonImports(content);
  },

  countSymbols(content: string): number {
    return countPythonSymbols(content);
  },

  computeComplexity(content: string): number {
    return computePyComplexity(content);
  },

  resolveImport(
    specifier: string,
    importerPath: string,
    allPaths: ReadonlySet<string>,
  ): string | null {
    return resolvePythonImport(specifier, importerPath, allPaths);
  },

  detectTestPair(filePath: string, allPaths: Set<string>): string | null {
    return detectPythonTestPair(filePath, allPaths);
  },
};
