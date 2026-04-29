import { javaAdapter } from './java-adapter';

describe('Java Adapter', () => {
  describe('id and extensions', () => {
    it('should have id "java"', () => {
      expect(javaAdapter.id).toBe('java');
    });

    it('should support .java extension', () => {
      expect(javaAdapter.extensions).toEqual(['.java']);
    });
  });

  describe('classifyRole', () => {
    it('classifies *Test.java as test', () => {
      expect(javaAdapter.classifyRole('src/UserTest.java', 'class UserTest {}')).toBe('test');
    });

    it('classifies @Test annotation as test', () => {
      const content = 'class Foo {\n  @Test\n  void testSomething() {}\n}';
      expect(javaAdapter.classifyRole('src/Foo.java', content)).toBe('test');
    });

    it('classifies extends TestCase as test', () => {
      const content = 'class MyTest extends TestCase {}';
      expect(javaAdapter.classifyRole('src/MyTest.java', content)).toBe('test');
    });

    it('classifies @RestController as controller', () => {
      const content = '@RestController\npublic class UserController {}';
      expect(javaAdapter.classifyRole('src/UserController.java', content)).toBe('controller');
    });

    it('classifies @GetMapping as controller', () => {
      const content = '@GetMapping("/users")\npublic List<User> list() {}';
      expect(javaAdapter.classifyRole('src/Routes.java', content)).toBe('controller');
    });

    it('classifies @Entity as model', () => {
      const content = '@Entity\npublic class User {\n  @Id\n  private Long id;\n}';
      expect(javaAdapter.classifyRole('src/User.java', content)).toBe('model');
    });

    it('classifies @Table as model', () => {
      const content = '@Table(name = "users")\npublic class UserEntity {}';
      expect(javaAdapter.classifyRole('src/UserEntity.java', content)).toBe('model');
    });

    it('classifies @Configuration as config', () => {
      const content = '@Configuration\npublic class AppConfig {}';
      expect(javaAdapter.classifyRole('src/AppConfig.java', content)).toBe('config');
    });

    it('classifies *Config.java as config', () => {
      expect(javaAdapter.classifyRole('src/SecurityConfig.java', 'class SecurityConfig {}')).toBe(
        'config',
      );
    });

    it('classifies @Service as service', () => {
      const content = '@Service\npublic class UserService {}';
      expect(javaAdapter.classifyRole('src/UserService.java', content)).toBe('service');
    });

    it('classifies class with Service suffix as service', () => {
      const content = 'public class OrderService {\n  public void process() {}\n}';
      expect(javaAdapter.classifyRole('src/OrderService.java', content)).toBe('service');
    });

    it('returns null for generic Java files', () => {
      const content =
        'public class StringUtils {\n  public static String trim(String s) { return s.trim(); }\n}';
      expect(javaAdapter.classifyRole('src/StringUtils.java', content)).toBeNull();
    });
  });

  describe('extractImports', () => {
    it('extracts regular import', () => {
      expect(javaAdapter.extractImports!('import com.example.User;')).toEqual(['com.example.User']);
    });

    it('extracts static import (drops static keyword, keeps full path)', () => {
      const result = javaAdapter.extractImports!('import static org.junit.Assert.assertEquals;');
      expect(result).toEqual(['org.junit.Assert.assertEquals']);
    });

    it('extracts wildcard import preserving .* suffix', () => {
      const result = javaAdapter.extractImports!('import com.example.models.*;');
      expect(result).toEqual(['com.example.models.*']);
    });

    it('extracts multiple imports', () => {
      const content = 'import com.example.User;\nimport com.example.Order;\nimport java.util.List;';
      const result = javaAdapter.extractImports!(content);
      expect(result).toContain('com.example.User');
      expect(result).toContain('com.example.Order');
      expect(result).toContain('java.util.List');
    });

    it('deduplicates imports', () => {
      const content = 'import com.example.User;\nimport com.example.User;';
      expect(javaAdapter.extractImports!(content)).toEqual(['com.example.User']);
    });

    it('returns empty for no imports', () => {
      expect(javaAdapter.extractImports!('public class Main {}')).toEqual([]);
    });
  });

  describe('countSymbols', () => {
    it('counts class declarations', () => {
      expect(javaAdapter.countSymbols!('public class User {}\nclass Admin {}')).toBe(2);
    });

    it('counts interface declarations', () => {
      expect(javaAdapter.countSymbols!('interface UserService {}\ninterface OrderService {}')).toBe(
        2,
      );
    });

    it('counts enum and record', () => {
      expect(
        javaAdapter.countSymbols!(
          'enum Status { ACTIVE, INACTIVE }\nrecord Point(int x, int y) {}',
        ),
      ).toBe(2);
    });

    it('counts static final constants', () => {
      const content =
        'static final int MAX_SIZE = 100;\nstatic final String DEFAULT_NAME = "test";';
      expect(javaAdapter.countSymbols!(content)).toBe(2);
    });

    it('deduplicates symbols', () => {
      const content = 'class User {}\n// mentioned again: class User';
      expect(javaAdapter.countSymbols!(content)).toBe(1);
    });
  });

  describe('computeComplexity', () => {
    it('returns 1 for empty content', () => {
      expect(javaAdapter.computeComplexity!('')).toBe(1);
    });

    it('counts if/else', () => {
      const content = 'if (x > 0) { return x; } else { return -x; }';
      expect(javaAdapter.computeComplexity!(content)).toBeGreaterThan(1);
    });

    it('counts for and while', () => {
      const content = 'for (int i = 0; i < 10; i++) {}\nwhile (true) { break; }';
      expect(javaAdapter.computeComplexity!(content)).toBe(3);
    });

    it('counts switch cases', () => {
      const content =
        'switch (x) {\n  case 1: return "a";\n  case 2: return "b";\n  default: return "c";\n}';
      expect(javaAdapter.computeComplexity!(content)).toBe(4);
    });

    it('counts catch blocks', () => {
      const content = 'try { doSomething(); } catch (Exception e) { log(e); }';
      expect(javaAdapter.computeComplexity!(content)).toBe(2);
    });

    it('counts logical operators', () => {
      const content = 'if (a && b || c) { return true; }';
      expect(javaAdapter.computeComplexity!(content)).toBeGreaterThan(2);
    });

    it('counts ternary operator', () => {
      const content = 'int x = (a > 0) ? a : -a;';
      expect(javaAdapter.computeComplexity!(content)).toBe(2);
    });
  });

  describe('detectTestPair', () => {
    it('test file finds source in same directory', () => {
      const allPaths = new Set(['src/User.java', 'src/UserTest.java']);
      expect(javaAdapter.detectTestPair!('src/UserTest.java', allPaths)).toBe('src/User.java');
    });

    it('source file finds test in same directory', () => {
      const allPaths = new Set(['src/User.java', 'src/UserTest.java']);
      expect(javaAdapter.detectTestPair!('src/User.java', allPaths)).toBe('src/UserTest.java');
    });

    it('test file finds source via src/test → src/main mirror', () => {
      const allPaths = new Set([
        'src/main/java/com/example/User.java',
        'src/test/java/com/example/UserTest.java',
      ]);
      expect(javaAdapter.detectTestPair!('src/test/java/com/example/UserTest.java', allPaths)).toBe(
        'src/main/java/com/example/User.java',
      );
    });

    it('source file finds test via src/main → src/test mirror', () => {
      const allPaths = new Set([
        'src/main/java/com/example/User.java',
        'src/test/java/com/example/UserTest.java',
      ]);
      expect(javaAdapter.detectTestPair!('src/main/java/com/example/User.java', allPaths)).toBe(
        'src/test/java/com/example/UserTest.java',
      );
    });

    it('supports *Tests.java suffix', () => {
      const allPaths = new Set(['src/User.java', 'src/UserTests.java']);
      expect(javaAdapter.detectTestPair!('src/UserTests.java', allPaths)).toBe('src/User.java');
    });

    it('supports *IT.java suffix', () => {
      const allPaths = new Set(['src/User.java', 'src/UserIT.java']);
      expect(javaAdapter.detectTestPair!('src/UserIT.java', allPaths)).toBe('src/User.java');
    });

    it('returns null when no pair exists', () => {
      const allPaths = new Set(['src/User.java']);
      expect(javaAdapter.detectTestPair!('src/User.java', allPaths)).toBeNull();
    });
  });

  describe('resolveImport', () => {
    it('resolves dot-separated import to file path', () => {
      const allPaths = new Set(['src/main/java/com/example/User.java']);
      expect(javaAdapter.resolveImport!('com.example.User', 'src/Main.java', allPaths)).toBe(
        'src/main/java/com/example/User.java',
      );
    });

    it('returns null for java stdlib', () => {
      const allPaths = new Set(['src/Main.java']);
      expect(javaAdapter.resolveImport!('java.util.List', 'src/Main.java', allPaths)).toBeNull();
      expect(
        javaAdapter.resolveImport!('javax.persistence.Entity', 'src/Main.java', allPaths),
      ).toBeNull();
      expect(
        javaAdapter.resolveImport!('jakarta.persistence.Entity', 'src/Main.java', allPaths),
      ).toBeNull();
    });

    it('resolves inner class by progressive stripping', () => {
      const allPaths = new Set(['src/com/example/Outer.java']);
      expect(javaAdapter.resolveImport!('com.example.Outer.Inner', 'src/Main.java', allPaths)).toBe(
        'src/com/example/Outer.java',
      );
    });

    it('returns null for wildcard import', () => {
      const allPaths = new Set(['src/com/example/User.java']);
      expect(javaAdapter.resolveImport!('com.example.*', 'src/Main.java', allPaths)).toBeNull();
    });

    it('returns null for wildcard specifier even when matching file exists', () => {
      const allPaths = new Set(['src/main/java/com/example/models.java']);
      expect(
        javaAdapter.resolveImport!('com.example.models.*', 'src/Main.java', allPaths),
      ).toBeNull();
    });

    it('returns null for unresolvable external import', () => {
      const allPaths = new Set(['src/Main.java']);
      expect(
        javaAdapter.resolveImport!(
          'org.springframework.boot.Application',
          'src/Main.java',
          allPaths,
        ),
      ).toBeNull();
    });

    it('returns null for empty specifier', () => {
      expect(javaAdapter.resolveImport!('', 'src/Main.java', new Set())).toBeNull();
    });
  });
});
