import { dirname, basename, extname, join } from 'path';
import type { FileRole, LanguageAdapter } from '@devchain/codebase-overview';

const JAVA_EXTENSIONS = ['.java'];

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

const IMPORT_RE = /^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;

function extractJavaImports(content: string): string[] {
  const specifiers = new Set<string>();
  IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    specifiers.add(m[1]!);
  }
  return [...specifiers];
}

// ---------------------------------------------------------------------------
// Symbol counting
// ---------------------------------------------------------------------------

const CLASS_DECL_RE = /\b(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/g;
const METHOD_RE =
  /(?:(?:public|protected|private|static|final|abstract|synchronized|native)\s+)*(?:<[\w?,\s]+>\s+)?(?:[\w<>\[\]?,\s]+)\s+([A-Za-z_]\w*)\s*\(/g;
const CONSTANT_RE = /\bstatic\s+final\s+\w+(?:<[^>]+>)?\s+([A-Z_]\w*)\s*=/g;

function countJavaSymbols(content: string): number {
  const symbols = new Set<string>();

  for (const re of [CLASS_DECL_RE, CONSTANT_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) symbols.add(m[1]);
    }
  }

  METHOD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = METHOD_RE.exec(content)) !== null) {
    const name = m[1];
    if (
      name &&
      !['if', 'for', 'while', 'switch', 'return', 'new', 'throw', 'catch', 'try'].includes(name)
    ) {
      symbols.add(name);
    }
  }

  return symbols.size;
}

// ---------------------------------------------------------------------------
// Complexity estimation
// ---------------------------------------------------------------------------

const JAVA_BRANCH_RE = /\b(?:if|else|for|while|do|catch|case|default)\b/g;
const JAVA_LOGICAL_RE = /&&|\|\|/g;
const JAVA_TERNARY_RE = /\?[^:]*:/g;

function computeJavaComplexity(content: string): number {
  if (!content) return 1;
  let complexity = 1;
  complexity += (content.match(JAVA_BRANCH_RE) ?? []).length;
  complexity += (content.match(JAVA_LOGICAL_RE) ?? []).length;
  complexity += (content.match(JAVA_TERNARY_RE) ?? []).length;
  return complexity;
}

// ---------------------------------------------------------------------------
// Test-pair detection
// ---------------------------------------------------------------------------

const JAVA_TEST_SUFFIXES = ['Test', 'Tests', 'IT'];

function detectJavaTestPair(filePath: string, allPaths: Set<string>): string | null {
  const ext = extname(filePath);
  const dir = dirname(filePath);
  const base = basename(filePath, ext);

  for (const suffix of JAVA_TEST_SUFFIXES) {
    if (base.endsWith(suffix) && base.length > suffix.length) {
      const sourceBase = base.slice(0, -suffix.length);
      const sourcePath = join(dir, `${sourceBase}${ext}`);
      if (allPaths.has(sourcePath)) return sourcePath;

      const mainMirror = dir.replace(/(?:^|\/)src\/test\/java(?:\/|$)/, (m) =>
        m.replace('src/test/java', 'src/main/java'),
      );
      if (mainMirror !== dir) {
        const mirrorPath = join(mainMirror, `${sourceBase}${ext}`);
        if (allPaths.has(mirrorPath)) return mirrorPath;
      }

      return null;
    }
  }

  for (const suffix of JAVA_TEST_SUFFIXES) {
    const testPath = join(dir, `${base}${suffix}${ext}`);
    if (allPaths.has(testPath)) return testPath;
  }

  const testMirror = dir.replace(/(?:^|\/)src\/main\/java(?:\/|$)/, (m) =>
    m.replace('src/main/java', 'src/test/java'),
  );
  if (testMirror !== dir) {
    for (const suffix of JAVA_TEST_SUFFIXES) {
      const mirrorPath = join(testMirror, `${base}${suffix}${ext}`);
      if (allPaths.has(mirrorPath)) return mirrorPath;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Role classification
// ---------------------------------------------------------------------------

const JAVA_TEST_FILE_RE = /(?:Test|Tests|IT)\.java$/;
const JAVA_TEST_ANNOTATION_RE = /@(?:Test|ParameterizedTest|RepeatedTest|TestFactory)\b/;
const JAVA_TESTCASE_RE = /\bextends\s+TestCase\b/;
const JAVA_CONTROLLER_RE =
  /@(?:Controller|RestController|RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\b/;
const JAVA_SERVICE_RE = /@Service\b/;
const JAVA_SERVICE_SUFFIX_RE = /\bclass\s+\w*Service\b/;
const JAVA_MODEL_RE = /@(?:Entity|Table|Document|MappedSuperclass)\b/;
const JAVA_CONFIG_RE = /@(?:Configuration|EnableAutoConfiguration|SpringBootApplication)\b/;
const JAVA_CONFIG_FILE_RE = /Config\.java$/;

function classifyJavaRole(filePath: string, content: string): FileRole | null {
  if (
    JAVA_TEST_FILE_RE.test(filePath) ||
    JAVA_TEST_ANNOTATION_RE.test(content) ||
    JAVA_TESTCASE_RE.test(content)
  )
    return 'test';

  if (JAVA_CONTROLLER_RE.test(content)) return 'controller';

  if (JAVA_MODEL_RE.test(content)) return 'model';

  if (JAVA_CONFIG_RE.test(content) || JAVA_CONFIG_FILE_RE.test(filePath)) return 'config';

  if (JAVA_SERVICE_RE.test(content) || JAVA_SERVICE_SUFFIX_RE.test(content)) return 'service';

  return null;
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

const JAVA_STDLIB_PREFIXES = ['java.', 'javax.', 'jakarta.', 'sun.', 'com.sun.', 'jdk.'];

function isJavaStdlib(specifier: string): boolean {
  return JAVA_STDLIB_PREFIXES.some((p) => specifier.startsWith(p));
}

function resolveJavaImport(
  specifier: string,
  importerPath: string,
  allPaths: ReadonlySet<string>,
): string | null {
  if (!specifier) return null;
  if (specifier.endsWith('.*')) return null;
  if (isJavaStdlib(specifier)) return null;

  const segments = specifier.split('.');
  for (let end = segments.length; end >= 1; end--) {
    const pathSuffix = segments.slice(0, end).join('/') + '.java';
    for (const p of allPaths) {
      if (p === pathSuffix || p.endsWith('/' + pathSuffix)) {
        return p;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const javaAdapter: LanguageAdapter = {
  id: 'java',
  extensions: JAVA_EXTENSIONS,

  classifyRole(filePath: string, content: string): FileRole | null {
    return classifyJavaRole(filePath, content);
  },

  extractImports(content: string): string[] {
    return extractJavaImports(content);
  },

  countSymbols(content: string): number {
    return countJavaSymbols(content);
  },

  computeComplexity(content: string): number {
    return computeJavaComplexity(content);
  },

  resolveImport(
    specifier: string,
    importerPath: string,
    allPaths: ReadonlySet<string>,
  ): string | null {
    return resolveJavaImport(specifier, importerPath, allPaths);
  },

  detectTestPair(filePath: string, allPaths: Set<string>): string | null {
    return detectJavaTestPair(filePath, allPaths);
  },
};
