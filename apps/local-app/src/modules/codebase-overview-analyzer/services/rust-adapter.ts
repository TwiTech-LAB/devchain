import { dirname, join, basename } from 'path';
import type { FileRole, LanguageAdapter } from '@devchain/codebase-overview';

const RUST_EXTENSIONS = ['.rs'];

// ---------------------------------------------------------------------------
// Import extraction — use statements + mod declarations
// ---------------------------------------------------------------------------

function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    else if (s[i] === ',' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * Recursively expands Rust grouped use paths.
 * `crate::{a::B, c, d::{e, f}}` → ['crate::a::B', 'crate::c', 'crate::d::e', 'crate::d::f']
 * Glob (`*`) and self re-exports are silently dropped.
 */
function expandRustPath(pathExpr: string): string[] {
  const braceIdx = pathExpr.indexOf('{');
  if (braceIdx === -1) {
    const trimmed = pathExpr.trim();
    if (!trimmed || trimmed === '*' || trimmed === 'self' || trimmed.endsWith('::*')) return [];
    return [trimmed];
  }

  let depth = 0;
  let closeIdx = -1;
  for (let i = braceIdx; i < pathExpr.length; i++) {
    if (pathExpr[i] === '{') depth++;
    else if (pathExpr[i] === '}') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) return [];

  const prefix = pathExpr.slice(0, braceIdx).replace(/::$/, '');
  const inner = pathExpr.slice(braceIdx + 1, closeIdx);
  const result: string[] = [];
  for (const item of splitTopLevelCommas(inner)) {
    for (const exp of expandRustPath(item)) {
      result.push(prefix ? `${prefix}::${exp}` : exp);
    }
  }
  return result;
}

// Matches `mod foo;` (not `mod foo { ... }` inline module blocks)
const MOD_DECL_RE = /^(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm;

// Matches `use ...;` entry points (the scan handles nested braces)
const USE_START_RE = /\buse\s+/g;

function extractRustImports(content: string): string[] {
  const specifiers = new Set<string>();

  // Strip `as Alias` before whitespace-collapse to keep path segments intact
  const normalized = content.replace(/\bas\s+\w+/g, '');

  USE_START_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = USE_START_RE.exec(normalized)) !== null) {
    const start = m.index + m[0].length;
    let j = start;
    let depthBrace = 0;
    while (j < normalized.length) {
      const ch = normalized[j];
      if (ch === '{') depthBrace++;
      else if (ch === '}') depthBrace--;
      else if (ch === ';' && depthBrace === 0) break;
      j++;
    }
    const pathExpr = normalized.slice(start, j).replace(/\s+/g, '');
    if (pathExpr) {
      for (const expanded of expandRustPath(pathExpr)) {
        specifiers.add(expanded);
      }
    }
    USE_START_RE.lastIndex = j + 1;
  }

  // Collect `mod foo;` as specifier `mod::foo` (normalized for resolveImport)
  MOD_DECL_RE.lastIndex = 0;
  while ((m = MOD_DECL_RE.exec(content)) !== null) {
    if (m[1]) specifiers.add(`mod::${m[1]}`);
  }

  return [...specifiers];
}

// ---------------------------------------------------------------------------
// Symbol counting
// ---------------------------------------------------------------------------

const RUST_FN_RE = /\bfn\s+\w+/g;
const RUST_STRUCT_RE = /\bstruct\s+\w+/g;
const RUST_ENUM_RE = /\benum\s+\w+/g;
const RUST_TRAIT_RE = /\btrait\s+\w+/g;
const RUST_IMPL_RE = /\bimpl(?:<[^>]*>)?\s+\w+/g;
const RUST_CONST_STATIC_RE = /\b(?:const|static)\s+[A-Z_]\w*/g;
const RUST_TYPE_RE = /\btype\s+\w+/g;

