import { phpAdapter } from './php-adapter';

describe('PHP Adapter', () => {
  describe('id and extensions', () => {
    it('should have id "php"', () => {
      expect(phpAdapter.id).toBe('php');
    });

    it('should support .php and .phtml extensions', () => {
      expect(phpAdapter.extensions).toEqual(expect.arrayContaining(['.php', '.phtml']));
    });
  });

  describe('classifyRole', () => {
    it('should classify .phtml files as view', () => {
      expect(phpAdapter.classifyRole('resources/views/home.phtml', '')).toBe('view');
    });

    it('should classify files in templates/ directory as view', () => {
      expect(phpAdapter.classifyRole('app/templates/layout.php', '')).toBe('view');
    });

    it('should classify files extending TestCase as test', () => {
      const content = `class UserTest extends TestCase {}`;
      expect(phpAdapter.classifyRole('tests/UserTest.php', content)).toBe('test');
    });

    it('should classify files in Tests\\ namespace as test', () => {
      const content = `namespace Tests\\Unit;`;
      expect(phpAdapter.classifyRole('tests/UserTest.php', content)).toBe('test');
    });

    it('should classify files extending Controller as controller', () => {
      const content = `class UserController extends Controller {}`;
      expect(phpAdapter.classifyRole('app/Http/Controllers/UserController.php', content)).toBe(
        'controller',
      );
    });

    it('should classify files implementing ControllerInterface as controller', () => {
      const content = `class UserController implements ControllerInterface {}`;
      expect(phpAdapter.classifyRole('app/UserController.php', content)).toBe('controller');
    });

    it('should classify files in Http\\Controllers namespace as controller', () => {
      const content = `namespace App\\Http\\Controllers;`;
      expect(phpAdapter.classifyRole('app/Http/Controllers/UserController.php', content)).toBe(
        'controller',
      );
    });

    it('should classify files with Service-suffixed class name as service', () => {
      const content = `class UserService {}`;
      expect(phpAdapter.classifyRole('app/Services/UserService.php', content)).toBe('service');
    });

    it('should classify Eloquent models (extends Model) as model', () => {
      const content = `class User extends Model {}`;
      expect(phpAdapter.classifyRole('app/Models/User.php', content)).toBe('model');
    });

    it('should classify Doctrine entities with #[ORM\\Entity] attribute as model', () => {
      const content = `#[ORM\\Entity]\nclass User {}`;
      expect(phpAdapter.classifyRole('src/Entity/User.php', content)).toBe('model');
    });

    it('should classify Doctrine entities with #[Entity] attribute as model', () => {
      const content = `#[Entity]\nclass User {}`;
      expect(phpAdapter.classifyRole('src/Entity/User.php', content)).toBe('model');
    });

    it('should NOT classify files with only a Doctrine use-import as model', () => {
      const content = `use Doctrine\\ORM\\Mapping;\nclass User extends BaseEntity {}`;
      expect(phpAdapter.classifyRole('src/Entity/User.php', content)).not.toBe('model');
    });

    it('should classify files under config/ path as config', () => {
      expect(phpAdapter.classifyRole('config/database.php', '')).toBe('config');
    });

    it('should return utility for generic PHP files', () => {
      const content = `function helper() { return 42; }`;
      expect(phpAdapter.classifyRole('src/helpers.php', content)).toBe('utility');
    });

    it('should prioritize test over service for *ServiceTest extends TestCase', () => {
      const content = `class UserServiceTest extends TestCase {}`;
      expect(phpAdapter.classifyRole('tests/UserServiceTest.php', content)).toBe('test');
    });
  });

  describe('extractImports', () => {
    it('should extract simple use statements', () => {
      const content = `use Foo\\Bar;\nuse Baz\\Qux;`;
      const imports = phpAdapter.extractImports!(content);
      expect(imports).toContain('Foo\\Bar');
      expect(imports).toContain('Baz\\Qux');
    });

    it('should extract aliased use (namespace only, not alias)', () => {
      const content = `use Foo\\Bar as B;`;
      const imports = phpAdapter.extractImports!(content);
      expect(imports).toContain('Foo\\Bar');
      expect(imports).not.toContain('Foo\\Bar as B');
    });

    it('should expand grouped use statements', () => {
      const content = `use Foo\\{Bar, Baz};`;
      const imports = phpAdapter.extractImports!(content);
      expect(imports).toContain('Foo\\Bar');
      expect(imports).toContain('Foo\\Baz');
    });

    it('should expand grouped use with per-member aliases (capture namespace, not alias)', () => {
      const content = `use Foo\\{Bar as B, Baz};`;
      const imports = phpAdapter.extractImports!(content);
      expect(imports).toContain('Foo\\Bar');
      expect(imports).toContain('Foo\\Baz');
    });

    it('should extract use function statements', () => {
      const content = `use function Foo\\bar;`;
      const imports = phpAdapter.extractImports!(content);
      expect(imports).toContain('Foo\\bar');
    });

    it('should extract use const statements', () => {
      const content = `use const Foo\\BAR;`;
      const imports = phpAdapter.extractImports!(content);
      expect(imports).toContain('Foo\\BAR');
    });

    it('should extract require_once paths', () => {
      const content = `require_once './vendor/autoload.php';`;
      const imports = phpAdapter.extractImports!(content);
      expect(imports).toContain('./vendor/autoload.php');
    });

    it('should extract include paths', () => {
      const content = `include '../config/database.php';`;
      const imports = phpAdapter.extractImports!(content);
      expect(imports).toContain('../config/database.php');
    });

    it('should NOT match closure use captures: function () use ($x)', () => {
      const content = `$fn = function () use ($x, $y) { return $x + $y; };`;
      expect(phpAdapter.extractImports!(content)).toHaveLength(0);
    });

    it('should deduplicate identical import specifiers', () => {
      const content = `use Foo\\Bar;\nuse Foo\\Bar;`;
      const imports = phpAdapter.extractImports!(content);
      expect(imports.filter((s) => s === 'Foo\\Bar')).toHaveLength(1);
    });

    it('should return empty array when no imports exist', () => {
      expect(phpAdapter.extractImports!('class Foo {}')).toEqual([]);
    });
  });

  describe('countSymbols', () => {
    it('should count standalone function definitions', () => {
      const content = `function foo() {}\nfunction bar() {}`;
      expect(phpAdapter.countSymbols!(content)).toBe(2);
    });

    it('should count class definitions', () => {
      const content = `class Foo {}\nclass Bar {}`;
      expect(phpAdapter.countSymbols!(content)).toBe(2);
    });

    it('should count interface, trait, and enum definitions', () => {
      const content = `interface Countable {}\ntrait Serializable {}\nenum Status {}`;
      expect(phpAdapter.countSymbols!(content)).toBe(3);
    });

    it('should count methods with visibility modifiers', () => {
      const content = `class Foo {\n  public function getA() {}\n  private function getB() {}\n}`;
      // class Foo (1) + getA (1) + getB (1) = 3
      expect(phpAdapter.countSymbols!(content)).toBe(3);
    });

    it('should count const declarations', () => {
      const content = `const VERSION = '1.0';\nconst TIMEOUT = 30;`;
      expect(phpAdapter.countSymbols!(content)).toBe(2);
    });

    it('should NOT count anonymous closures', () => {
      const content = `$fn = function () { return 1; };`;
      // no named function, no class/interface/trait/enum, no const
      expect(phpAdapter.countSymbols!(content)).toBe(0);
    });

    it('should return 0 for empty content', () => {
      expect(phpAdapter.countSymbols!('')).toBe(0);
    });
  });

  describe('computeComplexity', () => {
    it('should return 1 for empty content (baseline)', () => {
      expect(phpAdapter.computeComplexity!('')).toBe(1);
    });

    it('should count if and elseif', () => {
      const content = `if ($x) {} elseif ($y) {}`;
      expect(phpAdapter.computeComplexity!(content)).toBe(3); // 1 + if + elseif
    });

    it('should count for, foreach, and while loops', () => {
      const content = `for ($i=0;$i<10;$i++) {}\nforeach ($a as $v) {}\nwhile ($x) {}`;
      expect(phpAdapter.computeComplexity!(content)).toBe(4); // 1 + for + foreach + while
    });

    it('should count PHP 8 match expression', () => {
      const content = `$v = match($x) { 1 => 'a', default => 'b' };`;
      expect(phpAdapter.computeComplexity!(content)).toBe(2); // 1 + match
    });

    it('should count switch case labels', () => {
      const content = `switch ($x) { case 1: break; case 2: break; }`;
      expect(phpAdapter.computeComplexity!(content)).toBe(3); // 1 + 2 cases
    });

    it('should count ternary operator', () => {
      const content = `$v = $x ? 'a' : 'b';`;
      expect(phpAdapter.computeComplexity!(content)).toBe(2); // 1 + ?
    });

    it('should count null-coalescing operator ??', () => {
      const content = `$v = $x ?? $default;`;
      expect(phpAdapter.computeComplexity!(content)).toBe(2); // 1 + ??
    });

    it('should count catch blocks', () => {
      const content = `try {} catch (\\Exception $e) {} catch (\\Error $e) {}`;
      expect(phpAdapter.computeComplexity!(content)).toBe(3); // 1 + 2 catches
    });

    it('should count && and || logical operators', () => {
      const content = `if ($a && $b || $c) {}`;
      expect(phpAdapter.computeComplexity!(content)).toBe(4); // 1 + if + && + ||
    });

    it('should handle realistic PHP code', () => {
      const content = `
function process(array $items): string {
  if (empty($items)) {
    return '';
  }
  $result = '';
  foreach ($items as $item) {
    try {
      $result .= match($item->type) {
        'a' => handle($item),
        default => $item->value ?? 'none',
      };
    } catch (\\Exception $e) {
      log($e);
    }
  }
  return $result;
}`;
      // 1 + if + foreach + match + catch + ?? = 6
      expect(phpAdapter.computeComplexity!(content)).toBeGreaterThanOrEqual(6);
    });
  });

  describe('detectTestPair', () => {
    it('should find FooTest.php for Foo.php in the same directory', () => {
      const allPaths = new Set(['src/User.php', 'src/UserTest.php']);
      expect(phpAdapter.detectTestPair!('src/User.php', allPaths)).toBe('src/UserTest.php');
    });

    it('should find source Foo.php for FooTest.php in the same directory', () => {
      const allPaths = new Set(['src/User.php', 'src/UserTest.php']);
      expect(phpAdapter.detectTestPair!('src/UserTest.php', allPaths)).toBe('src/User.php');
    });

    it('should find test in tests/ subdirectory for source file', () => {
      const allPaths = new Set(['src/User.php', 'src/tests/UserTest.php']);
      expect(phpAdapter.detectTestPair!('src/User.php', allPaths)).toBe('src/tests/UserTest.php');
    });

    it('should find source via src/ sibling from tests/ directory', () => {
      const allPaths = new Set(['src/User.php', 'tests/UserTest.php']);
      expect(phpAdapter.detectTestPair!('tests/UserTest.php', allPaths)).toBe('src/User.php');
    });

    it('should return null when no test pair exists', () => {
      const allPaths = new Set(['src/Orphan.php']);
      expect(phpAdapter.detectTestPair!('src/Orphan.php', allPaths)).toBeNull();
    });
  });

  describe('resolveImport', () => {
    it('should resolve relative ./ paths', () => {
      const allPaths = new Set(['src/config/database.php']);
      expect(
        phpAdapter.resolveImport!('./config/database.php', 'src/bootstrap.php', allPaths),
      ).toBe('src/config/database.php');
    });

    it('should resolve relative ../ paths', () => {
      const allPaths = new Set(['src/utils.php']);
      expect(phpAdapter.resolveImport!('../utils.php', 'src/controllers/Foo.php', allPaths)).toBe(
        'src/utils.php',
      );
    });

    it('should resolve PSR-4 namespace to file path via suffix-match', () => {
      const allPaths = new Set(['src/Foo/Bar.php']);
      expect(phpAdapter.resolveImport!('Foo\\Bar', 'src/controllers/Ctrl.php', allPaths)).toBe(
        'src/Foo/Bar.php',
      );
    });

    it('should return null for unresolvable external namespace', () => {
      const allPaths = new Set(['src/User.php']);
      expect(
        phpAdapter.resolveImport!(
          'Illuminate\\Support\\Collection',
          'src/controllers/Ctrl.php',
          allPaths,
        ),
      ).toBeNull();
    });

    it('should return null for relative path not present in allPaths', () => {
      const allPaths = new Set(['src/other.php']);
      expect(
        phpAdapter.resolveImport!('./nonexistent.php', 'src/bootstrap.php', allPaths),
      ).toBeNull();
    });

    it('should resolve PSR-0 namespace with underscores to path segments', () => {
      const allPaths = new Set(['lib/Foo/Bar/Baz.php']);
      // Foo_Bar_Baz → Foo/Bar/Baz (PSR-0)
      expect(phpAdapter.resolveImport!('Foo_Bar_Baz', 'src/main.php', allPaths)).toBe(
        'lib/Foo/Bar/Baz.php',
      );
    });
  });
});
