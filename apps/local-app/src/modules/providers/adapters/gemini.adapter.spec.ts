import { GeminiAdapter } from './gemini.adapter';

describe('GeminiAdapter', () => {
  let adapter: GeminiAdapter;

  beforeEach(() => {
    adapter = new GeminiAdapter();
  });

  describe('providerName', () => {
    it('returns gemini as provider name', () => {
      expect(adapter.providerName).toBe('gemini');
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
        'devchain',
        'http://127.0.0.1:3000/mcp',
        '--type',
        'http',
      ]);
    });

    it('builds command with custom alias', () => {
      const args = adapter.addMcpServer({
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'myserver',
      });

      expect(args).toEqual([
        'mcp',
        'add',
        'myserver',
        'http://127.0.0.1:3000/mcp',
        '--type',
        'http',
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
        'devchain',
        'http://127.0.0.1:3000/mcp',
        '--type',
        'http',
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
    it('returns list command (no separate check in Gemini)', () => {
      const args = adapter.binaryCheck('devchain');
      expect(args).toEqual(['mcp', 'list']);
    });
  });

  describe('parseListOutput', () => {
    it('parses output with single entry', () => {
      const stdout = `Configured MCP servers:

✓ devchain: http://127.0.0.1:3000/mcp (sse) - Connected`;
      const entries = adapter.parseListOutput(stdout);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
        transport: 'SSE',
      });
    });

    it('parses output with multiple entries', () => {
      const stdout = `Configured MCP servers:

✓ devchain: http://127.0.0.1:3000/mcp (sse) - Connected
✓ server2: http://127.0.0.1:4000/mcp (http) - Connected`;
      const entries = adapter.parseListOutput(stdout);

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
        transport: 'SSE',
      });
      expect(entries[1]).toEqual({
        alias: 'server2',
        endpoint: 'http://127.0.0.1:4000/mcp',
        transport: 'HTTP',
      });
    });

    it('skips configured mcp servers header', () => {
      const stdout = `Configured MCP servers:

✓ devchain: http://127.0.0.1:3000/mcp (sse) - Connected`;
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
      const stdout = `Configured MCP servers:

✓ devchain: http://127.0.0.1:3000/mcp (sse) - Connected

✗ server2: http://127.0.0.1:4000/mcp (sse) - Failed
`;
      const entries = adapter.parseListOutput(stdout);
      expect(entries).toHaveLength(2);
    });

    it('parses entries with failed connection status', () => {
      const stdout = `✗ devchain: http://127.0.0.1:3000/mcp (sse) - Failed`;
      const entries = adapter.parseListOutput(stdout);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
        transport: 'SSE',
      });
    });

    it('parses entries without status prefix', () => {
      const stdout = `devchain: http://127.0.0.1:3000/mcp (sse) - Connected`;
      const entries = adapter.parseListOutput(stdout);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
        transport: 'SSE',
      });
    });
  });
});
