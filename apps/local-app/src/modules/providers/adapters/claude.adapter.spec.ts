import { ClaudeAdapter } from './claude.adapter';

describe('ClaudeAdapter', () => {
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    adapter = new ClaudeAdapter();
  });

  describe('providerName', () => {
    it('returns claude as provider name', () => {
      expect(adapter.providerName).toBe('claude');
    });
  });

  describe('launchInitialPromptBehavior', () => {
    it('exposes preKeys with Enter and preDelayMs of 2000', () => {
      expect(adapter.launchInitialPromptBehavior).toBeDefined();
      expect(adapter.launchInitialPromptBehavior.preKeys).toEqual(['Enter']);
      expect(adapter.launchInitialPromptBehavior.preDelayMs).toBe(2000);
    });
  });

  describe('addMcpServer', () => {
    it('builds command with default alias', () => {
      const args = adapter.addMcpServer({
        endpoint: 'http://127.0.0.1:3000/mcp',
      });

      expect(args).toEqual([
        'mcp',
        'add',
        '--transport',
        'http',
        'claude',
        'http://127.0.0.1:3000/mcp',
      ]);
    });

    it('builds command with custom alias', () => {
      const args = adapter.addMcpServer({
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      expect(args).toEqual([
        'mcp',
        'add',
        '--transport',
        'http',
        'devchain',
        'http://127.0.0.1:3000/mcp',
      ]);
    });

    it('includes extra args when provided', () => {
      const args = adapter.addMcpServer({
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
        extraArgs: ['--force', '--verbose'],
      });

      expect(args).toEqual([
        'mcp',
        'add',
        '--transport',
        'http',
        'devchain',
        'http://127.0.0.1:3000/mcp',
        '--force',
        '--verbose',
      ]);
    });
  });

  describe('listMcpServers', () => {
    it('builds list command', () => {
      const args = adapter.listMcpServers();
      expect(args).toEqual(['mcp', 'list']);
    });
  });

  describe('removeMcpServer', () => {
    it('builds remove command with alias', () => {
      const args = adapter.removeMcpServer('devchain');
      expect(args).toEqual(['mcp', 'remove', 'devchain']);
    });
  });

  describe('binaryCheck', () => {
    it('builds check command with alias', () => {
      const args = adapter.binaryCheck('devchain');
      expect(args).toEqual(['mcp', 'check', 'devchain']);
    });
  });

  describe('buildLaunchArgs', () => {
    it('returns profileOptionArgs unchanged for mode new', () => {
      const result = adapter.buildLaunchArgs({
        mode: 'new',
        profileOptionArgs: ['--model', 'claude-opus-4-5'],
      });
      expect(result.argv).toEqual(['--model', 'claude-opus-4-5']);
    });

    it('returns empty argv for mode new with no profileOptionArgs', () => {
      const result = adapter.buildLaunchArgs({ mode: 'new', profileOptionArgs: [] });
      expect(result.argv).toEqual([]);
    });

    it('prepends --resume and providerSessionId for mode restore', () => {
      const result = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'session-abc',
        profileOptionArgs: ['--model', 'claude-opus-4-5'],
      });
      expect(result.argv).toEqual(['--resume', 'session-abc', '--model', 'claude-opus-4-5']);
    });

    it('restore with no profileOptionArgs yields [--resume, sessionId]', () => {
      const result = adapter.buildLaunchArgs({
        mode: 'restore',
        providerSessionId: 'xyz',
        profileOptionArgs: [],
      });
      expect(result.argv).toEqual(['--resume', 'xyz']);
    });
  });

  describe('parseListOutput', () => {
    it('parses output with single entry', () => {
      const stdout = `Checking MCP server health...

devchain: http://127.0.0.1:3000/mcp (HTTP) - ✓ Connected`;
      const entries = adapter.parseListOutput(stdout);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
        transport: 'HTTP',
      });
    });

    it('parses output with multiple entries', () => {
      const stdout = `Checking MCP server health...

devchain: http://127.0.0.1:3000/mcp (HTTP) - ✓ Connected
server2: http://127.0.0.1:4000/mcp (HTTP) - ✓ Connected`;
      const entries = adapter.parseListOutput(stdout);

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
        transport: 'HTTP',
      });
      expect(entries[1]).toEqual({
        alias: 'server2',
        endpoint: 'http://127.0.0.1:4000/mcp',
        transport: 'HTTP',
      });
    });

    it('skips checking health header', () => {
      const stdout = `Checking MCP server health...

devchain: http://127.0.0.1:3000/mcp (HTTP) - ✓ Connected`;
      const entries = adapter.parseListOutput(stdout);

      expect(entries).toHaveLength(1);
      expect(entries[0].alias).toBe('devchain');
    });

    it('handles empty output', () => {
      const stdout = '';
      const entries = adapter.parseListOutput(stdout);
      expect(entries).toEqual([]);
    });

    it('handles output with empty lines', () => {
      const stdout = `Checking MCP server health...

devchain: http://127.0.0.1:3000/mcp (HTTP) - ✓ Connected

server2: http://127.0.0.1:4000/mcp (HTTP) - ✗ Failed to connect
`;
      const entries = adapter.parseListOutput(stdout);
      expect(entries).toHaveLength(2);
    });

    it('parses entries with failed connection status', () => {
      const stdout = `devchain: http://127.0.0.1:3000/mcp (HTTP) - ✗ Failed to connect`;
      const entries = adapter.parseListOutput(stdout);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
        transport: 'HTTP',
      });
    });
  });
});
