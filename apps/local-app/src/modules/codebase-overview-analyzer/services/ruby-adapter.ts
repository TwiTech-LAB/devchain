import { extname, dirname, basename, join, normalize } from 'path';
import type { FileRole, LanguageAdapter } from '@devchain/codebase-overview';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUBY_EXTENSIONS = ['.rb'];

// ---------------------------------------------------------------------------
// Import extraction
// ---------------------------------------------------------------------------

const REQUIRE_RE = /^\s*require\s+['"]([^'"]+)['"]/gm;
const REQUIRE_RELATIVE_RE = /^\s*require_relative\s+['"]([^'"]+)['"]/gm;
const LOAD_RE = /^\s*load\s+['"]([^'"]+)['"]/gm;
const AUTOLOAD_RE = /^\s*autoload\s+:\w+,\s+['"]([^'"]+)['"]/gm;

function extractRubyImports(content: string): string[] {
  const specifiers = new Set<string>();

  for (const re of [REQUIRE_RE, REQUIRE_RELATIVE_RE, LOAD_RE, AUTOLOAD_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const spec = match[1];
      if (spec) specifiers.add(spec);
    }
  }

  return [...specifiers];
}

// ---------------------------------------------------------------------------
// Symbol counting
// ---------------------------------------------------------------------------

// Counts class, module, and def (instance + self.) at any indentation
const CLASS_MODULE_RE = /^\s*(?:class|module)\s+\w/gm;
const DEF_RE = /^\s*def\s+(?:self\.)?\w/gm;

function countRubySymbols(content: string): number {
  let count = 0;

  CLASS_MODULE_RE.lastIndex = 0;
  while (CLASS_MODULE_RE.exec(content) !== null) {
    count++;
  }

  DEF_RE.lastIndex = 0;
  while (DEF_RE.exec(content) !== null) {
    count++;
  }

  return count;
}

// ---------------------------------------------------------------------------
// Complexity estimation
// ---------------------------------------------------------------------------

const RB_BRANCH_RE = /\b(?:if|elsif|unless|while|until|for|case|when|rescue)\b/g;
const RB_LOGICAL_RE = /&&|\|\|/g;
// ternary: " ? " surrounded by whitespace (avoids predicate methods like empty?)
const RB_TERNARY_RE = /\s\?\s/g;

function computeRubyComplexity(content: string): number {
  if (!content) return 1;
  let complexity = 1;
  complexity += (content.match(RB_BRANCH_RE) ?? []).length;
  complexity += (content.match(RB_LOGICAL_RE) ?? []).length;
  complexity += (content.match(RB_TERNARY_RE) ?? []).length;
  return complexity;
}

// ---------------------------------------------------------------------------
// Test-pair detection
// ---------------------------------------------------------------------------

