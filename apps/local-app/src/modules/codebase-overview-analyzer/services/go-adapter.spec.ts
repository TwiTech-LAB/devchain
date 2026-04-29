import { goAdapter } from './go-adapter';

describe('Go Adapter', () => {
  describe('id and extensions', () => {
    it('should have id "go"', () => {
      expect(goAdapter.id).toBe('go');
    });

    it('should support .go extension', () => {
      expect(goAdapter.extensions).toEqual(['.go']);
    });
  });

  describe('classifyRole', () => {
    it('classifies _test.go files as test', () => {
      expect(goAdapter.classifyRole('pkg/user_test.go', 'package user')).toBe('test');
    });

    it('classifies files with Test functions as test', () => {
      const content =
        'func TestCreateUser(t *testing.T) {\n\tt.Run("ok", func(t *testing.T) {})\n}';
      expect(goAdapter.classifyRole('pkg/user.go', content)).toBe('test');
    });

    it('classifies HTTP handler as controller', () => {
      const content = 'func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {}';
      expect(goAdapter.classifyRole('api/handler.go', content)).toBe('controller');
    });

    it('classifies gin context handler as controller', () => {
      const content = 'func GetUsers(c gin.Context) {\n\tc.JSON(200, users)\n}';
      expect(goAdapter.classifyRole('api/users.go', content)).toBe('controller');
    });

    it('classifies http.HandlerFunc as controller', () => {
      const content =
        'func ListItems(w http.ResponseWriter, r *http.Request) {\n\tjson.NewEncoder(w).Encode(items)\n}';
      expect(goAdapter.classifyRole('api/items.go', content)).toBe('controller');
    });

    it('classifies struct with db tags as model', () => {
      const content = 'type User struct {\n\tID   int    `db:"id"`\n\tName string `db:"name"`\n}';
      expect(goAdapter.classifyRole('models/user.go', content)).toBe('model');
    });

    it('classifies GORM model as model', () => {
      const content = 'type Product struct {\n\tgorm.Model\n\tName string\n}';
      expect(goAdapter.classifyRole('models/product.go', content)).toBe('model');
    });

    it('classifies config.go as config', () => {
      expect(goAdapter.classifyRole('internal/config.go', 'package config')).toBe('config');
    });

    it('classifies viper usage as config', () => {
      const content = 'func Load() {\n\tviper.SetConfigFile(".env")\n}';
      expect(goAdapter.classifyRole('pkg/settings.go', content)).toBe('config');
    });

    it('classifies Service suffix as service', () => {
      const content = 'type UserService struct {\n\trepo UserRepo\n}';
      expect(goAdapter.classifyRole('services/user.go', content)).toBe('service');
    });

    it('returns null for generic Go files', () => {
      expect(
        goAdapter.classifyRole(
          'pkg/utils.go',
          'package utils\n\nfunc Add(a, b int) int { return a + b }',
        ),
      ).toBeNull();
    });
  });

  describe('extractImports', () => {
    it('extracts single import', () => {
      expect(goAdapter.extractImports!('import "fmt"')).toEqual(['fmt']);
    });

    it('extracts aliased import', () => {
      expect(goAdapter.extractImports!('import myfmt "fmt"')).toEqual(['fmt']);
    });

    it('extracts blank import', () => {
      expect(goAdapter.extractImports!('import _ "net/http/pprof"')).toEqual(['net/http/pprof']);
    });

    it('extracts dot import', () => {
      expect(goAdapter.extractImports!('import . "github.com/user/pkg"')).toEqual([
        'github.com/user/pkg',
      ]);
    });

    it('extracts grouped imports', () => {
      const content = `import (
  "fmt"
  "os"
  mylog "log"
  _ "net/http/pprof"
  "github.com/user/repo/pkg"
)`;
      const result = goAdapter.extractImports!(content);
      expect(result).toContain('fmt');
      expect(result).toContain('os');
      expect(result).toContain('log');
      expect(result).toContain('net/http/pprof');
      expect(result).toContain('github.com/user/repo/pkg');
    });

    it('extracts grouped dot import', () => {
      const content = `import (
  . "github.com/user/repo/internal/auth"
  _ "net/http/pprof"
  "fmt"
)`;
      const result = goAdapter.extractImports!(content);
      expect(result).toContain('github.com/user/repo/internal/auth');
      expect(result).toContain('net/http/pprof');
      expect(result).toContain('fmt');
    });

    it('deduplicates imports', () => {
      const content = `import "fmt"\nimport "fmt"`;
      expect(goAdapter.extractImports!(content)).toEqual(['fmt']);
    });

    it('returns empty array for no imports', () => {
      expect(goAdapter.extractImports!('package main\n\nfunc main() {}')).toEqual([]);
    });
  });

  describe('countSymbols', () => {
    it('counts top-level functions', () => {
      const content =
        'func Add(a, b int) int { return a + b }\nfunc Sub(a, b int) int { return a - b }';
      expect(goAdapter.countSymbols!(content)).toBe(2);
    });

    it('counts receiver methods', () => {
      const content =
        'func (s *Service) Create() error { return nil }\nfunc (s *Service) Delete() error { return nil }';
      expect(goAdapter.countSymbols!(content)).toBe(2);
    });

    it('counts type declarations', () => {
      const content =
        'type User struct {\n\tName string\n}\n\ntype Handler interface {\n\tHandle() error\n}';
      expect(goAdapter.countSymbols!(content)).toBe(2);
    });

    it('counts var and const declarations', () => {
      const content = 'var MaxRetries = 3\nconst DefaultTimeout = 30';
      expect(goAdapter.countSymbols!(content)).toBe(2);
    });

    it('counts names in var/const blocks', () => {
      const content = 'const (\n\tFoo = 1\n\tBar = 2\n\tBaz = 3\n)';
      expect(goAdapter.countSymbols!(content)).toBe(3);
    });

    it('deduplicates symbols', () => {
      const content = 'type User struct {}\nfunc (u *User) Name() string { return "" }';
      expect(goAdapter.countSymbols!(content)).toBe(2);
    });
  });

  describe('computeComplexity', () => {
    it('returns 1 for empty content', () => {
      expect(goAdapter.computeComplexity!('')).toBe(1);
    });

    it('counts if/else', () => {
      const content = 'if x > 0 {\n\treturn x\n} else {\n\treturn -x\n}';
      expect(goAdapter.computeComplexity!(content)).toBeGreaterThan(1);
    });

    it('counts for loops', () => {
      const content = 'for i := 0; i < 10; i++ {\n\tfmt.Println(i)\n}';
      expect(goAdapter.computeComplexity!(content)).toBe(2);
    });

    it('counts switch cases', () => {
      const content =
        'switch x {\ncase 1:\n\treturn "one"\ncase 2:\n\treturn "two"\ndefault:\n\treturn "other"\n}';
      expect(goAdapter.computeComplexity!(content)).toBe(4);
    });

    it('counts logical operators', () => {
      const content = 'if a > 0 && b > 0 || c < 0 {\n\treturn true\n}';
      expect(goAdapter.computeComplexity!(content)).toBeGreaterThan(2);
    });

    it('counts select cases', () => {
      const content = 'select {\ncase msg := <-ch:\n\tfmt.Println(msg)\ncase <-done:\n\treturn\n}';
      expect(goAdapter.computeComplexity!(content)).toBe(3);
    });
  });

  describe('detectTestPair', () => {
    it('test file finds source file', () => {
      const allPaths = new Set(['pkg/user.go', 'pkg/user_test.go']);
      expect(goAdapter.detectTestPair!('pkg/user_test.go', allPaths)).toBe('pkg/user.go');
    });

    it('source file finds test file', () => {
      const allPaths = new Set(['pkg/user.go', 'pkg/user_test.go']);
      expect(goAdapter.detectTestPair!('pkg/user.go', allPaths)).toBe('pkg/user_test.go');
    });

    it('returns null when no pair exists', () => {
      const allPaths = new Set(['pkg/user.go']);
      expect(goAdapter.detectTestPair!('pkg/user.go', allPaths)).toBeNull();
    });

    it('returns null for test file without source', () => {
      const allPaths = new Set(['pkg/user_test.go']);
      expect(goAdapter.detectTestPair!('pkg/user_test.go', allPaths)).toBeNull();
    });
  });

  describe('resolveImport', () => {
    it('returns null for stdlib imports (no dot in first segment)', () => {
      const allPaths = new Set(['main.go']);
      expect(goAdapter.resolveImport!('fmt', 'main.go', allPaths)).toBeNull();
      expect(goAdapter.resolveImport!('net/http', 'main.go', allPaths)).toBeNull();
    });

    it('resolves local package via suffix match', () => {
      const allPaths = new Set([
        'cmd/server/main.go',
        'internal/auth/handler.go',
        'internal/auth/middleware.go',
      ]);
      const result = goAdapter.resolveImport!(
        'github.com/user/repo/internal/auth',
        'cmd/server/main.go',
        allPaths,
      );
      expect(result).toBeTruthy();
      expect(result).toMatch(/internal\/auth\//);
    });

    it('returns null for cross-module external imports', () => {
      const allPaths = new Set(['main.go']);
      expect(goAdapter.resolveImport!('github.com/external/lib', 'main.go', allPaths)).toBeNull();
    });

    it('returns null for ambiguous matches (multiple directories at same suffix)', () => {
      const allPaths = new Set(['lib/a/pkg/utils/helpers.go', 'lib/b/pkg/utils/helpers.go']);
      expect(goAdapter.resolveImport!('github.com/org/pkg/utils', 'main.go', allPaths)).toBeNull();
    });

    it('returns null for empty specifier', () => {
      expect(goAdapter.resolveImport!('', 'main.go', new Set())).toBeNull();
    });

    it('resolves /internal/ path segments', () => {
      const allPaths = new Set(['internal/db/conn.go']);
      const result = goAdapter.resolveImport!(
        'github.com/myorg/myapp/internal/db',
        'cmd/main.go',
        allPaths,
      );
      expect(result).toBe('internal/db/conn.go');
    });
  });
});
