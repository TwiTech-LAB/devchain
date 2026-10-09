import { OpencodeAdapter } from './opencode.adapter';
import { ValidationError } from '../../../common/errors/error-types';
import { EnvBuilderError } from '../../sessions/utils/env-builder';

describe('OpencodeAdapter', () => {
  let adapter: OpencodeAdapter;

  beforeEach(() => {
    adapter = new OpencodeAdapter();
  });

  describe('EffortCapability (OPENCODE_CONFIG_CONTENT env overlay)', () => {
    const OVERLAY = 'OPENCODE_CONFIG_CONTENT';

    it('builds the per-model overlay at provider.<pid>.models.<mid>.options.reasoningEffort (compact)', () => {
      const { argv, env } = adapter.applyEffort([], {}, 'high', 'anthropic/claude-x');
      // argv untouched — effort is an env overlay, never a flag
      expect(argv).toEqual([]);
      const value = env[OVERLAY];
      expect(JSON.parse(value)).toEqual({
        provider: {
          anthropic: { models: { 'claude-x': { options: { reasoningEffort: 'high' } } } },
        },
      });
      // compact serialization (env-builder rejects newlines/control chars)
      expect(value).not.toMatch(/\n/);
    });

    it('splits pid on the FIRST slash; mid keeps any remaining slashes', () => {
      const { env } = adapter.applyEffort([], {}, 'low', 'openrouter/anthropic/claude-x');
      expect(JSON.parse(env[OVERLAY])).toEqual({
        provider: {
          openrouter: { models: { 'anthropic/claude-x': { options: { reasoningEffort: 'low' } } } },
        },
      });
    });

    it('deep-merges onto a pre-existing OPENCODE_CONFIG_CONTENT, preserving unrelated keys', () => {
      const existing = JSON.stringify({
        theme: 'tokyonight',
        provider: {
          anthropic: { models: { 'other-model': { options: { reasoningEffort: 'minimal' } } } },
          openai: { models: { 'gpt-x': { options: { reasoningEffort: 'low' } } } },
        },
      });
      const { env } = adapter.applyEffort(
        [],
        { [OVERLAY]: existing },
        'high',
        'anthropic/claude-x',
      );
      expect(JSON.parse(env[OVERLAY])).toEqual({
        theme: 'tokyonight',
        provider: {
          anthropic: {
            models: {
              'other-model': { options: { reasoningEffort: 'minimal' } }, // sibling model preserved
              'claude-x': { options: { reasoningEffort: 'high' } }, // new model added
            },
          },
          openai: { models: { 'gpt-x': { options: { reasoningEffort: 'low' } } } }, // sibling provider preserved
        },
      });
    });

    it('preserves other env vars and does not write any file (argv unchanged, env-only mutation)', () => {
      const { argv, env } = adapter.applyEffort(['--flag'], { FOO: 'bar' }, 'medium', 'a/b');
      expect(argv).toEqual(['--flag']);
      expect(env.FOO).toBe('bar');
      expect(env[OVERLAY]).toBeDefined();
    });

    describe('fail-fast paths', () => {
      it('no effectiveModel while effort active → ValidationError (no silent skip)', () => {
        expect(() => adapter.applyEffort([], {}, 'high', undefined)).toThrow(ValidationError);
        expect(() => adapter.applyEffort([], {}, 'high', undefined)).toThrow(/requires a model/);
      });

      it('bare model without "/" → ValidationError', () => {
        expect(() => adapter.applyEffort([], {}, 'high', 'claude-x')).toThrow(ValidationError);
        expect(() => adapter.applyEffort([], {}, 'high', 'claude-x')).toThrow(
          /provider\/model model format/,
        );
      });

      it('trailing-slash model (empty mid) → ValidationError', () => {
        expect(() => adapter.applyEffort([], {}, 'high', 'anthropic/')).toThrow(ValidationError);
      });

      it('pre-existing OPENCODE_CONFIG_CONTENT that is invalid JSON → EnvBuilderError', () => {
        expect(() => adapter.applyEffort([], { [OVERLAY]: '{not json' }, 'high', 'a/b')).toThrow(
          EnvBuilderError,
        );
      });

      it('pre-existing OPENCODE_CONFIG_CONTENT that is a non-object (array/scalar) → EnvBuilderError', () => {
        expect(() => adapter.applyEffort([], { [OVERLAY]: '[1,2]' }, 'high', 'a/b')).toThrow(
          EnvBuilderError,
        );
        expect(() => adapter.applyEffort([], { [OVERLAY]: '"scalar"' }, 'high', 'a/b')).toThrow(
          EnvBuilderError,
        );
      });

      it('merged result exceeding 32KB → EnvBuilderError (fail fast, actionable)', () => {
        const huge = JSON.stringify({ pad: 'x'.repeat(33000) });
        expect(() => adapter.applyEffort([], { [OVERLAY]: huge }, 'high', 'a/b')).toThrow(
          /exceeds 32KB/,
        );
      });
    });
  });

  describe('terminalOutputBehavior', () => {
    it('opts into the terminal alternate screen (full-screen TUI provider)', () => {
      expect(adapter.terminalOutputBehavior).toEqual({ usesAlternateScreen: true });
    });
  });

  describe('configFileName', () => {
    it('returns opencode.json as config file name', () => {
      expect(adapter.configFileName).toBe('opencode.json');
    });
  });

  describe('config-file MCP command fallbacks', () => {
    it.each(['add', 'remove'] as const)('uses the safe version fallback for %s', (operation) => {
      const result =
        operation === 'add'
          ? adapter.addMcpServer({ endpoint: 'http://127.0.0.1:3000/mcp' })
          : adapter.removeMcpServer('devchain');
      expect(result).toEqual(['--version']);
    });
  });

  describe('listMcpServers', () => {
    it('returns mcp list command', () => {
      expect(adapter.listMcpServers()).toEqual(['mcp', 'list']);
    });
  });

  describe('buildLaunchArgs', () => {
    it('returns profileOptionArgs unchanged for mode new', () => {
      const result = adapter.buildLaunchArgs({
        mode: 'new',
        profileOptionArgs: ['--model', 'gpt-4o'],
      });
      expect(result.argv).toEqual(['--model', 'gpt-4o']);
    });

    it('prepends --session and providerSessionId for mode restore', () => {
      const result = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'session-abc',
        profileOptionArgs: ['--model', 'gpt-4o'],
      });
      expect(result.argv).toEqual(['--session', 'session-abc', '--model', 'gpt-4o']);
    });
  });

  describe('parseListOutput', () => {
    it('returns empty array (fallback, config-file mode reads opencode.json)', () => {
      expect(adapter.parseListOutput('some TUI output')).toEqual([]);
    });
  });

  describe('parseProjectConfig', () => {
    it('parses valid opencode.json with single MCP entry', () => {
      const content = JSON.stringify({
        mcp: {
          devchain: { type: 'remote', url: 'http://127.0.0.1:3000/mcp' },
        },
      });

      const entries = adapter.parseProjectConfig(content);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
        transport: 'REMOTE',
      });
    });

    it('parses valid opencode.json with multiple MCP entries', () => {
      const content = JSON.stringify({
        mcp: {
          devchain: { type: 'remote', url: 'http://127.0.0.1:3000/mcp' },
          other: { type: 'remote', url: 'http://127.0.0.1:4000/mcp' },
        },
      });

      const entries = adapter.parseProjectConfig(content);

      expect(entries).toHaveLength(2);
      expect(entries[0].alias).toBe('devchain');
      expect(entries[1].alias).toBe('other');
    });

    it('defaults transport to REMOTE when type is missing', () => {
      const content = JSON.stringify({
        mcp: {
          devchain: { url: 'http://127.0.0.1:3000/mcp' },
        },
      });

      const entries = adapter.parseProjectConfig(content);

      expect(entries).toHaveLength(1);
      expect(entries[0].transport).toBe('REMOTE');
    });

    it('returns empty array when mcp section is missing', () => {
      const content = JSON.stringify({ model: 'anthropic/claude-sonnet-4-5' });
      expect(adapter.parseProjectConfig(content)).toEqual([]);
    });

    it('returns empty array when mcp section is empty object', () => {
      const content = JSON.stringify({ mcp: {} });
      expect(adapter.parseProjectConfig(content)).toEqual([]);
    });

    it('skips entries without a url field', () => {
      const content = JSON.stringify({
        mcp: {
          valid: { type: 'remote', url: 'http://127.0.0.1:3000/mcp' },
          invalid: { type: 'remote' },
        },
      });

      const entries = adapter.parseProjectConfig(content);

      expect(entries).toHaveLength(1);
      expect(entries[0].alias).toBe('valid');
    });

    it('throws on malformed JSON (caller responsibility)', () => {
      expect(() => adapter.parseProjectConfig('not valid json')).toThrow(SyntaxError);
    });
  });

  describe('buildMcpConfigEntry', () => {
    it('returns correct structure with default alias', () => {
      const result = adapter.buildMcpConfigEntry({
        endpoint: 'http://127.0.0.1:3000/mcp',
      });

      expect(result).toEqual({
        key: 'devchain',
        value: {
          type: 'remote',
          url: 'http://127.0.0.1:3000/mcp',
        },
      });
    });

    it('returns correct structure with custom alias', () => {
      const result = adapter.buildMcpConfigEntry({
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'my-server',
      });

      expect(result).toEqual({
        key: 'my-server',
        value: {
          type: 'remote',
          url: 'http://127.0.0.1:3000/mcp',
        },
      });
    });
  });
});
