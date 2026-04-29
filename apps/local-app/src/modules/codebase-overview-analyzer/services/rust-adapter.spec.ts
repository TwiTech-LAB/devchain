import { rustAdapter } from './rust-adapter';

describe('Rust Adapter', () => {
  describe('id and extensions', () => {
    it('should have id "rust"', () => {
      expect(rustAdapter.id).toBe('rust');
    });

    it('should support .rs extension', () => {
      expect(rustAdapter.extensions).toEqual(['.rs']);
    });
  });

  describe('classifyRole', () => {
    it('classifies file with #[cfg(test)] as test', () => {
      const content = '#[cfg(test)]\nmod tests {\n    use super::*;\n}';
      expect(rustAdapter.classifyRole('src/lib.rs', content)).toBe('test');
    });

    it('classifies file with #[test] attribute as test', () => {
      const content = '#[test]\nfn it_works() { assert_eq!(2 + 2, 4); }';
      expect(rustAdapter.classifyRole('src/util.rs', content)).toBe('test');
    });

    it('classifies file in tests/ directory as test', () => {
      expect(rustAdapter.classifyRole('tests/integration.rs', 'fn test_main() {}')).toBe('test');
    });

    it('classifies main.rs as script', () => {
      expect(rustAdapter.classifyRole('src/main.rs', 'fn main() {}')).toBe('script');
    });

    it('classifies file in bin/ directory as script', () => {
      expect(rustAdapter.classifyRole('src/bin/server.rs', 'fn main() {}')).toBe('script');
    });

    it('returns null for lib.rs without test attributes', () => {
      expect(rustAdapter.classifyRole('src/lib.rs', 'pub mod auth;')).toBeNull();
    });

    it('returns null for generic source file', () => {
      expect(rustAdapter.classifyRole('src/auth/handler.rs', 'pub fn handle() {}')).toBeNull();
    });
  });

  describe('extractImports', () => {
    it('extracts simple use statement', () => {
      expect(rustAdapter.extractImports!('use std::io::Read;')).toContain('std::io::Read');
    });

    it('strips as alias from use statement', () => {
      const result = rustAdapter.extractImports!('use std::collections::HashMap as Map;');
      expect(result).toContain('std::collections::HashMap');
      expect(result.some((s) => s === 'Map' || s.endsWith('::Map'))).toBe(false);
    });

    it('extracts crate-relative path', () => {
      expect(rustAdapter.extractImports!('use crate::auth::login;')).toContain(
        'crate::auth::login',
      );
    });

    it('extracts super-relative path', () => {
      expect(rustAdapter.extractImports!('use super::models::User;')).toContain(
        'super::models::User',
      );
    });

    it('extracts mod declaration as mod::name specifier', () => {
      expect(rustAdapter.extractImports!('mod auth;')).toContain('mod::auth');
    });

    it('extracts pub mod declaration', () => {
      expect(rustAdapter.extractImports!('pub mod routes;')).toContain('mod::routes');
    });

    it('does not extract inline mod block as import', () => {
      const content = 'mod utils { pub fn helper() {} }';
      expect(rustAdapter.extractImports!(content)).not.toContain('mod::utils');
    });

    it('expands simple grouped use', () => {
      const result = rustAdapter.extractImports!('use crate::{auth, models};');
      expect(result).toContain('crate::auth');
      expect(result).toContain('crate::models');
    });

    it('expands nested grouped use', () => {
      const result = rustAdapter.extractImports!('use crate::{a::B, c, d::{e, f}};');
      expect(result).toContain('crate::a::B');
      expect(result).toContain('crate::c');
      expect(result).toContain('crate::d::e');
      expect(result).toContain('crate::d::f');
    });

    it('excludes glob imports', () => {
      const result = rustAdapter.extractImports!('use crate::prelude::*;');
      expect(result).toHaveLength(0);
    });

    it('excludes self re-export in grouped use', () => {
      const result = rustAdapter.extractImports!('use crate::auth::{self, login};');
      expect(result).not.toContain('crate::auth::self');
      expect(result).toContain('crate::auth::login');
    });

    it('deduplicates identical specifiers', () => {
      const content = 'use std::io::Read;\nuse std::io::Read;';
      expect(rustAdapter.extractImports!(content)).toEqual(['std::io::Read']);
    });

    it('returns empty array for no imports', () => {
      expect(rustAdapter.extractImports!('fn main() {}\n')).toEqual([]);
    });

    it('strips aliases in grouped use', () => {
      const result = rustAdapter.extractImports!('use std::io::{Read as R, Write as W};');
      expect(result).toContain('std::io::Read');
      expect(result).toContain('std::io::Write');
      expect(result.some((s) => s.includes(' as '))).toBe(false);
    });
  });

  describe('countSymbols', () => {
    it('counts top-level functions', () => {
      const content = 'fn foo() {}\nfn bar() {}';
      expect(rustAdapter.countSymbols!(content)).toBeGreaterThanOrEqual(2);
    });

    it('counts pub functions', () => {
      const content = 'pub fn create() {}\npub async fn delete() {}';
      expect(rustAdapter.countSymbols!(content)).toBeGreaterThanOrEqual(2);
    });

    it('counts struct, enum, trait', () => {
      const content = 'struct User {}\nenum Status { Active, Inactive }\ntrait Repo {}';
      expect(rustAdapter.countSymbols!(content)).toBeGreaterThanOrEqual(3);
    });

    it('counts impl blocks', () => {
      const content = 'impl User {}\nimpl Display for User {}';
      expect(rustAdapter.countSymbols!(content)).toBeGreaterThanOrEqual(2);
    });

    it('counts uppercase const and static', () => {
      const content = 'const MAX_RETRIES: u32 = 3;\nstatic DEFAULT_HOST: &str = "localhost";';
      expect(rustAdapter.countSymbols!(content)).toBeGreaterThanOrEqual(2);
    });

    it('counts type aliases', () => {
      const content = 'type Result<T> = std::result::Result<T, Error>;\ntype UserId = u64;';
      expect(rustAdapter.countSymbols!(content)).toBeGreaterThanOrEqual(2);
    });

    it('returns 0 for empty content', () => {
      expect(rustAdapter.countSymbols!('')).toBe(0);
    });
  });

  describe('computeComplexity', () => {
    it('returns 1 for empty content', () => {
      expect(rustAdapter.computeComplexity!('')).toBe(1);
    });

    it('counts if branches', () => {
      const content = 'if x > 0 { return x; } else { return -x; }';
      expect(rustAdapter.computeComplexity!(content)).toBeGreaterThan(1);
    });

    it('counts if let (idiomatic Rust)', () => {
      const content = 'if let Some(v) = opt { v } else { 0 }';
      // `if` + `else` = +2
      expect(rustAdapter.computeComplexity!(content)).toBeGreaterThanOrEqual(3);
    });

    it('counts while let (idiomatic Rust)', () => {
      const content = 'while let Some(item) = iter.next() { process(item); }';
      // `while` = +1
      expect(rustAdapter.computeComplexity!(content)).toBeGreaterThanOrEqual(2);
    });

    it('counts match expressions', () => {
      const content = 'match status {\n  Ok(v) => v,\n  Err(e) => panic!("{}", e),\n}';
      expect(rustAdapter.computeComplexity!(content)).toBeGreaterThanOrEqual(2);
    });

    it('counts for and loop', () => {
      const content = 'for i in 0..10 { loop { break; } }';
      // `for` + `loop` = +2
      expect(rustAdapter.computeComplexity!(content)).toBeGreaterThanOrEqual(3);
    });

    it('counts ? operator', () => {
      const content = 'fn run() -> Result<()> { let x = parse()?; let y = read()?; Ok(()) }';
      // 2 × `?`
      expect(rustAdapter.computeComplexity!(content)).toBeGreaterThanOrEqual(3);
    });

    it('counts logical operators', () => {
      const content = 'if a > 0 && b < 10 || c == 0 { true }';
      // `if` + `&&` + `||` = +3
      expect(rustAdapter.computeComplexity!(content)).toBeGreaterThanOrEqual(4);
    });
  });

  describe('detectTestPair', () => {
    it('returns null for a regular source file', () => {
      const allPaths = new Set(['src/lib.rs', 'src/auth.rs']);
      expect(rustAdapter.detectTestPair!('src/lib.rs', allPaths)).toBeNull();
    });

    it('returns null for a file with inline test content (interface has no content param)', () => {
      const allPaths = new Set(['src/auth.rs']);
      expect(rustAdapter.detectTestPair!('src/auth.rs', allPaths)).toBeNull();
    });

    it('returns null for integration test file in tests/', () => {
      const allPaths = new Set(['tests/integration.rs']);
      expect(rustAdapter.detectTestPair!('tests/integration.rs', allPaths)).toBeNull();
    });

    it('returns null for file in src/tests/', () => {
      const allPaths = new Set(['src/tests/e2e.rs']);
      expect(rustAdapter.detectTestPair!('src/tests/e2e.rs', allPaths)).toBeNull();
    });

    it('returns null for file not in allPaths', () => {
      expect(rustAdapter.detectTestPair!('src/missing.rs', new Set())).toBeNull();
    });
  });

  describe('resolveImport', () => {
    it('returns null for empty specifier', () => {
      expect(rustAdapter.resolveImport!('', 'src/main.rs', new Set())).toBeNull();
    });

    it('returns null for external crate (no qualifier)', () => {
      const allPaths = new Set(['src/lib.rs']);
      expect(rustAdapter.resolveImport!('serde::Deserialize', 'src/main.rs', allPaths)).toBeNull();
    });

    it('resolves mod::name from main.rs to file in src/', () => {
      const allPaths = new Set(['src/main.rs', 'src/auth.rs']);
      expect(rustAdapter.resolveImport!('mod::auth', 'src/main.rs', allPaths)).toBe('src/auth.rs');
    });

    it('resolves mod::name to mod.rs variant', () => {
      const allPaths = new Set(['src/main.rs', 'src/auth/mod.rs']);
      expect(rustAdapter.resolveImport!('mod::auth', 'src/main.rs', allPaths)).toBe(
        'src/auth/mod.rs',
      );
    });

    it('resolves mod::name from regular file to subdirectory', () => {
      // `mod foo;` in `src/bar.rs` → looks in `src/bar/foo.rs`
      const allPaths = new Set(['src/bar.rs', 'src/bar/foo.rs']);
      expect(rustAdapter.resolveImport!('mod::foo', 'src/bar.rs', allPaths)).toBe('src/bar/foo.rs');
    });

    it('resolves crate:: path via suffix matching', () => {
      const allPaths = new Set(['src/main.rs', 'src/models/user.rs']);
      const result = rustAdapter.resolveImport!(
        'crate::models::user::User',
        'src/main.rs',
        allPaths,
      );
      expect(result).toBe('src/models/user.rs');
    });

    it('resolves crate:: path to mod.rs variant', () => {
      const allPaths = new Set(['src/main.rs', 'src/auth/mod.rs']);
      const result = rustAdapter.resolveImport!('crate::auth::login', 'src/main.rs', allPaths);
      expect(result).toBe('src/auth/mod.rs');
    });

    it('resolves super:: path to sibling file', () => {
      const allPaths = new Set(['src/auth/handler.rs', 'src/auth/models.rs']);
      const result = rustAdapter.resolveImport!(
        'super::models::User',
        'src/auth/handler.rs',
        allPaths,
      );
      expect(result).toBe('src/auth/models.rs');
    });

    it('resolves self:: path in same directory', () => {
      const allPaths = new Set(['src/auth/mod.rs', 'src/auth/login.rs']);
      const result = rustAdapter.resolveImport!('self::login', 'src/auth/mod.rs', allPaths);
      expect(result).toBe('src/auth/login.rs');
    });

    it('returns null for unresolvable crate:: path', () => {
      const allPaths = new Set(['src/main.rs']);
      expect(
        rustAdapter.resolveImport!('crate::nonexistent::Thing', 'src/main.rs', allPaths),
      ).toBeNull();
    });
  });
});