function countRustSymbols(content: string): number {
  let count = 0;
  for (const re of [
    RUST_FN_RE,
    RUST_STRUCT_RE,
    RUST_ENUM_RE,
    RUST_TRAIT_RE,
    RUST_IMPL_RE,
    RUST_CONST_STATIC_RE,
    RUST_TYPE_RE,
  ]) {
    count += (content.match(re) ?? []).length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Complexity estimation
// ---------------------------------------------------------------------------

// `if` covers `if let`; `while` covers `while let` — both are idiomatic Rust patterns
const RUST_BRANCH_RE = /\b(?:if|else|match|for|while|loop)\b/g;
const RUST_QUESTION_RE = /\?/g;
const RUST_LOGICAL_RE = /&&|\|\|/g;

function computeRustComplexity(content: string): number {
  if (!content) return 1;
  let complexity = 1;
  complexity += (content.match(RUST_BRANCH_RE) ?? []).length;
  complexity += (content.match(RUST_QUESTION_RE) ?? []).length;
  complexity += (content.match(RUST_LOGICAL_RE) ?? []).length;
  return complexity;
}

// ---------------------------------------------------------------------------
// Test-pair detection
// ---------------------------------------------------------------------------

function detectRustTestPair(_filePath: string, _allPaths: Set<string>): string | null {
  // detectTestPair receives no content parameter, so inline #[cfg(test)] cannot be detected.
  // Conservative v1: always return null.
  return null;
}

// ---------------------------------------------------------------------------
// Role classification
// ---------------------------------------------------------------------------

const RUST_TEST_ATTR_RE = /#\[(?:cfg\s*\(\s*test\s*\)|test)\]/;

function classifyRustRole(filePath: string, content: string): FileRole | null {
  const normalized = filePath.replace(/\\/g, '/');
  const base = basename(filePath);

  // Integration test files in dedicated tests/ directory
  if (normalized.includes('/tests/') || normalized.startsWith('tests/')) return 'test';
  // Inline test module or test attribute
  if (RUST_TEST_ATTR_RE.test(content)) return 'test';

  // Binary entry points
  if (base === 'main.rs' || normalized.includes('/bin/')) return 'script';

  return null;
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

function probeRustFile(basePath: string, allPaths: ReadonlySet<string>): string | null {
  if (allPaths.has(basePath + '.rs')) return basePath + '.rs';
  const modPath = join(basePath, 'mod.rs');
  if (allPaths.has(modPath)) return modPath;
  return null;
}

/**
 * Returns the directory where submodules of the importer file live.
 * - `mod.rs`, `lib.rs`, `main.rs`: submodules live in the same directory as the file
 * - Any other file `foo.rs`: submodules live in `<dir>/foo/`
 */
function getModuleSubdir(importerPath: string): string {
  const base = basename(importerPath);
  if (base === 'mod.rs' || base === 'lib.rs' || base === 'main.rs') {
    return dirname(importerPath);
  }
  return join(dirname(importerPath), base.replace(/\.rs$/, ''));
}

function resolveRustImport(
  specifier: string,
  importerPath: string,
  allPaths: ReadonlySet<string>,
): string | null {
  if (!specifier) return null;

  // mod::name — from `mod foo;` declaration; submodule lives relative to importer
  if (specifier.startsWith('mod::')) {
    const modName = specifier.slice(5);
    const subDir = getModuleSubdir(importerPath);
    return probeRustFile(join(subDir, modName), allPaths);
  }

  // crate:: — resolve via suffix matching (path after `crate::` maps to src tree)
  if (specifier.startsWith('crate::')) {
    const segments = specifier.slice(7).split('::').filter(Boolean);
    for (let end = segments.length; end >= 1; end--) {
      const suffix = segments.slice(0, end).join('/');
      for (const p of allPaths) {
        if (!p.endsWith('.rs')) continue;
        // Normalise mod.rs paths: `src/foo/mod.rs` → base `src/foo`
        const base = p.replace(/\.rs$/, '').replace(/\/mod$/, '');
        if (base === suffix || base.endsWith('/' + suffix)) return p;
      }
    }
    return null;
  }

  // super:: — parent module lives in the importer's own directory
  if (specifier.startsWith('super::')) {
    const segments = specifier.slice(7).split('::').filter(Boolean);
    const dir = dirname(importerPath);
    for (let end = segments.length; end >= 1; end--) {
      const resolved = probeRustFile(join(dir, ...segments.slice(0, end)), allPaths);
      if (resolved) return resolved;
    }
    return null;
  }

  // self:: — same-module subpath (importer's directory)
  if (specifier.startsWith('self::')) {
    const segments = specifier.slice(6).split('::').filter(Boolean);
    const dir = dirname(importerPath);
    for (let end = segments.length; end >= 1; end--) {
      const resolved = probeRustFile(join(dir, ...segments.slice(0, end)), allPaths);
      if (resolved) return resolved;
    }
    return null;
  }

  // External crate — cannot resolve to a project file
  return null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const rustAdapter: LanguageAdapter = {
  id: 'rust',
  extensions: RUST_EXTENSIONS,

  classifyRole(filePath: string, content: string): FileRole | null {
    return classifyRustRole(filePath, content);
  },

  extractImports(content: string): string[] {
    return extractRustImports(content);
  },

  countSymbols(content: string): number {
    return countRustSymbols(content);
  },

  computeComplexity(content: string): number {
    return computeRustComplexity(content);
  },

  resolveImport(
    specifier: string,
    importerPath: string,
    allPaths: ReadonlySet<string>,
  ): string | null {
    return resolveRustImport(specifier, importerPath, allPaths);
  },

  detectTestPair(filePath: string, allPaths: Set<string>): string | null {
    return detectRustTestPair(filePath, allPaths);
  },
};