function detectRubyTestPair(filePath: string, allPaths: Set<string>): string | null {
  const ext = extname(filePath); // '.rb'
  const base = basename(filePath, ext);

  // Is this an RSpec file? (*_spec.rb)
  if (base.endsWith('_spec')) {
    const sourceBase = base.slice(0, -5);
    for (const p of allPaths) {
      if (p.endsWith(`/${sourceBase}.rb`) || p === `${sourceBase}.rb`) return p;
    }
    return null;
  }

  // Is this a Minitest file? (test_*.rb or *_test.rb)
  if (base.startsWith('test_')) {
    const sourceBase = base.slice(5);
    for (const p of allPaths) {
      if (p.endsWith(`/${sourceBase}.rb`) || p === `${sourceBase}.rb`) return p;
    }
    return null;
  }

  if (base.endsWith('_test')) {
    const sourceBase = base.slice(0, -5);
    for (const p of allPaths) {
      if (p.endsWith(`/${sourceBase}.rb`) || p === `${sourceBase}.rb`) return p;
    }
    return null;
  }

  // Source file — search for its test pair
  // RSpec: *_spec.rb (checked first, matches most Rails projects)
  for (const p of allPaths) {
    if (p.endsWith(`/${base}_spec.rb`) || p === `${base}_spec.rb`) return p;
  }

  // Minitest: test_*.rb
  for (const p of allPaths) {
    if (p.endsWith(`/test_${base}.rb`) || p === `test_${base}.rb`) return p;
  }

  // Minitest: *_test.rb
  for (const p of allPaths) {
    if (p.endsWith(`/${base}_test.rb`) || p === `${base}_test.rb`) return p;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Role classification
// ---------------------------------------------------------------------------

const CONTROLLER_CLASS_RE = /class\s+\w+\s*<\s*\S*ApplicationController/;
const CONTROLLER_NS_RE = /\bmodule\s+[\w:]*Controllers?\b|::Controllers?\b/;
const SERVICE_CLASS_RE = /class\s+\w+Service\b/;
const MODEL_RECORD_RE = /class\s+\w+\s*<\s*(?:ApplicationRecord|ActiveRecord::Base)\b/;

function classifyRubyRole(filePath: string, content: string): FileRole {
  // Test detection (highest priority — path-based)
  if (filePath.endsWith('_spec.rb') || filePath.endsWith('_test.rb')) return 'test';
  const base = basename(filePath);
  if (base.startsWith('test_')) return 'test';

  // Controller (content-based)
  if (CONTROLLER_CLASS_RE.test(content) || CONTROLLER_NS_RE.test(content)) return 'controller';

  // Service (content + path)
  if (SERVICE_CLASS_RE.test(content) || /(?:^|\/)app\/services\//.test(filePath)) return 'service';

  // Model (content + path)
  if (MODEL_RECORD_RE.test(content) || /(?:^|\/)app\/models\//.test(filePath)) return 'model';

  // Config (path-based)
  if (/(?:^|\/)config\//.test(filePath)) return 'config';

  return 'utility';
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

function resolveRubyImport(
  specifier: string,
  importerPath: string,
  allPaths: ReadonlySet<string>,
): string | null {
  if (!specifier) return null;

  // require_relative produces specifiers starting with '.' or '..'
  if (specifier.startsWith('.')) {
    const importerDir = dirname(importerPath);
    const resolved = normalize(join(importerDir, specifier));

    const rbPath = resolved.endsWith('.rb') ? resolved : `${resolved}.rb`;
    if (allPaths.has(rbPath)) return rbPath;

    const indexPath = join(resolved.endsWith('.rb') ? resolved.slice(0, -3) : resolved, 'index.rb');
    if (allPaths.has(indexPath)) return indexPath;

    return null;
  }

  // Absolute require: try project candidates before returning null (gems/stdlib → null)
  const rbName = specifier.endsWith('.rb') ? specifier : `${specifier}.rb`;

  // 1. Exact suffix match: name.rb
  for (const p of allPaths) {
    if (p === rbName || p.endsWith(`/${rbName}`)) return p;
  }

  // 2. name/index.rb
  const indexName = `${specifier}/index.rb`;
  for (const p of allPaths) {
    if (p === indexName || p.endsWith(`/${indexName}`)) return p;
  }

  // Gems / stdlib: return null
  return null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const rubyAdapter: LanguageAdapter = {
  id: 'ruby',
  extensions: RUBY_EXTENSIONS,

  classifyRole(filePath: string, content: string): FileRole | null {
    return classifyRubyRole(filePath, content);
  },

  extractImports(content: string): string[] {
    return extractRubyImports(content);
  },

  countSymbols(content: string): number {
    return countRubySymbols(content);
  },

  computeComplexity(content: string): number {
    return computeRubyComplexity(content);
  },

  resolveImport(
    specifier: string,
    importerPath: string,
    allPaths: ReadonlySet<string>,
  ): string | null {
    return resolveRubyImport(specifier, importerPath, allPaths);
  },

  detectTestPair(filePath: string, allPaths: Set<string>): string | null {
    return detectRubyTestPair(filePath, allPaths);
  },
};
