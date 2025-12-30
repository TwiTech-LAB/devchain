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
