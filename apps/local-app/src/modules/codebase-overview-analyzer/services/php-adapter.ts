import { extname, dirname, basename, join, normalize } from 'path';
import type { FileRole, LanguageAdapter } from '@devchain/codebase-overview';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PHP_EXTENSIONS = ['.php', '.phtml'];

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

/** Grouped use: use Foo\{Bar, Baz}; — expands to flat list */
const PHP_USE_GROUPED_RE = /^[ \t]*use\s+(?!function\b|const\b)([\w\\]+)\s*\{([^}]+)\}\s*;/gm;

/** use function Foo\bar; / use const Foo\BAR; */
const PHP_USE_FUNC_CONST_RE = /^[ \t]*use\s+(?:function|const)\s+([\w\\]+)\s*(?:as\s+\w+\s*)?;/gm;

/**
 * Regular use: use Foo\Bar; or use Foo\Bar as Baz;
 * Line-start anchor prevents false matches from closure captures: function () use ($x)
 */
const PHP_USE_RE = /^[ \t]*use\s+(?!function\b|const\b)([\w\\]+)\s*(?:as\s+\w+\s*)?;/gm;

/** require/require_once/include/include_once with literal string path */
const PHP_REQUIRE_RE = /\b(?:require_once|require|include_once|include)\s+['"]([^'"]+)['"]/g;

function extractPhpImports(content: string): string[] {
  const specifiers = new Set<string>();
  let match: RegExpExecArray | null;

  // Grouped use — expand: use Foo\{Bar, Baz} → Foo\Bar, Foo\Baz
  PHP_USE_GROUPED_RE.lastIndex = 0;
  while ((match = PHP_USE_GROUPED_RE.exec(content)) !== null) {
    const prefix = match[1].replace(/\\+$/, '');
    const members = match[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const member of members) {
      const name = member.split(/\s+as\s+/i)[0].trim();
      if (name) specifiers.add(`${prefix}\\${name}`);
    }
  }

  // use function / use const
  PHP_USE_FUNC_CONST_RE.lastIndex = 0;
  while ((match = PHP_USE_FUNC_CONST_RE.exec(content)) !== null) {
    if (match[1]) specifiers.add(match[1]);
  }

  // Regular use (negative lookahead excludes function/const variants)
  PHP_USE_RE.lastIndex = 0;
  while ((match = PHP_USE_RE.exec(content)) !== null) {
    if (match[1]) specifiers.add(match[1]);
  }

  // require/include literal paths
  PHP_REQUIRE_RE.lastIndex = 0;
  while ((match = PHP_REQUIRE_RE.exec(content)) !== null) {
    if (match[1]) specifiers.add(match[1]);
  }

  return [...specifiers];
}

// ---------------------------------------------------------------------------
// Symbol counting
// ---------------------------------------------------------------------------

/** Named functions — anonymous closures (function () {}) do not match */
const PHP_NAMED_FUNC_RE = /\bfunction\s+\w+/g;
/** class, interface, trait, enum declarations */
const PHP_CLASS_LIKE_RE = /\b(?:class|interface|trait|enum)\s+\w+/g;
/** const declarations (file-level or class-level) */
const PHP_CONST_RE = /\bconst\s+\w+/g;

function countPhpSymbols(content: string): number {
  if (!content) return 0;
  const funcCount = (content.match(PHP_NAMED_FUNC_RE) ?? []).length;
  const classCount = (content.match(PHP_CLASS_LIKE_RE) ?? []).length;
  const constCount = (content.match(PHP_CONST_RE) ?? []).length;
  return funcCount + classCount + constCount;
}

// ---------------------------------------------------------------------------
// Complexity estimation
// ---------------------------------------------------------------------------

/** Branching keywords: conditionals, loops, PHP 8 match, error handling */
const PHP_BRANCH_RE = /\b(?:if|elseif|for|foreach|while|do|match|catch)\b/g;
/** switch case labels */
const PHP_CASE_RE = /\bcase\b/g;
/** Short-circuit logical operators */
const PHP_LOGICAL_RE = /&&|\|\|/g;
/** Ternary ? — excludes ?? (null-coalescing) via lookahead/lookbehind */
const PHP_TERNARY_RE = /(?<!\?)\?(?!\?)/g;
/** Null-coalescing ?? */
const PHP_NULL_COAL_RE = /\?\?/g;

function computePhpComplexity(content: string): number {
  if (!content) return 1;
  let complexity = 1;
  complexity += (content.match(PHP_BRANCH_RE) ?? []).length;
  complexity += (content.match(PHP_CASE_RE) ?? []).length;
  complexity += (content.match(PHP_LOGICAL_RE) ?? []).length;
  complexity += (content.match(PHP_TERNARY_RE) ?? []).length;
  complexity += (content.match(PHP_NULL_COAL_RE) ?? []).length;
  return complexity;
}

// ---------------------------------------------------------------------------
// Test-pair detection
// ---------------------------------------------------------------------------

/**
 * PHPUnit conventions:
 * - FooTest.php ↔ Foo.php (co-located or via tests/ sibling directory)
 */
