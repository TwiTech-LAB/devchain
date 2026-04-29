import { rubyAdapter } from './ruby-adapter';

describe('Ruby Adapter', () => {
  describe('id and extensions', () => {
    it('should have id "ruby"', () => {
      expect(rubyAdapter.id).toBe('ruby');
    });

    it('should support .rb extension only', () => {
      expect(rubyAdapter.extensions).toEqual(['.rb']);
    });
  });

  describe('classifyRole', () => {
    it('should classify *_spec.rb files as test', () => {
      expect(rubyAdapter.classifyRole('spec/models/user_spec.rb', '')).toBe('test');
    });

    it('should classify *_test.rb files as test', () => {
      expect(rubyAdapter.classifyRole('test/user_test.rb', '')).toBe('test');
    });

    it('should classify test_*.rb files as test', () => {
      expect(rubyAdapter.classifyRole('test/test_user.rb', '')).toBe('test');
    });

    it('should classify files inheriting ApplicationController as controller', () => {
      const content = `class UsersController < ApplicationController\n  def index; end\nend`;
      expect(rubyAdapter.classifyRole('app/controllers/users_controller.rb', content)).toBe(
        'controller',
      );
    });

    it('should classify files with Controllers namespace as controller', () => {
      const content = `module Api::Controllers\n  class UsersController\n  end\nend`;
      expect(rubyAdapter.classifyRole('app/controllers/api/users_controller.rb', content)).toBe(
        'controller',
      );
    });

    it('should classify files with Service suffix as service', () => {
      const content = `class PaymentService\n  def process; end\nend`;
      expect(rubyAdapter.classifyRole('app/services/payment_service.rb', content)).toBe('service');
    });

    it('should classify files in app/services/ path as service', () => {
      expect(rubyAdapter.classifyRole('app/services/notifier.rb', '')).toBe('service');
    });

    it('should classify files inheriting ApplicationRecord as model', () => {
      const content = `class User < ApplicationRecord\n  validates :name, presence: true\nend`;
      expect(rubyAdapter.classifyRole('app/models/user.rb', content)).toBe('model');
    });

    it('should classify files inheriting ActiveRecord::Base as model', () => {
      const content = `class Product < ActiveRecord::Base\nend`;
      expect(rubyAdapter.classifyRole('app/models/product.rb', content)).toBe('model');
    });

    it('should classify files in app/models/ path as model', () => {
      expect(rubyAdapter.classifyRole('app/models/concern.rb', '')).toBe('model');
    });

    it('should classify files under config/ as config', () => {
      expect(rubyAdapter.classifyRole('config/application.rb', '')).toBe('config');
    });

    it('should classify files under config/initializers/ as config', () => {
      expect(rubyAdapter.classifyRole('config/initializers/devise.rb', '')).toBe('config');
    });

    it('should classify unmatched files as utility', () => {
      const content = `module MathHelper\n  def add(a, b)\n    a + b\n  end\nend`;
      expect(rubyAdapter.classifyRole('lib/math_helper.rb', content)).toBe('utility');
    });

    it('should prioritize test detection over other patterns', () => {
      const content = `class UsersController < ApplicationController\n  def test_something; end\nend`;
      expect(rubyAdapter.classifyRole('spec/controllers/users_spec.rb', content)).toBe('test');
    });
  });

  describe('extractImports', () => {
    it('should extract require with single quotes', () => {
      const content = `require 'active_record'`;
      expect(rubyAdapter.extractImports!(content)).toContain('active_record');
    });

    it('should extract require with double quotes', () => {
      const content = `require "json"`;
      expect(rubyAdapter.extractImports!(content)).toContain('json');
    });

    it('should extract require_relative', () => {
      const content = `require_relative '../models/user'`;
      expect(rubyAdapter.extractImports!(content)).toContain('../models/user');
    });

    it('should extract require_relative with double quotes', () => {
      const content = `require_relative "../lib/helper"`;
      expect(rubyAdapter.extractImports!(content)).toContain('../lib/helper');
    });

    it('should extract load statements', () => {
      const content = `load 'tasks/setup.rb'`;
      expect(rubyAdapter.extractImports!(content)).toContain('tasks/setup.rb');
    });

    it('should extract autoload statements', () => {
      const content = `autoload :User, 'models/user'`;
      expect(rubyAdapter.extractImports!(content)).toContain('models/user');
    });

    it('should extract multiple import types from the same file', () => {
      const content = [
        `require 'json'`,
        `require_relative '../utils'`,
        `load 'boot.rb'`,
        `autoload :Foo, 'foo'`,
      ].join('\n');
      const imports = rubyAdapter.extractImports!(content);
      expect(imports).toContain('json');
      expect(imports).toContain('../utils');
      expect(imports).toContain('boot.rb');
      expect(imports).toContain('foo');
    });

    it('should deduplicate import specifiers', () => {
      const content = `require 'json'\nrequire 'json'`;
      const imports = rubyAdapter.extractImports!(content);
      expect(imports.filter((s) => s === 'json')).toHaveLength(1);
    });

    it('should return empty array for content with no imports', () => {
      const content = `def foo\n  42\nend`;
      expect(rubyAdapter.extractImports!(content)).toEqual([]);
    });
  });

  describe('countSymbols', () => {
    it('should count class definitions', () => {
      const content = `class Foo\nend\n\nclass Bar\nend`;
      expect(rubyAdapter.countSymbols!(content)).toBe(2);
    });

    it('should count module definitions', () => {
      const content = `module Foo\nend\n\nmodule Bar\nend`;
      expect(rubyAdapter.countSymbols!(content)).toBe(2);
    });

    it('should count instance method definitions', () => {
      const content = `def foo\n  42\nend\n\ndef bar\n  43\nend`;
      expect(rubyAdapter.countSymbols!(content)).toBe(2);
    });

    it('should count class method (self.) definitions', () => {
      const content = `def self.create\nend\n\ndef self.find\nend`;
      expect(rubyAdapter.countSymbols!(content)).toBe(2);
    });

    it('should count mixed class, module, and def', () => {
      const content = `module M\n  class C\n    def foo; end\n    def self.bar; end\n  end\nend`;
      expect(rubyAdapter.countSymbols!(content)).toBe(4); // module + class + 2 defs
    });

    it('should NOT count attr_accessor as symbols', () => {
      const content = `class User\n  attr_accessor :name, :email\n  def initialize; end\nend`;
      // class + def = 2; attr_accessor excluded
      expect(rubyAdapter.countSymbols!(content)).toBe(2);
    });

    it('should NOT count attr_reader or attr_writer as symbols', () => {
      const content = `class Foo\n  attr_reader :x\n  attr_writer :y\nend`;
      // only class counts
      expect(rubyAdapter.countSymbols!(content)).toBe(1);
    });

    it('should return 0 for empty content', () => {
      expect(rubyAdapter.countSymbols!('')).toBe(0);
    });
  });

  describe('computeComplexity', () => {
    it('should return 1 for empty content (baseline)', () => {
      expect(rubyAdapter.computeComplexity!('')).toBe(1);
    });

    it('should count if and elsif', () => {
      const content = `if x\n  do_a\nelsif y\n  do_b\nend`;
      expect(rubyAdapter.computeComplexity!(content)).toBe(3); // 1 + if + elsif
    });

    it('should count unless', () => {
      const content = `unless x\n  do_a\nend`;
      expect(rubyAdapter.computeComplexity!(content)).toBe(2); // 1 + unless
    });

    it('should count while and until loops', () => {
      const content = `while x\n  do_a\nend\nuntil y\n  do_b\nend`;
      expect(rubyAdapter.computeComplexity!(content)).toBe(3); // 1 + while + until
    });

    it('should count for loop', () => {
      const content = `for i in items\n  process(i)\nend`;
      expect(rubyAdapter.computeComplexity!(content)).toBe(2); // 1 + for
    });

    it('should count case and when', () => {
      const content = `case type\nwhen :a then do_a\nwhen :b then do_b\nend`;
      expect(rubyAdapter.computeComplexity!(content)).toBe(4); // 1 + case + 2 whens
    });

    it('should count logical operators && and ||', () => {
      const content = `if x && y || z\n  do_a\nend`;
      expect(rubyAdapter.computeComplexity!(content)).toBe(4); // 1 + if + && + ||
    });

    it('should count rescue clauses', () => {
      const content = `begin\n  do_a\nrescue StandardError\n  handle\nrescue => e\n  fallback\nend`;
      expect(rubyAdapter.computeComplexity!(content)).toBe(3); // 1 + 2 rescues
    });

    it('should count ternary operator', () => {
      const content = `result = x > 0 ? 'pos' : 'neg'`;
      expect(rubyAdapter.computeComplexity!(content)).toBe(2); // 1 + ternary
    });

    it('should handle realistic Ruby code', () => {
      const content = `
def process(items)
  return if items.empty?
  items.each do |item|
    if item.active? && item.valid?
      begin
        save(item)
      rescue ActiveRecord::RecordInvalid
        log(item)
      end
    end
  end
end`;
      const complexity = rubyAdapter.computeComplexity!(content);
      expect(complexity).toBeGreaterThanOrEqual(5); // 1 + if + rescue + && + for(each)
    });
  });

  describe('detectTestPair', () => {
    it('should find source file for RSpec *_spec.rb pattern', () => {
      const allPaths = new Set(['app/models/user.rb', 'spec/models/user_spec.rb']);
      expect(rubyAdapter.detectTestPair!('spec/models/user_spec.rb', allPaths)).toBe(
        'app/models/user.rb',
      );
    });

    it('should find source file for Minitest test_*.rb pattern', () => {
      const allPaths = new Set(['lib/utils.rb', 'test/test_utils.rb']);
      expect(rubyAdapter.detectTestPair!('test/test_utils.rb', allPaths)).toBe('lib/utils.rb');
    });

    it('should find source file for Minitest *_test.rb pattern', () => {
      const allPaths = new Set(['lib/utils.rb', 'test/utils_test.rb']);
      expect(rubyAdapter.detectTestPair!('test/utils_test.rb', allPaths)).toBe('lib/utils.rb');
    });

    it('should find RSpec test for a source file', () => {
      const allPaths = new Set(['app/models/user.rb', 'spec/models/user_spec.rb']);
      expect(rubyAdapter.detectTestPair!('app/models/user.rb', allPaths)).toBe(
        'spec/models/user_spec.rb',
      );
    });

    it('should find Minitest test_*.rb for a source file', () => {
      const allPaths = new Set(['lib/utils.rb', 'test/test_utils.rb']);
      expect(rubyAdapter.detectTestPair!('lib/utils.rb', allPaths)).toBe('test/test_utils.rb');
    });

    it('should find Minitest *_test.rb for a source file', () => {
      const allPaths = new Set(['lib/parser.rb', 'test/parser_test.rb']);
      expect(rubyAdapter.detectTestPair!('lib/parser.rb', allPaths)).toBe('test/parser_test.rb');
    });

    it('should prefer RSpec over Minitest when both exist', () => {
      const allPaths = new Set(['lib/utils.rb', 'spec/utils_spec.rb', 'test/test_utils.rb']);
      expect(rubyAdapter.detectTestPair!('lib/utils.rb', allPaths)).toBe('spec/utils_spec.rb');
    });

    it('should return null when no pair exists', () => {
      const allPaths = new Set(['app/models/orphan.rb']);
      expect(rubyAdapter.detectTestPair!('app/models/orphan.rb', allPaths)).toBeNull();
    });
  });

  describe('resolveImport', () => {
    it('should resolve project require to name.rb via suffix match', () => {
      const allPaths = new ReadonlySetWrapper(['lib/utils.rb', 'lib/parser.rb']);
      expect(rubyAdapter.resolveImport!('utils', 'app/main.rb', allPaths)).toBe('lib/utils.rb');
    });

    it('should resolve require_relative with ../ to sibling file', () => {
      const allPaths = new ReadonlySetWrapper([
        'app/models/user.rb',
        'app/services/user_service.rb',
      ]);
      expect(
        rubyAdapter.resolveImport!('../models/user', 'app/services/user_service.rb', allPaths),
      ).toBe('app/models/user.rb');
    });

    it('should resolve require_relative without leading dot via project candidates', () => {
      const allPaths = new ReadonlySetWrapper(['lib/helpers/formatter.rb']);
      expect(rubyAdapter.resolveImport!('formatter', 'app/main.rb', allPaths)).toBe(
        'lib/helpers/formatter.rb',
      );
    });

    it('should resolve name/index.rb when present', () => {
      const allPaths = new ReadonlySetWrapper(['lib/auth/index.rb']);
      expect(rubyAdapter.resolveImport!('auth', 'app/main.rb', allPaths)).toBe('lib/auth/index.rb');
    });

    it('should return null for gems/stdlib not in project', () => {
      const allPaths = new ReadonlySetWrapper(['app/main.rb']);
      expect(rubyAdapter.resolveImport!('json', 'app/main.rb', allPaths)).toBeNull();
    });

    it('should return null for ActiveSupport (gem)', () => {
      const allPaths = new ReadonlySetWrapper(['app/main.rb']);
      expect(rubyAdapter.resolveImport!('active_support', 'app/main.rb', allPaths)).toBeNull();
    });

    it('should project candidates before returning null (ordering)', () => {
      // name.rb exists in project — should return it, not null
      const allPaths = new ReadonlySetWrapper(['lib/json.rb']);
      expect(rubyAdapter.resolveImport!('json', 'app/main.rb', allPaths)).toBe('lib/json.rb');
    });
  });
});

// Minimal ReadonlySet wrapper for test convenience
class ReadonlySetWrapper<T> extends Set<T> implements ReadonlySet<T> {}
