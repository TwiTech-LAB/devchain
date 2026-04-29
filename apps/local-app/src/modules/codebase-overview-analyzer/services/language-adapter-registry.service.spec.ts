import { LanguageAdapterRegistryService } from './language-adapter-registry.service';

describe('LanguageAdapterRegistryService', () => {
  let registry: LanguageAdapterRegistryService;

  beforeEach(() => {
    registry = new LanguageAdapterRegistryService();
  });

  describe('getAdapter', () => {
    it('should return typescript adapter for .ts files', () => {
      const adapter = registry.getAdapter('src/foo.ts');
      expect(adapter).not.toBeNull();
      expect(adapter!.id).toBe('typescript');
    });

    it('should return typescript adapter for .tsx files', () => {
      expect(registry.getAdapter('src/App.tsx')).not.toBeNull();
    });

    it('should return typescript adapter for .js files', () => {
      expect(registry.getAdapter('src/index.js')).not.toBeNull();
    });

    it('should return typescript adapter for .jsx files', () => {
      expect(registry.getAdapter('src/App.jsx')).not.toBeNull();
    });

    it('should return typescript adapter for .mjs files', () => {
      expect(registry.getAdapter('scripts/build.mjs')).not.toBeNull();
    });

    it('should return typescript adapter for .cjs files', () => {
      expect(registry.getAdapter('config.cjs')).not.toBeNull();
    });

    it('should return python adapter for .py files', () => {
      const adapter = registry.getAdapter('src/main.py');
      expect(adapter).not.toBeNull();
      expect(adapter!.id).toBe('python');
    });

    it('should return python adapter for .pyw files', () => {
      const adapter = registry.getAdapter('src/gui.pyw');
      expect(adapter).not.toBeNull();
      expect(adapter!.id).toBe('python');
    });

    it('should return ruby adapter for .rb files', () => {
      const adapter = registry.getAdapter('src/main.rb');
      expect(adapter).not.toBeNull();
      expect(adapter!.id).toBe('ruby');
    });

    it('should return null for .md files', () => {
      expect(registry.getAdapter('README.md')).toBeNull();
    });

    it('should return null for .json files', () => {
      expect(registry.getAdapter('package.json')).toBeNull();
    });

    it('should be case-insensitive for extensions', () => {
      expect(registry.getAdapter('src/Foo.TS')).not.toBeNull();
      expect(registry.getAdapter('src/Bar.TSX')).not.toBeNull();
    });
  });

  describe('classifyRole', () => {
    it('should classify test files from content for supported extensions', () => {
      const content = `describe('test', () => { it('works', () => {}); });`;
      expect(registry.classifyRole('src/foo.ts', content)).toBe('test');
    });

    it('should classify Python test files from content', () => {
      const content = `import pytest\n\ndef test_example():\n    pass`;
      expect(registry.classifyRole('src/tests.py', content)).toBe('test');
    });

    it('should classify .rb files using ruby adapter', () => {
      expect(registry.classifyRole('src/main.rb', 'puts "hello"')).toBe('utility');
    });

    it('should delegate to adapter classifyRole', () => {
      const content = `@Controller('/users')\nexport class UserController {}`;
      expect(registry.classifyRole('src/user.ts', content)).toBe('controller');
    });
  });

  describe('extractImports', () => {
    it('should extract imports from TS files', () => {
      const result = registry.extractImports('src/foo.ts', `import { x } from './bar';`);
      expect(result).toEqual(['./bar']);
    });

    it('should extract imports from Python files', () => {
      const result = registry.extractImports('src/foo.py', 'import os');
      expect(result).toEqual(['os']);
    });

    it('should extract imports from .rb files', () => {
      expect(registry.extractImports('src/foo.rb', 'require "os"')).toEqual(['os']);
    });
  });

  describe('countSymbols', () => {
    it('should count symbols from TS files', () => {
      const result = registry.countSymbols(
        'src/foo.ts',
        'export function bar() {}\nexport class Baz {}',
      );
      expect(result).toBe(2);
    });

    it('should count symbols from Python files', () => {
      const result = registry.countSymbols(
        'src/foo.py',
        'def bar():\n    pass\n\nclass Baz:\n    pass',
      );
      expect(result).toBe(2);
    });

    it('should count symbols from .rb files', () => {
      expect(registry.countSymbols('src/foo.rb', 'def bar; end')).toBe(1);
    });
  });

  describe('computeComplexity', () => {
    it('should compute complexity for TS files', () => {
      const result = registry.computeComplexity('src/foo.ts', 'if (x) {}');
      expect(result).toBe(2); // 1 base + 1 if
    });

    it('should compute complexity for Python files', () => {
      const result = registry.computeComplexity('src/foo.py', 'if x:\n    pass');
      expect(result).toBe(2); // 1 base + 1 if
    });

    it('should compute complexity for .rb files', () => {
      expect(registry.computeComplexity('src/foo.rb', 'if x; end')).toBe(2); // 1 base + 1 if
    });
  });

  describe('detectTestPair', () => {
    it('should detect test pair for TS files', () => {
      const allPaths = new Set(['src/foo.ts', 'src/foo.spec.ts']);
      expect(registry.detectTestPair('src/foo.ts', allPaths)).toBe('src/foo.spec.ts');
    });

    it('should detect test pair for Python files', () => {
      const allPaths = new Set(['main.py', 'test_main.py']);
      expect(registry.detectTestPair('main.py', allPaths)).toBe('test_main.py');
    });

    it('should detect test pair for .rb files', () => {
      const allPaths = new Set(['main.rb', 'main_spec.rb']);
      expect(registry.detectTestPair('main.rb', allPaths)).toBe('main_spec.rb');
    });

    it('should return null when no pair found', () => {
      const allPaths = new Set(['src/orphan.ts']);
      expect(registry.detectTestPair('src/orphan.ts', allPaths)).toBeNull();
    });
  });
});
