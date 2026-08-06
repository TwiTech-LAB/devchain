import { spawn } from 'child_process';
import { createServer, type Server } from 'http';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON } from '@devchain/shared';
import {
  CANONICAL_DEVCHAIN_STATUS_LINE_COMMAND,
  ClaudeLaunchSettingsMaterializerService,
} from './claude-launch-settings-materializer.service';
import { writeRuntimeContextEndpointDiscovery } from './runtime-context-capture-files';
import { StatusLineHookSchema } from '../hooks/dtos/hook-event.dto';
import { ConflictError, IOError, ValidationError } from '../../common/errors/error-types';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const STATUS_LINE_INPUT = JSON.stringify({
  session_id: 'claude-runtime-1',
  model: { id: 'claude-sonnet-4-6' },
  context_window: { context_window_size: 1_000_000 },
  ignored: { transcript: 'must not be forwarded' },
});

describe('ClaudeLaunchSettingsMaterializerService', () => {
  let tempRoot: string;
  let runtimeRoot: string;
  let projectRoot: string;
  let service: ClaudeLaunchSettingsMaterializerService;
  const servers: Server[] = [];

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'devchain-claude-launch-'));
    runtimeRoot = join(tempRoot, 'runtime context');
    projectRoot = join(tempRoot, 'project root');
    await mkdir(projectRoot, { recursive: true });
    service = new ClaudeLaunchSettingsMaterializerService(runtimeRoot);
  });

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    await rm(tempRoot, { recursive: true, force: true });
  });

  function prepare(
    overrides: Partial<Parameters<ClaudeLaunchSettingsMaterializerService['prepare']>[0]> = {},
    target = service,
  ) {
    return target.prepare({
      providerName: 'claude',
      settingsJson: DEFAULT_CLAUDE_LAUNCH_SETTINGS_JSON,
      profileOptionArgs: ['--model', 'sonnet'],
      providerEnv: null,
      configEnv: null,
      sessionId: SESSION_ID,
      epoch: 'epoch-1',
      projectRootPath: projectRoot,
      ...overrides,
    });
  }

  async function listen(
    onBody?: (body: Record<string, unknown>) => void,
    delayMs = 0,
  ): Promise<string> {
    const server = createServer((request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        if (raw) onBody?.(JSON.parse(raw) as Record<string, unknown>);
        const timer = setTimeout(() => {
          response.statusCode = 200;
          response.end('{}');
        }, delayMs);
        timer.unref();
        response.once('close', () => clearTimeout(timer));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    return `http://127.0.0.1:${address.port}`;
  }

  async function runScript(
    scriptPath: string,
    locatorPath: string,
    input = STATUS_LINE_INPUT,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', [scriptPath], {
        env: { ...process.env, DEVCHAIN_STATUSLINE_LOCATOR: locatorPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
  }

  it('writes valid custom text verbatim to a private immutable revision without capture', async () => {
    const custom = ' \n{\n  "unknownFutureSetting": true\n}\n ';
    const result = await prepare({ settingsJson: custom });

    expect(result.captureEnabled).toBe(false);
    expect(result.optionArgs[0]).toBe('--settings');
    expect(await readFile(result.optionArgs[1], 'utf8')).toBe(custom);
    expect((await stat(result.optionArgs[1])).mode & 0o777).toBe(0o600);
    expect(result.runtimeEnv).toEqual({});

    const repeated = await prepare({ settingsJson: custom });
    expect(repeated.optionArgs[1]).toBe(result.optionArgs[1]);
  });

  it('provisions the exact canonical script and private locator only for the canonical command', async () => {
    const result = await prepare();
    const scriptPath = join(projectRoot, '.claude', 'hooks', 'devchain-statusline.sh');
    const locatorPath = result.runtimeEnv.DEVCHAIN_STATUSLINE_LOCATOR;

    expect(result.captureEnabled).toBe(true);
    expect(locatorPath).toBeTruthy();
    expect((await stat(scriptPath)).mode & 0o777).toBe(0o755);
    expect((await stat(locatorPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(scriptPath, 'utf8')).not.toContain('flock');
    expect(JSON.parse(await readFile(result.optionArgs[1], 'utf8')).statusLine.command).toBe(
      CANONICAL_DEVCHAIN_STATUS_LINE_COMMAND,
    );

    const nearMatch = JSON.stringify({
      statusLine: {
        type: 'command',
        command: '${CLAUDE_PROJECT_DIR}/.claude/hooks/devchain-statusline.sh',
      },
    });
    const customResult = await prepare({ settingsJson: nearMatch });
    expect(customResult.captureEnabled).toBe(false);
    expect(customResult.runtimeEnv).toEqual({});
  });

  it.each([
    ['non-Claude provider', { providerName: 'codex' }],
    ['provider alternate endpoint', { providerEnv: { ANTHROPIC_BASE_URL: 'https://glm.test' } }],
    ['config alternate endpoint', { configEnv: { ANTHROPIC_BASE_URL: 'https://custom.test' } }],
    ['two-token profile settings', { profileOptionArgs: ['--settings', 'user.json'] }],
    ['equals profile settings', { profileOptionArgs: ['--settings=user.json'] }],
    ['ambiguous trailing profile flag', { profileOptionArgs: ['--verbose', '--settings'] }],
    ['explicit null opt-out', { settingsJson: null }],
    ['invalid stored JSON', { settingsJson: '[]' }],
  ])('leaves the launch untouched for %s', async (_label, overrides) => {
    await expect(prepare(overrides)).resolves.toEqual({
      optionArgs: [],
      runtimeEnv: {},
      captureEnabled: false,
    });
  });

  it('fails open when the project status-line script cannot be materialized', async () => {
    const projectFile = join(tempRoot, 'not-a-directory');
    await writeFile(projectFile, 'occupied');

    await expect(prepare({ projectRootPath: projectFile })).resolves.toEqual({
      optionArgs: [],
      runtimeEnv: {},
      captureEnabled: false,
    });
  });

  it('merges sparse policy over valid direct-Claude settings and preserves unmatched keys', async () => {
    const settingsJson = JSON.stringify({
      tui: 'default',
      statusLine: {
        type: 'command',
        command: CANONICAL_DEVCHAIN_STATUS_LINE_COMMAND,
      },
      enabledPlugins: {
        'base-only@marketplace': true,
        'overridden@marketplace': false,
      },
      futureSetting: { preserved: true },
    });

    const result = await prepare({
      settingsJson,
      pluginPolicy: [
        { pluginId: 'overridden@marketplace', enabled: true },
        { pluginId: 'removed-plugin@old-marketplace', enabled: false },
      ],
      policyRequired: true,
    });
    const materialized = JSON.parse(await readFile(result.optionArgs[1], 'utf8')) as Record<
      string,
      unknown
    >;

    expect(result.captureEnabled).toBe(true);
    expect(materialized).toEqual({
      tui: 'default',
      statusLine: {
        type: 'command',
        command: CANONICAL_DEVCHAIN_STATUS_LINE_COMMAND,
      },
      enabledPlugins: {
        'base-only@marketplace': true,
        'overridden@marketplace': true,
        'removed-plugin@old-marketplace': false,
      },
      futureSetting: { preserved: true },
    });
    const repeated = await prepare({
      settingsJson,
      pluginPolicy: [
        { pluginId: 'overridden@marketplace', enabled: true },
        { pluginId: 'removed-plugin@old-marketplace', enabled: false },
      ],
      policyRequired: true,
    });
    expect(repeated.optionArgs[1]).toBe(result.optionArgs[1]);
  });

  it.each([
    ['explicit-null settings', { settingsJson: null }],
    ['alternate base URL', { configEnv: { ANTHROPIC_BASE_URL: 'https://alternate.example' } }],
  ])('uses an enabledPlugins-only base for %s', async (_label, overrides) => {
    const result = await prepare({
      ...overrides,
      pluginPolicy: [{ pluginId: 'plugin@marketplace', enabled: true }],
      policyRequired: true,
    });
    const materialized = JSON.parse(await readFile(result.optionArgs[1], 'utf8'));

    expect(materialized).toEqual({ enabledPlugins: { 'plugin@marketplace': true } });
    expect(result).toMatchObject({ runtimeEnv: {}, captureEnabled: false });
  });

  it.each([[['--settings', 'user.json']], [['--settings=user.json']], [['--settings']]])(
    'rejects profile-owned settings when explicit policy is required',
    async (profileOptionArgs) => {
      await expect(
        prepare({
          profileOptionArgs,
          pluginPolicy: [{ pluginId: 'plugin@marketplace', enabled: true }],
          policyRequired: true,
        }),
      ).rejects.toBeInstanceOf(ConflictError);
    },
  );

  it('fails closed when required policy settings cannot be validated or written', async () => {
    await expect(
      prepare({
        settingsJson: '[]',
        pluginPolicy: [{ pluginId: 'plugin@marketplace', enabled: true }],
        policyRequired: true,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const oversizedPolicy = Array.from({ length: 70 }, (_, index) => ({
      pluginId: `${index}-${'x'.repeat(500)}`,
      enabled: true,
    }));
    await expect(
      prepare({ settingsJson: '{}', pluginPolicy: oversizedPolicy, policyRequired: true }),
    ).rejects.toBeInstanceOf(ValidationError);

    const blockedRoot = join(tempRoot, 'blocked-runtime-root');
    await writeFile(blockedRoot, 'occupied');
    const blockedService = new ClaudeLaunchSettingsMaterializerService(blockedRoot);
    await expect(
      prepare(
        {
          settingsJson: null,
          pluginPolicy: [{ pluginId: 'plugin@marketplace', enabled: true }],
          policyRequired: true,
        },
        blockedService,
      ),
    ).rejects.toBeInstanceOf(IOError);
  });

  it('keeps required plugin policy active when status capture materialization fails', async () => {
    const projectFile = join(tempRoot, 'not-a-project-directory');
    await writeFile(projectFile, 'occupied');

    const result = await prepare({
      projectRootPath: projectFile,
      pluginPolicy: [{ pluginId: 'plugin@marketplace', enabled: false }],
      policyRequired: true,
    });
    const materialized = JSON.parse(await readFile(result.optionArgs[1], 'utf8')) as {
      enabledPlugins: Record<string, boolean>;
    };

    expect(result).toMatchObject({ runtimeEnv: {}, captureEnabled: false });
    expect(result.optionArgs[0]).toBe('--settings');
    expect(materialized.enabledPlugins).toEqual({ 'plugin@marketplace': false });
  });

  it('preserves legacy fail-open behavior when no policy settings revision can be written', async () => {
    const blockedRoot = join(tempRoot, 'legacy-blocked-runtime-root');
    await writeFile(blockedRoot, 'occupied');
    const blockedService = new ClaudeLaunchSettingsMaterializerService(blockedRoot);

    await expect(prepare({}, blockedService)).resolves.toEqual({
      optionArgs: [],
      runtimeEnv: {},
      captureEnabled: false,
    });
  });

  it('posts only the strict capture payload, increments sequence, and rereads endpoint discovery', async () => {
    const firstBodies: Record<string, unknown>[] = [];
    const secondBodies: Record<string, unknown>[] = [];
    const firstUrl = await listen((body) => firstBodies.push(body));
    const secondUrl = await listen((body) => secondBodies.push(body));
    await writeRuntimeContextEndpointDiscovery(firstUrl, runtimeRoot);
    const result = await prepare();
    const locatorPath = result.runtimeEnv.DEVCHAIN_STATUSLINE_LOCATOR;
    const scriptPath = join(projectRoot, '.claude', 'hooks', 'devchain-statusline.sh');

    const firstRun = await runScript(scriptPath, locatorPath);
    await writeRuntimeContextEndpointDiscovery(secondUrl, runtimeRoot);
    const secondRun = await runScript(scriptPath, locatorPath);

    expect(firstRun).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(secondRun).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(firstBodies).toEqual([
      {
        hookEventName: 'StatusLine',
        sessionId: SESSION_ID,
        epoch: 'epoch-1',
        sequence: 1,
        claudeSessionId: 'claude-runtime-1',
        modelId: 'claude-sonnet-4-6',
        contextWindowTokens: 1_000_000,
      },
    ]);
    expect(StatusLineHookSchema.safeParse(firstBodies[0]).success).toBe(true);
    expect(secondBodies[0]).toEqual({ ...firstBodies[0], sequence: 2 });
    const locator = JSON.parse(await readFile(locatorPath, 'utf8')) as { counterPath: string };
    expect((await stat(locator.counterPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(runtimeRoot, 'endpoint.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(runtimeRoot)).mode & 0o777).toBe(0o700);
  });

  it('is silent and successful for old/missing fields and endpoint outages', async () => {
    const result = await prepare();
    const locatorPath = result.runtimeEnv.DEVCHAIN_STATUSLINE_LOCATOR;
    const scriptPath = join(projectRoot, '.claude', 'hooks', 'devchain-statusline.sh');

    await expect(
      runScript(
        scriptPath,
        locatorPath,
        JSON.stringify({ session_id: 'old-claude', model: { id: 'claude' } }),
      ),
    ).resolves.toEqual({ code: 0, stdout: '', stderr: '' });

    await writeRuntimeContextEndpointDiscovery('http://127.0.0.1:1', runtimeRoot);
    await expect(runScript(scriptPath, locatorPath)).resolves.toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
  });

  it('recovers a stale lock, rejects concurrent posts, and removes per-session artifacts', async () => {
    const bodies: Record<string, unknown>[] = [];
    const apiUrl = await listen((body) => bodies.push(body), 250);
    await writeRuntimeContextEndpointDiscovery(apiUrl, runtimeRoot);
    const result = await prepare();
    const locatorPath = result.runtimeEnv.DEVCHAIN_STATUSLINE_LOCATOR;
    const locator = JSON.parse(await readFile(locatorPath, 'utf8')) as {
      counterPath: string;
      lockPath: string;
    };
    const scriptPath = join(projectRoot, '.claude', 'hooks', 'devchain-statusline.sh');

    await mkdir(locator.lockPath, { mode: 0o700 });
    const stale = new Date(Date.now() - 20_000);
    await utimes(locator.lockPath, stale, stale);
    await runScript(scriptPath, locatorPath);

    await Promise.all([runScript(scriptPath, locatorPath), runScript(scriptPath, locatorPath)]);
    expect(bodies).toHaveLength(2);

    await service.cleanupSession(SESSION_ID);
    await expect(stat(locatorPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(locator.counterPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(locator.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('forwards cancellation to the single-flight worker and releases its lock', async () => {
    const bodies: Record<string, unknown>[] = [];
    const apiUrl = await listen((body) => bodies.push(body), 1_000);
    await writeRuntimeContextEndpointDiscovery(apiUrl, runtimeRoot);
    const result = await prepare();
    const locatorPath = result.runtimeEnv.DEVCHAIN_STATUSLINE_LOCATOR;
    const locator = JSON.parse(await readFile(locatorPath, 'utf8')) as { lockPath: string };
    const scriptPath = join(projectRoot, '.claude', 'hooks', 'devchain-statusline.sh');

    const child = spawn('/bin/sh', [scriptPath], {
      env: { ...process.env, DEVCHAIN_STATUSLINE_LOCATOR: locatorPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end(STATUS_LINE_INPUT);
    for (let attempt = 0; attempt < 100 && bodies.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(bodies).toHaveLength(1);

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    await expect(stat(locator.lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
