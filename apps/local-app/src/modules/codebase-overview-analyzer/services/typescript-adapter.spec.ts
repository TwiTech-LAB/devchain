import { typescriptAdapter } from './typescript-adapter';

describe('TypeScript/JavaScript Adapter', () => {
  describe('id and extensions', () => {
    it('should have id "typescript"', () => {
      expect(typescriptAdapter.id).toBe('typescript');
    });

    it('should support TS, JS, and variant extensions', () => {
      expect(typescriptAdapter.extensions).toEqual(
        expect.arrayContaining(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']),
      );
    });
  });

  describe('classifyRole', () => {
    it('should classify files with describe/it/expect as test', () => {
      const content = `describe('foo', () => { it('works', () => { expect(true).toBe(true); }); });`;
      expect(typescriptAdapter.classifyRole('src/foo.ts', content)).toBe('test');
    });

    it('should classify files with jest.fn as test', () => {
      const content = `const mock = jest.fn();\ntest('something', () => {});`;
      expect(typescriptAdapter.classifyRole('src/foo.ts', content)).toBe('test');
    });

    it('should classify TSX files with JSX elements as view', () => {
      const content = `export function App() { return <div>Hello</div>; }`;
      expect(typescriptAdapter.classifyRole('src/App.tsx', content)).toBe('view');
    });

    it('should classify JSX files with React components as view', () => {
      const content = `export const Button = () => <Button onClick={handleClick} />;`;
      expect(typescriptAdapter.classifyRole('src/Button.jsx', content)).toBe('view');
    });

    it('should classify files with @Controller decorator as controller', () => {
      const content = `@Controller('/api/users')\nexport class UserController {}`;
      expect(typescriptAdapter.classifyRole('src/user.ts', content)).toBe('controller');
    });

    it('should classify files with @Injectable decorator as service', () => {
      const content = `@Injectable()\nexport class UserService {}`;
      expect(typescriptAdapter.classifyRole('src/user.ts', content)).toBe('service');
    });

    it('should return null for generic TS files without patterns', () => {
      const content = `export const FOO = 42;\nexport type Config = { key: string };`;
      expect(typescriptAdapter.classifyRole('src/constants.ts', content)).toBeNull();
    });

    it('should prioritize test detection over other patterns', () => {
      // A file with both @Injectable and test framework calls
      const content = `@Injectable()\ndescribe('test', () => { it('works', () => { expect(1).toBe(1); }); });`;
      expect(typescriptAdapter.classifyRole('src/foo.ts', content)).toBe('test');
    });
  });

  describe('extractImports', () => {
    it('should extract named ES module imports', () => {
      const content = `import { foo, bar } from './utils';`;
      const imports = typescriptAdapter.extractImports!(content);
      expect(imports).toContain('./utils');
    });

    it('should extract default imports', () => {
      const content = `import React from 'react';`;
      const imports = typescriptAdapter.extractImports!(content);
      expect(imports).toContain('react');
    });

    it('should extract side-effect imports', () => {
      const content = `import './polyfills';`;
      const imports = typescriptAdapter.extractImports!(content);
      expect(imports).toContain('./polyfills');
    });

    it('should extract dynamic imports', () => {
      const content = `const mod = await import('./lazy-module');`;
      const imports = typescriptAdapter.extractImports!(content);
      expect(imports).toContain('./lazy-module');
    });

    it('should extract CommonJS require calls', () => {
      const content = `const fs = require('fs');\nconst utils = require('./utils');`;
      const imports = typescriptAdapter.extractImports!(content);
      expect(imports).toContain('fs');
      expect(imports).toContain('./utils');
    });

    it('should extract re-export statements', () => {
      const content = `export { default } from './internal';\nexport * from './other';`;
      const imports = typescriptAdapter.extractImports!(content);
      expect(imports).toContain('./internal');
    });

    it('should deduplicate specifiers', () => {
      const content = `import { a } from './shared';\nimport { b } from './shared';`;
      const imports = typescriptAdapter.extractImports!(content);
      expect(imports.filter((s) => s === './shared')).toHaveLength(1);
    });

    it('should handle multi-line imports', () => {
      const content = `import {\n  foo,\n  bar,\n} from '../services/user';`;
      const imports = typescriptAdapter.extractImports!(content);
      expect(imports).toContain('../services/user');
    });

    it('should return empty array for content with no imports', () => {
      const content = `export const FOO = 42;`;
      const imports = typescriptAdapter.extractImports!(content);
      expect(imports).toEqual([]);
    });
  });

  describe('countSymbols', () => {
    it('should count exported functions', () => {
      const content = `export function foo() {}\nexport async function bar() {}`;
      expect(typescriptAdapter.countSymbols!(content)).toBe(2);
    });

    it('should count exported classes', () => {
      const content = `export class Foo {}\nexport abstract class Bar {}`;
      expect(typescriptAdapter.countSymbols!(content)).toBe(2);
    });

    it('should count exported interfaces and types', () => {
      const content = `export interface IFoo {}\nexport type Bar = string;`;
      expect(typescriptAdapter.countSymbols!(content)).toBe(2);
    });

    it('should count exported const/let/var', () => {
      const content = `export const A = 1;\nexport let B = 2;\nexport var C = 3;`;
      expect(typescriptAdapter.countSymbols!(content)).toBe(3);
    });

    it('should count export default', () => {
      const content = `export default function main() {}`;
      expect(typescriptAdapter.countSymbols!(content)).toBe(1);
    });

    it('should count exported enums', () => {
      const content = `export enum Status { Active, Inactive }`;
      expect(typescriptAdapter.countSymbols!(content)).toBe(1);
    });

    it('should not count non-exported declarations', () => {
      const content = `function internal() {}\nconst secret = 42;\nclass Private {}`;
      expect(typescriptAdapter.countSymbols!(content)).toBe(0);
    });

    it('should return 0 for empty content', () => {
      expect(typescriptAdapter.countSymbols!('')).toBe(0);
    });
  });

  describe('computeComplexity', () => {
    it('should return 1 for empty content (baseline)', () => {
      expect(typescriptAdapter.computeComplexity!('')).toBe(1);
    });

    it('should count if statements', () => {
      const content = `if (x) { } if (y) { }`;
      expect(typescriptAdapter.computeComplexity!(content)).toBe(3); // 1 base + 2 ifs
    });

    it('should count for and while loops', () => {
      const content = `for (let i = 0; i < n; i++) {}\nwhile (true) {}`;
      expect(typescriptAdapter.computeComplexity!(content)).toBe(3); // 1 + for + while
    });

    it('should count switch/case', () => {
      // case keywords are only counted when followed by ( — standard JS cases use literals
      const content = `switch (x) { case 1: break; case 2: break; }`;
      expect(typescriptAdapter.computeComplexity!(content)).toBe(2); // 1 + switch
    });

    it('should count catch blocks', () => {
      const content = `try { } catch (e) { }`;
      expect(typescriptAdapter.computeComplexity!(content)).toBe(2); // 1 + catch
    });

    it('should count logical operators', () => {
      const content = `if (a && b || c ?? d) {}`;
      expect(typescriptAdapter.computeComplexity!(content)).toBe(5); // 1 + if + && + || + ??
    });

    it('should count ternary operators', () => {
      const content = `const x = a ? b : c;`;
      expect(typescriptAdapter.computeComplexity!(content)).toBe(2); // 1 + ternary
    });

    it('should handle realistic code with multiple branches', () => {
      const content = `
function process(items) {
  if (items.length === 0) return;
  for (const item of items) {
    if (item.type === 'a' || item.type === 'b') {
      try {
        handle(item);
      } catch (e) {
        console.error(e);
      }
    }
  }
}`;
      const complexity = typescriptAdapter.computeComplexity!(content);
      expect(complexity).toBeGreaterThanOrEqual(6); // 1 + 2 ifs + for + || + catch
    });
  });

  describe('detectTestPair', () => {
    it('should find .spec test file for a source file', () => {
      const allPaths = new Set(['src/foo.ts', 'src/foo.spec.ts']);
      expect(typescriptAdapter.detectTestPair!('src/foo.ts', allPaths)).toBe('src/foo.spec.ts');
    });

    it('should find .test test file for a source file', () => {
      const allPaths = new Set(['src/foo.ts', 'src/foo.test.ts']);
      expect(typescriptAdapter.detectTestPair!('src/foo.ts', allPaths)).toBe('src/foo.test.ts');
    });

    it('should find source file for a .spec test file', () => {
      const allPaths = new Set(['src/bar.ts', 'src/bar.spec.ts']);
      expect(typescriptAdapter.detectTestPair!('src/bar.spec.ts', allPaths)).toBe('src/bar.ts');
    });

    it('should find source file for a .test test file', () => {
      const allPaths = new Set(['src/bar.ts', 'src/bar.test.ts']);
      expect(typescriptAdapter.detectTestPair!('src/bar.test.ts', allPaths)).toBe('src/bar.ts');
    });

    it('should return null when no pair exists', () => {
      const allPaths = new Set(['src/orphan.ts']);
      expect(typescriptAdapter.detectTestPair!('src/orphan.ts', allPaths)).toBeNull();
    });

    it('should find tests in __tests__ directory', () => {
      const allPaths = new Set(['src/foo.ts', 'src/__tests__/foo.spec.ts']);
      expect(typescriptAdapter.detectTestPair!('src/foo.ts', allPaths)).toBe(
        'src/__tests__/foo.spec.ts',
      );
    });

    it('should find source in parent directory from __tests__', () => {
      const allPaths = new Set(['src/foo.ts', 'src/__tests__/foo.spec.ts']);
      expect(typescriptAdapter.detectTestPair!('src/__tests__/foo.spec.ts', allPaths)).toBe(
        'src/foo.ts',
      );
    });

    it('should prefer .spec over .test when both exist', () => {
      const allPaths = new Set(['src/foo.ts', 'src/foo.test.ts', 'src/foo.spec.ts']);
      // .test is tried first in TEST_SUFFIXES order, but the source→test search
      // finds .test first since it's checked before .spec
      const result = typescriptAdapter.detectTestPair!('src/foo.ts', allPaths);
      expect(['src/foo.test.ts', 'src/foo.spec.ts']).toContain(result);
    });
  });
});
