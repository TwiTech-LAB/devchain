import { EventEmitter } from 'events';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { CodexAppServerClient, type CodexAppServerRequest } from './codex-app-server.client';

// Layer: unit with a fake child process. The stdio protocol, the line reader and the process
// limits are the behavior under test; a real `codex app-server` needs a login and the network.
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly kill = jest.fn((signal?: string) => {
    if (signal === 'SIGTERM' && this.exitOnTerm) this.exit();
    return true;
  });
  exitOnTerm = true;
  readonly written: Array<Record<string, unknown>> = [];

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        this.written.push(JSON.parse(line));
      }
    });
  }

  reply(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  exit(): void {
    this.emit('close', 0, null);
  }
}

const spawnMock = jest.fn();
jest.mock('child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
/** The client creates its working directory first, so the spawn comes a few I/O turns later. */
async function started(): Promise<void> {
  while (spawnMock.mock.calls.length === 0) await flush();
}

const REQUEST: CodexAppServerRequest = {
  argv: ['/opt/codex', '-c', 'check_for_update_on_startup=false', 'app-server'],
  env: { PATH: '/usr/bin' },
  method: 'plugin/list',
  params: {},
  timeoutMs: 60_000,
  maxOutputBytes: 64 * 1024 * 1024,
};

describe('CodexAppServerClient', () => {
  let child: FakeChild;
  let dataRoot: string;
  let originalDbPath: string | undefined;
  const client = new CodexAppServerClient();

  /** Starts a request and lets the fake server answer initialize. */
  async function initialized(request: CodexAppServerRequest = REQUEST) {
    const pending = client.request(request);
    await started();
    child.reply({ id: 1, result: { userAgent: 'codex' } });
    await flush();
    return { pending };
  }

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'codex-app-server-'));
    originalDbPath = process.env.DB_PATH;
    process.env.DB_PATH = dataRoot;
    child = new FakeChild();
    spawnMock.mockReset().mockReturnValue(child);
  });

  afterEach(async () => {
    jest.useRealTimers();
    if (originalDbPath === undefined) delete process.env.DB_PATH;
    else process.env.DB_PATH = originalDbPath;
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('spawns the command in a private folder and sends the request only after initialize', async () => {
    const pending = client.request(REQUEST);
    await started();

    const [file, args, options] = spawnMock.mock.calls[0];
    expect(file).toBe('/opt/codex');
    expect(args).toEqual(['-c', 'check_for_update_on_startup=false', 'app-server']);
    expect(options).toMatchObject({
      cwd: join(dataRoot, 'provider-cli', 'codex-app-server'),
      env: { PATH: '/usr/bin' },
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    expect(child.written).toEqual([expect.objectContaining({ id: 1, method: 'initialize' })]);

    child.reply({ method: 'thread/started', params: {} });
    child.reply({ id: 1, result: {} });
    await flush();
    expect(child.written.slice(1)).toEqual([
      { method: 'initialized' },
      { id: 2, method: 'plugin/list', params: {} },
    ]);
    expect(child.stdin.writableEnded).toBe(false);

    child.reply({ id: 2, result: { marketplaces: [] } });
    await expect(pending).resolves.toEqual({ marketplaces: [] });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('reads a reply of several MB that arrives as one line in many chunks', async () => {
    const plugins = Array.from({ length: 20_000 }, (_, index) => ({
      id: `plugin-${index}@market`,
      interface: { shortDescription: `Résumé ${'d'.repeat(200)}` },
    }));
    const line = Buffer.from(`${JSON.stringify({ id: 2, result: { plugins } })}\n`);
    expect(line.length).toBeGreaterThan(4 * 1024 * 1024);
    const { pending } = await initialized();

    // 64 KiB - 1 splits the two-byte "é" across chunk ends.
    for (let offset = 0; offset < line.length; offset += 65_535) {
      child.stdout.write(line.subarray(offset, offset + 65_535));
    }

    const result = (await pending) as { plugins: typeof plugins };
    expect(result.plugins).toHaveLength(20_000);
    expect(result.plugins[19_999]).toEqual(plugins[19_999]);
  });

  it('fails on an error reply', async () => {
    const { pending } = await initialized();
    child.reply({ id: 2, error: { code: -32601, message: 'unknown method' } });

    await expect(pending).rejects.toThrow('codex app-server plugin/list returned an error');
  });

  it('fails when the process exits before the reply', async () => {
    const { pending } = await initialized();
    child.exit();

    await expect(pending).rejects.toThrow('codex app-server plugin/list exited before replying');
  });

  it('kills the process and fails when the output exceeds the limit', async () => {
    const { pending } = await initialized({ ...REQUEST, maxOutputBytes: 1024 });
    child.stdout.write('x'.repeat(1025));

    await expect(pending).rejects.toThrow(
      'codex app-server plugin/list output exceeded the size limit',
    );
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('kills the process with SIGTERM then SIGKILL and fails on a timeout', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    child.exitOnTerm = false;
    const pending = client.request(REQUEST);
    const assertion = expect(pending).rejects.toThrow('codex app-server plugin/list timed out');
    await started();

    jest.advanceTimersByTime(REQUEST.timeoutMs);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

    jest.advanceTimersByTime(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
