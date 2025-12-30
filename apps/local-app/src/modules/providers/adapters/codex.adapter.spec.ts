import { CodexAdapter } from './codex.adapter';

describe('CodexAdapter', () => {
  let adapter: CodexAdapter;

  beforeEach(() => {
    adapter = new CodexAdapter();
  });

  describe('providerName', () => {
    it('returns codex as provider name', () => {
      expect(adapter.providerName).toBe('codex');
    });
  });

  describe('addMcpServer', () => {
    it('builds command with default alias', () => {
      const args = adapter.addMcpServer({
        endpoint: 'http://127.0.0.1:3000/mcp',
      });

      expect(args).toEqual(['mcp', 'add', '--url', 'http://127.0.0.1:3000/mcp', 'codex']);
    });

    it('builds command with custom alias', () => {
      const args = adapter.addMcpServer({
        endpoint: 'http://127.0.0.1:3000/mcp',
        alias: 'devchain',
      });

      expect(args).toEqual(['mcp', 'add', '--url', 'http://127.0.0.1:3000/mcp', 'devchain']);
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
        '--url',
        'http://127.0.0.1:3000/mcp',
        'devchain',
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
      const stdout = 'devchain  http://127.0.0.1:3000/mcp';
      const entries = adapter.parseListOutput(stdout);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
      });
    });

    it('parses output with multiple entries', () => {
      const stdout = `devchain  http://127.0.0.1:3000/mcp
server2  http://127.0.0.1:4000/mcp`;
      const entries = adapter.parseListOutput(stdout);

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        alias: 'devchain',
        endpoint: 'http://127.0.0.1:3000/mcp',
      });
      expect(entries[1]).toEqual({
        alias: 'server2',
        endpoint: 'http://127.0.0.1:4000/mcp',
      });
    });

    it('skips header lines', () => {
      const stdout = `Alias     Endpoint
devchain  http://127.0.0.1:3000/mcp`;
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
      const stdout = `
devchain  http://127.0.0.1:3000/mcp

server2  http://127.0.0.1:4000/mcp
`;
      const entries = adapter.parseListOutput(stdout);
      expect(entries).toHaveLength(2);
    });
  });
});