function detectPhpTestPair(filePath: string, allPaths: Set<string>): string | null {
  const ext = extname(filePath);
  const dir = dirname(filePath);
  const base = basename(filePath, ext);

  if (base.endsWith('Test')) {
    const sourceBase = base.slice(0, -4);

    // Co-located
    const sameDirSource = join(dir, sourceBase + ext);
    if (allPaths.has(sameDirSource)) return sameDirSource;

    // tests/ → source in parent directory
    const parentDir = dirname(dir);
    const parentSource = join(parentDir, sourceBase + ext);
    if (allPaths.has(parentSource)) return parentSource;

    // tests/ → source in sibling src/ directory
    const srcSibling = join(parentDir, 'src', sourceBase + ext);
    if (allPaths.has(srcSibling)) return srcSibling;

    return null;
  }

  // Source file — find its test
  const sameDir = join(dir, base + 'Test' + ext);
  if (allPaths.has(sameDir)) return sameDir;

  const testsSubdir = join(dir, 'tests', base + 'Test' + ext);
  if (allPaths.has(testsSubdir)) return testsSubdir;

  const siblingTests = join(dirname(dir), 'tests', base + 'Test' + ext);
  if (allPaths.has(siblingTests)) return siblingTests;

  return null;
}

// ---------------------------------------------------------------------------
// Role classification
// ---------------------------------------------------------------------------

const PHP_TEST_CASE_RE = /\bextends\s+\w*TestCase\b/;
const PHP_TESTS_NS_RE = /\bnamespace\s+[\w\\]*Tests\b/;
const PHP_CONTROLLER_EXTENDS_RE = /\bextends\s+\w*Controller\b/;
const PHP_CONTROLLER_IF_RE = /\bimplements\s+(?:\w+,\s*)*ControllerInterface\b/;
const PHP_HTTP_CONTROLLERS_NS_RE = /\bnamespace\s+[\w\\]*Http\\Controllers\b/;
const PHP_SERVICE_CLASS_RE = /\bclass\s+\w+Service\b/;
const PHP_EXTENDS_MODEL_RE = /\bextends\s+\w*Model\b/;
/** Doctrine entity: attribute or PHPDoc annotation; import alone is insufficient */
const PHP_DOCTRINE_ENTITY_RE = /#\[(?:ORM\\)?Entity(?:\([^)]*\))?\]|@ORM\\Entity\b|@Entity\b/;

function classifyPhpRole(filePath: string, content: string): FileRole {
  const ext = extname(filePath);

  if (ext === '.phtml' || filePath.includes('/templates/')) return 'view';
  if (PHP_TEST_CASE_RE.test(content) || PHP_TESTS_NS_RE.test(content)) return 'test';
  if (
    PHP_CONTROLLER_EXTENDS_RE.test(content) ||
    PHP_CONTROLLER_IF_RE.test(content) ||
    PHP_HTTP_CONTROLLERS_NS_RE.test(content)
  )
    return 'controller';
  if (PHP_SERVICE_CLASS_RE.test(content)) return 'service';
  if (PHP_EXTENDS_MODEL_RE.test(content) || PHP_DOCTRINE_ENTITY_RE.test(content)) return 'model';
  if (/(?:^|\/)config\//.test(filePath)) return 'config';
  return 'utility';
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a PHP import specifier to a project file path.
 *
 * Handles:
 * - Relative paths (require/include): `./foo.php`, `../bar.php` — resolved from importer dir
 * - PSR-4 namespaces: `Foo\Bar\Baz` → suffix-match allPaths for `/Foo/Bar/Baz.php`
 * - PSR-0 fallback: underscores in class name → path separators
 */
function resolvePhpImport(
  specifier: string,
  importerPath: string,
  allPaths: ReadonlySet<string>,
): string | null {
  if (!specifier) return null;

  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const resolved = normalize(join(dirname(importerPath), specifier));
    return allPaths.has(resolved) ? resolved : null;
  }

  // PSR-4: backslash namespace → forward-slash path, suffix-match
  const namespacePath = specifier.replace(/\\/g, '/').replace(/^\//, '');

  for (const candidate of allPaths) {
    if (
      candidate.endsWith('/' + namespacePath + '.php') ||
      candidate === namespacePath + '.php' ||
      candidate.endsWith('/' + namespacePath + '.phtml') ||
      candidate === namespacePath + '.phtml'
    ) {
      return candidate;
    }
  }

  // PSR-0 fallback: underscores in class name map to subdirectories
  const psr0Path = namespacePath.replace(/_/g, '/');
  if (psr0Path !== namespacePath) {
    for (const candidate of allPaths) {
      if (candidate.endsWith('/' + psr0Path + '.php') || candidate === psr0Path + '.php') {
        return candidate;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const phpAdapter: LanguageAdapter = {
  id: 'php',
  extensions: PHP_EXTENSIONS,

  classifyRole(filePath: string, content: string): FileRole {
    return classifyPhpRole(filePath, content);
  },

  extractImports(content: string): string[] {
    return extractPhpImports(content);
  },

  countSymbols(content: string): number {
    return countPhpSymbols(content);
  },

  computeComplexity(content: string): number {
    return computePhpComplexity(content);
  },

  resolveImport(
    specifier: string,
    importerPath: string,
    allPaths: ReadonlySet<string>,
  ): string | null {
    return resolvePhpImport(specifier, importerPath, allPaths);
  },

  detectTestPair(filePath: string, allPaths: Set<string>): string | null {
    return detectPhpTestPair(filePath, allPaths);
  },
};
