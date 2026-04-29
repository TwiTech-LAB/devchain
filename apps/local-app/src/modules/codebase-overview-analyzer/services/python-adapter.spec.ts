import { pythonAdapter } from './python-adapter';

describe('Python Adapter', () => {
  describe('id and extensions', () => {
    it('should have id "python"', () => {
      expect(pythonAdapter.id).toBe('python');
    });

    it('should support .py and .pyw extensions', () => {
      expect(pythonAdapter.extensions).toEqual(expect.arrayContaining(['.py', '.pyw']));
    });
  });

  describe('classifyRole', () => {
    it('should classify files with test_ function definitions as test', () => {
      const content = `def test_something():\n    assert True`;
      expect(pythonAdapter.classifyRole('src/test_foo.py', content)).toBe('test');
    });

    it('should classify files with TestCase class as test', () => {
      const content = `class TestUser:\n    def test_create(self):\n        pass`;
      expect(pythonAdapter.classifyRole('src/test_user.py', content)).toBe('test');
    });

    it('should classify files with pytest import as test', () => {
      const content = `import pytest\n\ndef test_example():\n    pass`;
      expect(pythonAdapter.classifyRole('src/tests.py', content)).toBe('test');
    });

    it('should classify files with unittest import as test', () => {
      const content = `import unittest\n\nclass MyTests(unittest.TestCase):\n    pass`;
      expect(pythonAdapter.classifyRole('src/tests.py', content)).toBe('test');
    });

    it('should classify Flask route files as controller', () => {
      const content = `@app.route('/users')\ndef get_users():\n    return []`;
      expect(pythonAdapter.classifyRole('src/routes.py', content)).toBe('controller');
    });

    it('should classify FastAPI route files as controller', () => {
      const content = `@router.get('/items')\nasync def list_items():\n    return []`;
      expect(pythonAdapter.classifyRole('src/routes.py', content)).toBe('controller');
    });

    it('should classify Django view classes as view', () => {
      const content = `class UserListView(ListView):\n    model = User`;
      expect(pythonAdapter.classifyRole('src/views.py', content)).toBe('view');
    });

    it('should classify Django APIView classes as view', () => {
      const content = `class UserView(APIView):\n    def get(self, request):\n        pass`;
      expect(pythonAdapter.classifyRole('src/views.py', content)).toBe('view');
    });

    it('should classify Django model files as model', () => {
      const content = `class User(models.Model):\n    name = models.CharField(max_length=100)`;
      expect(pythonAdapter.classifyRole('src/models.py', content)).toBe('model');
    });

    it('should classify CLI files with argparse as script', () => {
      const content = `import argparse\n\nparser = argparse.ArgumentParser()`;
      expect(pythonAdapter.classifyRole('src/cli.py', content)).toBe('script');
    });

    it('should classify CLI files with click as script', () => {
      const content = `@click.command()\ndef main():\n    pass`;
      expect(pythonAdapter.classifyRole('src/cli.py', content)).toBe('script');
    });

    it('should return null for generic Python files', () => {
      const content = `def helper():\n    return 42\n\nclass Config:\n    pass`;
      expect(pythonAdapter.classifyRole('src/utils.py', content)).toBeNull();
    });

    it('should prioritize test detection over other patterns', () => {
      const content = `import pytest\n\n@app.route('/test')\ndef test_route():\n    pass`;
      expect(pythonAdapter.classifyRole('src/test_routes.py', content)).toBe('test');
    });
  });

  describe('extractImports', () => {
    it('should extract simple import statements', () => {
      const content = `import os\nimport sys`;
      const imports = pythonAdapter.extractImports!(content);
      expect(imports).toContain('os');
      expect(imports).toContain('sys');
    });

    it('should extract dotted import paths', () => {
      const content = `import os.path\nimport collections.abc`;
      const imports = pythonAdapter.extractImports!(content);
      expect(imports).toContain('os.path');
      expect(imports).toContain('collections.abc');
    });

    it('should extract from-import statements', () => {
      const content = `from os import path\nfrom typing import List, Dict`;
      const imports = pythonAdapter.extractImports!(content);
      expect(imports).toContain('os');
      expect(imports).toContain('typing');
    });

    it('should extract relative imports', () => {
      const content = `from . import utils\nfrom ..models import User`;
      const imports = pythonAdapter.extractImports!(content);
      expect(imports).toContain('.');
      expect(imports).toContain('..models');
    });

    it('should deduplicate import specifiers', () => {
      const content = `import os\nfrom os import path\nimport os`;
      const imports = pythonAdapter.extractImports!(content);
      expect(imports.filter((s) => s === 'os')).toHaveLength(1);
    });

    it('should return empty array for content with no imports', () => {
      const content = `def foo():\n    return 42`;
      const imports = pythonAdapter.extractImports!(content);
      expect(imports).toEqual([]);
    });

    it('should handle import with alias', () => {
      const content = `import numpy as np`;
      const imports = pythonAdapter.extractImports!(content);
      expect(imports).toContain('numpy');
    });
  });

  describe('countSymbols', () => {
    it('should count top-level function definitions', () => {
      const content = `def foo():\n    pass\n\ndef bar():\n    pass`;
      expect(pythonAdapter.countSymbols!(content)).toBe(2);
    });

    it('should count top-level class definitions', () => {
      const content = `class Foo:\n    pass\n\nclass Bar:\n    pass`;
      expect(pythonAdapter.countSymbols!(content)).toBe(2);
    });

    it('should count async function definitions', () => {
      const content = `async def fetch_data():\n    pass\n\ndef sync_func():\n    pass`;
      expect(pythonAdapter.countSymbols!(content)).toBe(2);
    });

    it('should not count private definitions starting with underscore', () => {
      const content = `def _private():\n    pass\n\ndef __dunder__():\n    pass\n\ndef public():\n    pass`;
      expect(pythonAdapter.countSymbols!(content)).toBe(1);
    });

    it('should not count indented (nested) definitions', () => {
      const content = `class Foo:\n    def method(self):\n        pass\n\ndef top_level():\n    pass`;
      expect(pythonAdapter.countSymbols!(content)).toBe(2); // Foo + top_level
    });

    it('should return 0 for empty content', () => {
      expect(pythonAdapter.countSymbols!('')).toBe(0);
    });

    it('should return 0 for content with only imports', () => {
      const content = `import os\nimport sys\n`;
      expect(pythonAdapter.countSymbols!(content)).toBe(0);
    });
  });

  describe('computeComplexity', () => {
    it('should return 1 for empty content (baseline)', () => {
      expect(pythonAdapter.computeComplexity!('')).toBe(1);
    });

    it('should count if and elif', () => {
      const content = `if x:\n    pass\nelif y:\n    pass`;
      expect(pythonAdapter.computeComplexity!(content)).toBe(3); // 1 + if + elif
    });

    it('should count for and while loops', () => {
      const content = `for i in range(10):\n    pass\nwhile True:\n    pass`;
      expect(pythonAdapter.computeComplexity!(content)).toBe(3); // 1 + for + while
    });

    it('should count try and except', () => {
      const content = `try:\n    pass\nexcept ValueError:\n    pass\nexcept:\n    pass`;
      expect(pythonAdapter.computeComplexity!(content)).toBe(4); // 1 + try + 2 excepts
    });

    it('should count logical operators', () => {
      const content = `if x and y or z:\n    pass`;
      expect(pythonAdapter.computeComplexity!(content)).toBe(4); // 1 + if + and + or
    });

    it('should count assert and with', () => {
      const content = `assert x > 0\nwith open('f') as f:\n    pass`;
      expect(pythonAdapter.computeComplexity!(content)).toBe(3); // 1 + assert + with
    });

    it('should handle realistic Python code', () => {
      const content = `
def process(items):
    if not items:
        return
    for item in items:
        if item.type == 'a' or item.type == 'b':
            try:
                handle(item)
            except Exception:
                log(item)`;
      const complexity = pythonAdapter.computeComplexity!(content);
      expect(complexity).toBeGreaterThanOrEqual(7); // 1 + 2 ifs + for + or + try + except
    });
  });

  describe('detectTestPair', () => {
    it('should find source file for test_<name>.py pattern', () => {
      const allPaths = new Set(['src/utils.py', 'src/test_utils.py']);
      expect(pythonAdapter.detectTestPair!('src/test_utils.py', allPaths)).toBe('src/utils.py');
    });

    it('should find source file for <name>_test.py pattern', () => {
      const allPaths = new Set(['src/utils.py', 'src/utils_test.py']);
      expect(pythonAdapter.detectTestPair!('src/utils_test.py', allPaths)).toBe('src/utils.py');
    });

    it('should find test file with test_ prefix for source', () => {
      const allPaths = new Set(['src/utils.py', 'src/test_utils.py']);
      expect(pythonAdapter.detectTestPair!('src/utils.py', allPaths)).toBe('src/test_utils.py');
    });

    it('should find test file with _test suffix for source', () => {
      const allPaths = new Set(['src/utils.py', 'src/utils_test.py']);
      expect(pythonAdapter.detectTestPair!('src/utils.py', allPaths)).toBe('src/utils_test.py');
    });

    it('should find test in tests/ subdirectory', () => {
      const allPaths = new Set(['src/utils.py', 'src/tests/test_utils.py']);
      expect(pythonAdapter.detectTestPair!('src/utils.py', allPaths)).toBe(
        'src/tests/test_utils.py',
      );
    });

    it('should find test in test/ subdirectory', () => {
      const allPaths = new Set(['src/utils.py', 'src/test/test_utils.py']);
      expect(pythonAdapter.detectTestPair!('src/utils.py', allPaths)).toBe(
        'src/test/test_utils.py',
      );
    });

    it('should find source in parent dir from tests/ subdirectory', () => {
      const allPaths = new Set(['src/utils.py', 'src/tests/test_utils.py']);
      expect(pythonAdapter.detectTestPair!('src/tests/test_utils.py', allPaths)).toBe(
        'src/utils.py',
      );
    });

    it('should return null when no pair exists', () => {
      const allPaths = new Set(['src/orphan.py']);
      expect(pythonAdapter.detectTestPair!('src/orphan.py', allPaths)).toBeNull();
    });

    it('should prefer test_ prefix over _test suffix', () => {
      const allPaths = new Set(['src/foo.py', 'src/test_foo.py', 'src/foo_test.py']);
      // test_ prefix is checked first
      expect(pythonAdapter.detectTestPair!('src/foo.py', allPaths)).toBe('src/test_foo.py');
    });
  });
});
