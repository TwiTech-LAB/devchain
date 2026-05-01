import { OpencodeAdapter } from './opencode.adapter';

describe('OpencodeAdapter', () => {
  let adapter: OpencodeAdapter;

  beforeEach(() => {
    adapter = new OpencodeAdapter();
  });

  describe('providerName', () => {
    it('returns opencode as provider name', () => {
      expect(adapter.providerName).toBe('opencode');
    });
  });

  describe('mcpMode', () => {
    it('returns project_config as MCP mode', () => {
      expect(adapter.mcpMode).toBe('project_config');
    });
  });

  describe('configFileName', () => {
    it('returns opencode.json as config file name', () => {
      expect(adapter.configFileName).toBe('opencode.json');
    });
  });

  describe('binaryCheck', () => {
    it('returns --version for binary validation', () => {
      expect(adapter.binaryCheck('devchain')).toEqual(['--version']);
    });
  });

  describe('addMcpServer', () => {
    it('returns --version as safe fallback (config-file mode)', () => {
      expect(adapter.addMcpServer({ endpoint: 'http://127.0.0.1:3000/mcp' })).toEqual([
        '--version',
      ]);
    });
  });

  describe('listMcpServers', () => {
    it('returns mcp list command', () => {
      expect(adapter.listMcpServers()).toEqual(['mcp', 'list']);
    });
  });

  describe('removeMcpServer', () => {
    it('returns --version as safe fallback (config-file mode)', () => {
      expect(adapter.removeMcpServer('devchain')).toEqual(['--version']);
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

    it('returns empty argv for mode new with no profileOptionArgs', () => {
      const result = adapter.buildLaunchArgs({ mode: 'new', profileOptionArgs: [] });
      expect(result.argv).toEqual([]);
    });

    it('prepends --session and providerSessionId for mode restore', () => {
      const result = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'session-abc',
        profileOptionArgs: ['--model', 'gpt-4o'],
      });
      expect(result.argv).toEqual(['--session', 'session-abc', '--model', 'gpt-4o']);
    });

    it('restore with no profileOptionArgs yields [--session, sessionId]', () => {
      const result = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'abc',
        profileOptionArgs: [],
      });
      expect(result.argv).toEqual(['--session', 'abc']);
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

    it('uppercases transport type from config', () => {
      const content = JSON.stringify({
        mcp: {
          devchain: { type: 'remote', url: 'http://127.0.0.1:3000/mcp' },
        },
      });

      const entries = adapter.parseProjectConfig(content);
      expect(entries[0].transport).toBe('REMOTE');
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

    it('defaults transport to REMOTE when type is a number', () => {
      const content = JSON.stringify({
        mcp: { devchain: { type: 42, url: 'http://127.0.0.1:3000/mcp' } },
      });
      const entries = adapter.parseProjectConfig(content);
      expect(entries).toHaveLength(1);
      expect(entries[0].transport).toBe('REMOTE');
    });

    it('defaults transport to REMOTE when type is a boolean', () => {
      const content = JSON.stringify({
        mcp: { devchain: { type: true, url: 'http://127.0.0.1:3000/mcp' } },
      });
      const entries = adapter.parseProjectConfig(content);
      expect(entries).toHaveLength(1);
      expect(entries[0].transport).toBe('REMOTE');
    });

    it('defaults transport to REMOTE when type is an object', () => {
      const content = JSON.stringify({
        mcp: { devchain: { type: { nested: true }, url: 'http://127.0.0.1:3000/mcp' } },
      });
      const entries = adapter.parseProjectConfig(content);
      expect(entries).toHaveLength(1);
      expect(entries[0].transport).toBe('REMOTE');
    });

    it('defaults transport to REMOTE when type is null', () => {
      const content = JSON.stringify({
        mcp: { devchain: { type: null, url: 'http://127.0.0.1:3000/mcp' } },
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

    it('returns empty array when mcp is null', () => {
      const content = JSON.stringify({ mcp: null });
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

    it('preserves non-MCP config fields (does not lose them)', () => {
      const content = JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        mcp: {
          devchain: { type: 'remote', url: 'http://127.0.0.1:3000/mcp' },
        },
        tools: { enabled: true },
      });

      // parseProjectConfig only reads MCP — it doesn't modify config
      const entries = adapter.parseProjectConfig(content);
      expect(entries).toHaveLength(1);
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
