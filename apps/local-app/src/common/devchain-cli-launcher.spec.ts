import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { findDevchainCli, writeDevchainCliLauncher } from './devchain-cli-launcher';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SECRET = 'canary-cli-launcher-91c2';

describe('devchain CLI launcher', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'devchain-cli-launcher-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // Pure path rules over temp layouts: the cheapest layer that sees each install shape.
  it('finds the CLI of the entry script, a packed install, and a source checkout', () => {
    const entry = join(root, 'entry', 'cli.js');
    mkdirSync(join(root, 'entry'));
    writeFileSync(entry, '');
    expect(findDevchainCli(entry, root)).toBe(entry);

    const server = join(root, 'pkg', 'dist', 'server', 'common');
    mkdirSync(server, { recursive: true });
    writeFileSync(join(root, 'pkg', 'dist', 'cli.js'), '');
    expect(findDevchainCli(join(root, 'pkg', 'dist', 'server', 'main.js'), server)).toBe(
      join(root, 'pkg', 'dist', 'cli.js'),
    );

    expect(findDevchainCli(undefined, __dirname)).toBe(join(REPO_ROOT, 'scripts', 'cli.js'));
    expect(findDevchainCli(undefined, root)).toBeNull();
  });

  describe('in a source checkout with no global CLI', () => {
    let server: Server;
    let apiUrl: string;

    beforeAll(async () => {
      server = createServer((request, response) => {
        request.resume();
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ env: { API_TOKEN: SECRET }, files: {} }));
        });
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => new Promise((done) => server.close(done)));

    // A real child process: the launcher, the CLI and the child env meet only there.
    it('runs devchain vault exec through the launcher on PATH', async () => {
      const cli = findDevchainCli(undefined, __dirname);
      expect(cli).not.toBeNull();
      const bin = join(root, 'cli-bin');
      await writeDevchainCliLauncher(bin, cli!);

      const child = spawn(
        'devchain',
        ['vault', 'exec', '--', 'sh', '-c', 'printf "%s" "$API_TOKEN" | wc -c'],
        {
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            HOME: root,
            DEVCHAIN_SESSION_ID: '6f1c2a9e-3b7d-4e21-9a0c-5d8e7f6a1b2c',
            DEVCHAIN_API_URL: apiUrl,
          },
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const status = await new Promise((done) => child.on('close', done));

      expect([status, stdout.trim(), stderr]).toEqual([0, String(SECRET.length), '']);
    }, 20_000);
  });

  it('rewrites the launcher only when its content changes', async () => {
    const bin = join(root, 'bin');
    const file = await writeDevchainCliLauncher(bin, '/opt/devchain/cli.js', '/usr/bin/node');
    const { mtimeMs } = statSync(file);
    await new Promise((done) => setTimeout(done, 20));
    await writeDevchainCliLauncher(bin, '/opt/devchain/cli.js', '/usr/bin/node');
    expect(statSync(file).mtimeMs).toBe(mtimeMs);

    await writeDevchainCliLauncher(bin, '/srv/dev/scripts/cli.js', '/usr/bin/node');
    expect(readFileSync(file, 'utf8')).toContain("'/srv/dev/scripts/cli.js'");
    expect(readdirSync(bin)).toEqual(['devchain']);
  });
});
