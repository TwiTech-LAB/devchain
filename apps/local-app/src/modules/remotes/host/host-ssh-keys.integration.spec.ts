// Layer: HTTP integration with real temp files verifies claim admission, validation,
// key-identity dedup, atomic merging, permissions and symlink refusal without touching
// the developer's SSH directory or the machine's host identity.
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { HostSshKeysController } from './host-ssh-keys.controller';
import { HostSshKeysService, HOST_SSH_HOME } from './host-ssh-keys.service';
import { HostHelperService } from './host-helper.service';
import type { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { resetEnvConfig } from '../../../common/config/env.config';
import { AllExceptionsFilter } from '../../../common/filters/http-exception.filter';

describe('Host SSH public key API', () => {
  let app: NestFastifyApplication;
  let home: string;
  let etcDir: string;
  let savedEtcDir: string | undefined;
  const key = utils.generateKeyPairSync('ed25519').public;
  const other = utils.generateKeyPairSync('rsa', { bits: 2048 }).public;
  const third = utils.generateKeyPairSync('ed25519').public;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'devchain-host-ssh-'));
    etcDir = await mkdtemp(join(tmpdir(), 'devchain-host-etc-'));
    await writeFile(join(etcDir, 'claim.json'), '{"userName":"alice"}');
    savedEtcDir = process.env.DEVCHAIN_HOST_ETC_DIR;
    process.env.DEVCHAIN_HOST_ETC_DIR = etcDir;
    resetEnvConfig();
    const module = await Test.createTestingModule({
      controllers: [HostSshKeysController],
      providers: [
        HostSshKeysService,
        { provide: HOST_SSH_HOME, useValue: home },
        // The claim check never runs helpers; the executor stub only satisfies the type.
        {
          provide: HostHelperService,
          useValue: new HostHelperService({ run: jest.fn() } as unknown as ProcessExecutor),
        },
      ],
    }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
    await rm(etcDir, { recursive: true, force: true });
    if (savedEtcDir === undefined) delete process.env.DEVCHAIN_HOST_ETC_DIR;
    else process.env.DEVCHAIN_HOST_ETC_DIR = savedEtcDir;
    resetEnvConfig();
  });

  const apply = (keys: string[]) =>
    app.inject({ method: 'POST', url: '/api/host/ssh-keys', payload: { keys } });

  it('refuses the route on an instance that is not a claimed VM', async () => {
    await rm(join(etcDir, 'claim.json'), { force: true });
    const response = await apply([key]);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ details: { code: 'NOT_A_HOST' } });
    expect(await readdir(home)).toEqual([]);
  });

  it('creates private paths and atomically merges without duplicate keys on repeat', async () => {
    expect((await apply([key, key])).json()).toEqual({ added: 1 });
    expect((await stat(join(home, '.ssh'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(home, '.ssh', 'authorized_keys'))).mode & 0o777).toBe(0o600);
    const original = `# keep this comment\nfrom="10.0.0.*" ${other}\n${key}`;
    await writeFile(join(home, '.ssh', 'authorized_keys'), original, { mode: 0o644 });
    const response = await apply([key, other, other]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ added: 0 });
    expect(await readFile(join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe(original);
    expect((await apply([third])).json()).toEqual({ added: 1 });
    expect(await readFile(join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe(
      `${original}\n${third}\n`,
    );
    expect((await apply([key, other, third])).json()).toEqual({ added: 0 });
    expect(await readdir(join(home, '.ssh'))).toEqual(['authorized_keys']);
  });

  it('matches a key by type and body, whatever options or comment the line carries', async () => {
    const [type, body] = key.split(' ');
    const original = [
      '# a comment line mentioning ssh-ed25519',
      `from="10.0.0.*" ${key}`,
      `command="echo a, b",no-pty ${type} ${body} pc@example`,
      `command="echo \\"quoted ssh-rsa\\"" ${type} ${body}`,
      `${type}\t${body}\tanother comment`,
      '',
      'not a key at all',
    ].join('\n');
    await mkdir(join(home, '.ssh'));
    await writeFile(join(home, '.ssh', 'authorized_keys'), original, { mode: 0o600 });
    const response = await apply([key, key]);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ added: 0 });
    expect(await readFile(join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe(original);
  });

  it.each(['directory', 'file'])(
    'refuses a symlinked %s and leaves its target intact',
    async (kind) => {
      const outside = join(home, 'outside');
      if (kind === 'directory') {
        await mkdir(outside);
        await symlink(outside, join(home, '.ssh'));
      } else {
        await mkdir(join(home, '.ssh'));
        await writeFile(outside, 'existing');
        await symlink(outside, join(home, '.ssh', 'authorized_keys'));
      }
      expect((await apply([key])).statusCode).toBe(400);
      if (kind === 'directory') expect(await readdir(outside)).toEqual([]);
      else expect(await readFile(outside, 'utf8')).toBe('existing');
    },
  );

  it.each([
    'not a key',
    'ssh-ed25519 AAAA',
    'ssh-rsa !!!',
    `command="echo hi" ${key}`,
    `${key}\n${other}`,
    utils.generateKeyPairSync('ed25519').private,
  ])('rejects invalid key input %# before writing', async (invalid) => {
    expect((await apply([key, invalid])).statusCode).toBe(400);
    expect(await readdir(home)).toEqual([]);
  });

  it('serializes concurrent merges without losing a key', async () => {
    const responses = await Promise.all([apply([key]), apply([other])]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(
      (await readFile(join(home, '.ssh', 'authorized_keys'), 'utf8')).trim().split('\n'),
    ).toEqual(expect.arrayContaining([key, other]));
  });
});
