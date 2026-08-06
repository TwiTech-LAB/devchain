import { createHash } from 'crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { spawn, spawnSync } from 'child_process';
import { CodexAdapter } from '../providers/adapters/codex.adapter';
import {
  CODEX_PROFILE_HELPER_SOURCE,
  CodexPluginProfileMaterializerService,
  type PreparedCodexPluginProfile,
} from './codex-plugin-profile-materializer.service';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = 'session-11111111';
const NONCE = 'attempt_nonce_1234567890abcdef';

describe('CodexPluginProfileMaterializerService (unit)', () => {
  let temporaryRoot: string;
  let privateRoot: string;
  let service: CodexPluginProfileMaterializerService;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'devchain-codex-profile-unit-'));
    privateRoot = join(temporaryRoot, 'private');
    service = new CodexPluginProfileMaterializerService(privateRoot);
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  it('serializes only explicit rules in stable plugin-ID order', () => {
    expect(
      service.serializePolicy([
        { pluginId: 'zeta@market', enabled: false },
        { pluginId: 'a"b\\c@market', enabled: true },
      ]),
    ).toBe(
      '[plugins."a\\"b\\\\c@market"]\nenabled = true\n\n' +
        '[plugins."zeta@market"]\nenabled = false\n',
    );
  });

  it('rejects invalid and duplicate opaque plugin IDs', () => {
    expect(() =>
      service.serializePolicy([
        { pluginId: 'duplicate@market', enabled: true },
        { pluginId: 'duplicate@market', enabled: false },
      ]),
    ).toThrow('duplicate plugin IDs');
    expect(() => service.serializePolicy([{ pluginId: 'bad\nplugin', enabled: true }])).toThrow(
      'entry is invalid',
    );
  });

  it('returns no artifacts when no explicit policy exists', async () => {
    await expect(
      service.prepare({
        projectId: PROJECT_ID,
        projectName: 'No Policy',
        sessionId: SESSION_ID,
        pluginPolicy: [],
        attemptNonce: NONCE,
      }),
    ).resolves.toBeNull();
    await expect(stat(privateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('builds path-safe bounded names with project collision and policy revision digests', async () => {
    const policy = [{ pluginId: 'gmail@openai-curated', enabled: false }];
    const first = await prepare(service, {
      projectId: PROJECT_ID,
      projectName: '../../Málaga Project !'.repeat(20),
      pluginPolicy: policy,
    });
    const reordered = await prepare(service, {
      projectId: PROJECT_ID,
      projectName: '../../Málaga Project !'.repeat(20),
      pluginPolicy: [...policy].reverse(),
      nonce: 'attempt_nonce_abcdef1234567890',
    });
    const sameNameOtherProject = await prepare(service, {
      projectId: '22222222-2222-4222-8222-222222222222',
      projectName: '../../Málaga Project !'.repeat(20),
      pluginPolicy: policy,
      nonce: 'attempt_nonce_fedcba0987654321',
    });
    const changedPolicy = await prepare(service, {
      projectId: PROJECT_ID,
      projectName: '../../Málaga Project !'.repeat(20),
      pluginPolicy: [{ pluginId: 'gmail@openai-curated', enabled: true }],
      nonce: 'attempt_nonce_0011223344556677',
    });

    expect(first.profileName).toMatch(
      /^devchain-malaga-project-[a-z0-9-]*-[0-9a-f]{16}-[0-9a-f]{64}$/,
    );
    expect(first.profileName.length).toBeLessThanOrEqual(255);
    expect(reordered.profileName).toBe(first.profileName);
    expect(reordered.sourceRevisionPath).toBe(first.sourceRevisionPath);
    expect(sameNameOtherProject.profileName).not.toBe(first.profileName);
    expect(changedPolicy.profileName).not.toBe(first.profileName);
    expect(first.providerOptionArgs).toEqual(['--profile', first.profileName]);
  });

  it('materializes immutable private source and executable helper revisions', async () => {
    const prepared = await prepare(service);
    const source = await readFile(prepared.sourceRevisionPath, 'utf8');
    const helper = await readFile(prepared.helperPath, 'utf8');

    expect(createHash('sha256').update(source).digest('hex')).toBe(prepared.policyHash);
    expect(helper.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect((await stat(prepared.sourceRevisionPath)).mode & 0o777).toBe(0o600);
    expect((await stat(prepared.helperPath)).mode & 0o777).toBe(0o700);
    expect((await stat(dirname(prepared.helperPath))).mode & 0o777).toBe(0o700);
  });

  it('publishes attempt proof inside the target lock before release and provider exec', () => {
    const orderedStatements = [
      'const targetLock = acquireTargetLock',
      'writeExclusive(locatorPath',
      'writeExclusive(acknowledgementPath',
      '} finally {',
      'targetLock.release()',
      'process.execve(',
    ];
    const indexes: number[] = [];
    let cursor = 0;
    for (const statement of orderedStatements) {
      const index = CODEX_PROFILE_HELPER_SOURCE.indexOf(statement, cursor);
      indexes.push(index);
      cursor = index + statement.length;
    }

    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
  });

  it.each([
    {
      mode: 'new' as const,
      sessionId: undefined,
      extraArgs: ['--model', 'model with spaces', '--search'],
    },
    {
      mode: 'restore' as const,
      sessionId: '019c0000-0000-7000-8000-000000000001',
      extraArgs: ['--model', 'model with spaces'],
    },
  ])('atomically materializes and execs exact $mode Codex argv', async (testCase) => {
    const prepared = await prepare(service, {
      nonce:
        testCase.mode === 'new' ? 'attempt_nonce_new_1234567890' : 'attempt_nonce_restore_123456',
    });
    const fakeCodex = await createFakeCodex(temporaryRoot, 'absolute-codex');
    const adapter = new CodexAdapter();
    const expectedArgv = adapter.buildLaunchArgs({
      mode: testCase.mode,
      providerSessionId: testCase.sessionId,
      profileOptionArgs: [...prepared.providerOptionArgs, ...testCase.extraArgs],
    }).argv;
    const codexHome = join(temporaryRoot, `codex-home-${testCase.mode}`);
    const projectRoot = join(temporaryRoot, `project-${testCase.mode}`);
    const baseConfig = 'model = "base-model"\n';
    const projectConfig = 'model_reasoning_effort = "high"\n';
    await mkdir(join(projectRoot, '.codex'), { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'config.toml'), baseConfig);
    await writeFile(join(projectRoot, '.codex', 'config.toml'), projectConfig);

    for (const attemptPath of [
      prepared.referencePath,
      prepared.locatorPath,
      prepared.acknowledgementPath,
    ]) {
      await expect(stat(attemptPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }

    const canonicalTargetPath = join(codexHome, `${prepared.profileName}.config.toml`);
    const targetLockPath = join(
      privateRoot,
      'locks',
      `${createHash('sha256').update(canonicalTargetPath).digest('hex')}.lock`,
    );
    const attemptNonce =
      testCase.mode === 'new' ? 'attempt_nonce_new_1234567890' : 'attempt_nonce_restore_123456';

    const helperArgv = service.buildHelperArgv(prepared, fakeCodex, expectedArgv, {
      projectId: PROJECT_ID,
      attemptNonce,
    });
    const result = spawnSync(helperArgv[0], helperArgv.slice(1), {
      cwd: projectRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        DEVCHAIN_TEST_ACK_PATH: prepared.acknowledgementPath,
        DEVCHAIN_TEST_LOCATOR_PATH: prepared.locatorPath,
        DEVCHAIN_TEST_TARGET_LOCK_PATH: targetLockPath,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      argv: expectedArgv,
      attemptProofAtExec: {
        acknowledgementExists: true,
        locatorExists: true,
        targetLockExists: false,
        nonce: attemptNonce,
      },
    });
    expect(await readFile(join(codexHome, `${prepared.profileName}.config.toml`), 'utf8')).toBe(
      await readFile(prepared.sourceRevisionPath, 'utf8'),
    );
    expect(await readFile(join(codexHome, 'config.toml'), 'utf8')).toBe(baseConfig);
    expect(await readFile(join(projectRoot, '.codex', 'config.toml'), 'utf8')).toBe(projectConfig);

    const acknowledgement = JSON.parse(await readFile(prepared.acknowledgementPath, 'utf8'));
    const reference = JSON.parse(await readFile(prepared.referencePath, 'utf8'));
    expect(acknowledgement).toEqual({
      version: 1,
      canonicalTargetPath,
      projectId: PROJECT_ID,
      projectDigest: prepared.projectDigest,
      sessionId: SESSION_ID,
      profileName: prepared.profileName,
      policyHash: prepared.policyHash,
      nonce: attemptNonce,
    });
    expect(reference).toEqual({
      ...acknowledgement,
      acknowledgementPath: prepared.acknowledgementPath,
      locatorPath: prepared.locatorPath,
    });
    expect(JSON.parse(await readFile(prepared.locatorPath, 'utf8'))).toMatchObject({
      ...acknowledgement,
      referencePath: prepared.referencePath,
      acknowledgementPath: prepared.acknowledgementPath,
    });
    await expect(
      service.awaitAcknowledgement(prepared, { projectId: PROJECT_ID, attemptNonce }),
    ).resolves.toBe(canonicalTargetPath);

    await service.cleanupPrepared(prepared);
    for (const attemptPath of [
      prepared.referencePath,
      prepared.locatorPath,
      prepared.acknowledgementPath,
    ]) {
      await expect(stat(attemptPath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('resolves a bare Codex binary from the inherited PATH', async () => {
    const prepared = await prepare(service);
    const binRoot = join(temporaryRoot, 'bin');
    await createFakeCodex(binRoot, 'codex-contract');
    const helperArgv = service.buildHelperArgv(prepared, 'codex-contract', ['--version'], {
      projectId: PROJECT_ID,
      attemptNonce: NONCE,
    });
    const result = spawnSync(helperArgv[0], helperArgv.slice(1), {
      env: {
        ...process.env,
        CODEX_HOME: join(temporaryRoot, 'bare-home'),
        PATH: `${binRoot}:${process.env.PATH ?? ''}`,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ argv: ['--version'] });
  });

  it('falls back to the inherited HOME/.codex when CODEX_HOME is absent', async () => {
    const prepared = await prepare(service);
    const fakeCodex = await createFakeCodex(temporaryRoot, 'home-fallback-codex');
    const inheritedHome = join(temporaryRoot, 'inherited-home');
    const helperArgv = service.buildHelperArgv(prepared, fakeCodex, [], {
      projectId: PROJECT_ID,
      attemptNonce: NONCE,
    });
    const childEnvironment = { ...process.env, HOME: inheritedHome };
    delete childEnvironment.CODEX_HOME;
    const result = spawnSync(helperArgv[0], helperArgv.slice(1), {
      env: childEnvironment,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    await expect(
      stat(join(inheritedHome, '.codex', `${prepared.profileName}.config.toml`)),
    ).resolves.toBeDefined();
  });

  it('reuses the same immutable target for a later attempt with the same project policy', async () => {
    const first = await prepare(service);
    const secondNonce = 'attempt_nonce_second_123456789';
    const second = await prepare(service, { nonce: secondNonce });
    const fakeCodex = await createFakeCodex(temporaryRoot, 'reuse-codex');
    const codexHome = join(temporaryRoot, 'reuse-home');

    for (const [prepared, nonce] of [
      [first, NONCE],
      [second, secondNonce],
    ] as const) {
      const helperArgv = service.buildHelperArgv(prepared, fakeCodex, [], {
        projectId: PROJECT_ID,
        attemptNonce: nonce,
      });
      const result = spawnSync(helperArgv[0], helperArgv.slice(1), {
        env: { ...process.env, CODEX_HOME: codexHome },
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
    }

    expect(second.profileName).toBe(first.profileName);
    expect(second.sourceRevisionPath).toBe(first.sourceRevisionPath);
    expect(second.acknowledgementPath).not.toBe(first.acknowledgementPath);
    expect(second.locatorPath).not.toBe(first.locatorPath);
    expect(second.referencePath).not.toBe(first.referencePath);
    expect(await readFile(join(codexHome, `${first.profileName}.config.toml`), 'utf8')).toBe(
      await readFile(first.sourceRevisionPath, 'utf8'),
    );
  });

  it('serializes a same-target launch racing cleanup and preserves the live reference', async () => {
    const first = await prepare(service);
    const second = await prepare(service, {
      nonce: 'attempt_nonce_racing_123456789',
      sessionId: 'session-22222222',
    });
    const fakeCodex = await createFakeCodex(temporaryRoot, 'racing-codex');
    const codexHome = join(temporaryRoot, 'racing-home');
    const firstArgv = service.buildHelperArgv(first, fakeCodex, [], {
      projectId: PROJECT_ID,
      attemptNonce: first.attemptNonce,
    });
    const secondArgv = service.buildHelperArgv(second, fakeCodex, [], {
      projectId: PROJECT_ID,
      attemptNonce: second.attemptNonce,
    });
    await runHelper(firstArgv, codexHome);

    await Promise.all([runHelper(secondArgv, codexHome), service.cleanupPrepared(first)]);

    const target = join(codexHome, first.profileName + '.config.toml');
    await expect(stat(target)).resolves.toBeDefined();
    await expect(stat(second.referencePath)).resolves.toBeDefined();
    await service.reconcileStartup(new Set());
    await expect(stat(target)).resolves.toBeDefined();
    await service.reconcileStartup(new Set(['session-22222222']));
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a foreign acknowledgement and locator instead of accepting stale proof', async () => {
    const prepared = await prepare(service);
    const foreign = {
      version: 1,
      canonicalTargetPath: join(temporaryRoot, 'foreign.config.toml'),
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      projectDigest: prepared.projectDigest,
      profileName: prepared.profileName,
      policyHash: prepared.policyHash,
      nonce: 'foreign_nonce_1234567890',
    };
    await writeFile(prepared.acknowledgementPath, JSON.stringify(foreign));
    await writeFile(
      prepared.locatorPath,
      JSON.stringify({
        ...foreign,
        referencePath: prepared.referencePath,
        acknowledgementPath: prepared.acknowledgementPath,
        markerPath: join(privateRoot, 'targets', 'foreign.target.json'),
        lockKey: 'c'.repeat(64),
      }),
    );

    await expect(
      service.awaitAcknowledgement(
        prepared,
        { projectId: PROJECT_ID, attemptNonce: prepared.attemptNonce },
        50,
      ),
    ).rejects.toThrow('does not match');
  });

  it('fails closed when a live target lock cannot be acquired', async () => {
    const prepared = await prepare(service);
    const fakeCodex = await createFakeCodex(temporaryRoot, 'locked-codex');
    const codexHome = join(temporaryRoot, 'locked-home');
    const target = join(codexHome, prepared.profileName + '.config.toml');
    const lockKey = createHash('sha256').update(target).digest('hex');
    const lockPath = join(privateRoot, 'locks', lockKey + '.lock');
    const processStat = await readFile('/proc/' + process.pid + '/stat', 'utf8');
    const startIdentity = processStat
      .slice(processStat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)[19];
    await mkdir(lockPath);
    await writeFile(
      join(lockPath, 'owner.json'),
      JSON.stringify({ version: 1, pid: process.pid, startIdentity, attemptNonce: 'live-owner' }),
    );
    const helperArgv = service.buildHelperArgv(prepared, fakeCodex, [], {
      projectId: PROJECT_ID,
      attemptNonce: prepared.attemptNonce,
    });

    const result = spawnSync(helperArgv[0], helperArgv.slice(1), {
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8',
      timeout: 7_000,
    });

    expect(result.status).toBe(78);
    expect(result.stderr).toBe('DEVCHAIN_CODEX_PROFILE_ERROR:lock_timeout\n');
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 10_000);

  it('refuses source hash mismatches without exposing inherited environment values', async () => {
    const prepared = await prepare(service);
    const fakeCodex = await createFakeCodex(temporaryRoot, 'tamper-codex');
    await writeFile(prepared.sourceRevisionPath, 'tampered = true\n');
    const helperArgv = service.buildHelperArgv(prepared, fakeCodex, [], {
      projectId: PROJECT_ID,
      attemptNonce: NONCE,
    });
    const result = spawnSync(helperArgv[0], helperArgv.slice(1), {
      env: {
        ...process.env,
        CODEX_HOME: join(temporaryRoot, 'tampered-home'),
        DEVCHAIN_TEST_SECRET: 'must-not-appear',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(78);
    expect(result.stderr).toBe('DEVCHAIN_CODEX_PROFILE_ERROR:source_hash_mismatch\n');
    expect(result.stderr).not.toContain('must-not-appear');
    await expect(stat(prepared.acknowledgementPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses profile-name path escape before creating a target', async () => {
    const prepared = await prepare(service);
    const fakeCodex = await createFakeCodex(temporaryRoot, 'escape-codex');
    const helperArgv = service.buildHelperArgv(prepared, fakeCodex, [], {
      projectId: PROJECT_ID,
      attemptNonce: NONCE,
    });
    helperArgv[helperArgv.indexOf('--profile') + 1] = '../escaped';
    const codexHome = join(temporaryRoot, 'escape-home');
    const result = spawnSync(helperArgv[0], helperArgv.slice(1), {
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8',
    });

    expect(result.status).toBe(78);
    expect(result.stderr).toBe('DEVCHAIN_CODEX_PROFILE_ERROR:invalid_profile_name\n');
    await expect(stat(join(temporaryRoot, 'escaped.config.toml'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('refuses to overwrite an existing mismatched target profile', async () => {
    const prepared = await prepare(service);
    const fakeCodex = await createFakeCodex(temporaryRoot, 'mismatch-codex');
    const codexHome = join(temporaryRoot, 'mismatch-home');
    const target = join(codexHome, `${prepared.profileName}.config.toml`);
    await mkdir(codexHome, { recursive: true });
    await writeFile(target, 'foreign = true\n');
    const helperArgv = service.buildHelperArgv(prepared, fakeCodex, [], {
      projectId: PROJECT_ID,
      attemptNonce: NONCE,
    });
    const result = spawnSync(helperArgv[0], helperArgv.slice(1), {
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: 'utf8',
    });

    expect(result.status).toBe(78);
    expect(result.stderr).toBe('DEVCHAIN_CODEX_PROFILE_ERROR:profile_content_mismatch\n');
    expect(await readFile(target, 'utf8')).toBe('foreign = true\n');
  });
});

async function prepare(
  service: CodexPluginProfileMaterializerService,
  overrides: {
    projectId?: string;
    projectName?: string;
    pluginPolicy?: Array<{ pluginId: string; enabled: boolean }>;
    nonce?: string;
    sessionId?: string;
  } = {},
): Promise<PreparedCodexPluginProfile> {
  const prepared = await service.prepare({
    projectId: overrides.projectId ?? PROJECT_ID,
    projectName: overrides.projectName ?? 'DevChain Project',
    sessionId: overrides.sessionId ?? SESSION_ID,
    pluginPolicy: overrides.pluginPolicy ?? [{ pluginId: 'gmail@openai-curated', enabled: false }],
    attemptNonce: overrides.nonce ?? NONCE,
  });
  if (!prepared) throw new Error('Expected a prepared Codex plugin profile');
  return prepared;
}

async function createFakeCodex(root: string, name: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const path = join(root, name);
  await writeFile(
    path,
    `#!/usr/bin/env node
const fs = require('fs');
const result = { argv: process.argv.slice(2) };
if (process.env.DEVCHAIN_TEST_ACK_PATH) {
  const acknowledgement = JSON.parse(fs.readFileSync(process.env.DEVCHAIN_TEST_ACK_PATH, 'utf8'));
  result.attemptProofAtExec = {
    acknowledgementExists: fs.existsSync(process.env.DEVCHAIN_TEST_ACK_PATH),
    locatorExists: fs.existsSync(process.env.DEVCHAIN_TEST_LOCATOR_PATH),
    targetLockExists: fs.existsSync(process.env.DEVCHAIN_TEST_TARGET_LOCK_PATH),
    nonce: acknowledgement.nonce,
  };
}
process.stdout.write(JSON.stringify(result));
`,
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
  return path;
}

async function runHelper(argv: string[], codexHome: string): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: 'ignore',
    });
    child.once('error', rejectRun);
    child.once('exit', (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error('Helper exited with status ' + code));
    });
  });
}
