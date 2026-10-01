/**
 * DevChain's calls into the host VM's root helpers.
 * Test layer: service unit — `sudo` runs through a stubbed process executor and the claim
 * directory a temp dir; the helpers themselves are tested in apps/host-bootstrap.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetEnvConfig } from '../../../common/config/env.config';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} from '../../../common/errors/error-types';
import type { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { HostHelperService } from './host-helper.service';

const run = jest.fn();

function helperAnswers(stdout: string, exit?: { code: number; stderr: string }): void {
  run.mockResolvedValue({
    success: !exit,
    exitCode: exit ? exit.code : 0,
    stdout,
    stderr: exit?.stderr ?? '',
    timedOut: false,
    truncated: false,
  });
}

describe('HostHelperService', () => {
  let etcDir: string;
  let service: HostHelperService;

  beforeEach(() => {
    etcDir = mkdtempSync(join(tmpdir(), 'devchain-host-etc-'));
    process.env.DEVCHAIN_HOST_ETC_DIR = etcDir;
    process.env.DEVCHAIN_HOST_BIN_DIR = '/opt/helpers';
    resetEnvConfig();
    run.mockReset();
    service = new HostHelperService({ run } as unknown as ProcessExecutor);
  });

  afterEach(() => {
    rmSync(etcDir, { recursive: true, force: true });
    delete process.env.DEVCHAIN_HOST_ETC_DIR;
    delete process.env.DEVCHAIN_HOST_BIN_DIR;
    resetEnvConfig();
  });

  const claim = () => writeFileSync(join(etcDir, 'claim.json'), '{"userName":"alice"}');

  it('refuses every call on an instance that is not a claimed host', async () => {
    expect(service.isClaimedHost()).toBe(false);
    await expect(service.requestUpdate('1.2.3')).rejects.toMatchObject({
      statusCode: 409,
      details: { code: 'NOT_A_HOST' },
    });
    await expect(service.createProjectRoot('/srv/work/demo')).rejects.toBeInstanceOf(ConflictError);
    expect(() => service.readUpdateStatus()).toThrow(ConflictError);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs the update helper through sudo without a password prompt', async () => {
    claim();
    helperAnswers('{"requested":"1.2.3"}\n');
    await service.requestUpdate('1.2.3');
    expect(run).toHaveBeenCalledWith({
      argv: ['sudo', '-n', '/opt/helpers/devchain-host-update', '1.2.3'],
      mode: 'pipe',
      timeout: expect.any(Number),
    });
  });

  it('returns the project root the helper created', async () => {
    claim();
    helperAnswers('{"path":"/srv/work/demo","created":true}\n');
    await expect(service.createProjectRoot('/srv/work/demo')).resolves.toEqual({
      path: '/srv/work/demo',
      created: true,
    });
    expect(run.mock.calls[0][0].argv).toEqual([
      'sudo',
      '-n',
      '/opt/helpers/devchain-host-project-root',
      '/srv/work/demo',
    ]);
  });

  it.each([
    [2, ValidationError, 400],
    [3, ConflictError, 409],
    [4, ForbiddenError, 403],
    [1, AppError, 500],
  ])('maps helper exit %i to %p', async (code, type, statusCode) => {
    claim();
    helperAnswers('', {
      code,
      stderr: '{"code":"PATH_REFUSED","message":"/home/bob/x is under a home directory"}\n',
    });
    const error = await service.createProjectRoot('/home/bob/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(type);
    expect(error).toMatchObject({ statusCode, details: { code: 'PATH_REFUSED' } });
  });

  it('reads the last update status, or null before any update', () => {
    claim();
    expect(service.readUpdateStatus()).toBeNull();
    writeFileSync(
      join(etcDir, 'update.json'),
      JSON.stringify({ state: 'done', version: '1.2.3', at: '2026-09-24T10:00:00.000Z' }),
    );
    expect(service.readUpdateStatus()).toEqual({
      state: 'done',
      version: '1.2.3',
      at: '2026-09-24T10:00:00.000Z',
    });
  });
  it('requests detached Docker mode and reads its job status', async () => {
    claim();
    helperAnswers('{"jobId":"docker-job"}');
    await expect(service.requestDocker()).resolves.toEqual({ jobId: 'docker-job' });
    expect(run.mock.calls[0][0].argv).toEqual([
      'sudo',
      '-n',
      '/opt/helpers/devchain-host-update',
      '--docker',
    ]);
    expect(service.readDockerStatus()).toBeNull();
    writeFileSync(
      join(etcDir, 'docker.json'),
      JSON.stringify({ jobId: 'docker-job', state: 'installing', at: 'now' }),
    );
    expect(service.readDockerStatus()).toMatchObject({ jobId: 'docker-job', state: 'installing' });
    writeFileSync(join(etcDir, 'docker.json'), '{');
    expect(service.readDockerStatus()).toBeNull();
  });

  it('names the manual migration when an older helper rejects --docker as a version', async () => {
    claim();
    helperAnswers('', {
      code: 2,
      stderr: '{"code":"INVALID_VERSION","message":"version must be semantic"}',
    });
    await expect(service.requestDocker()).rejects.toMatchObject({
      details: { code: 'HOST_HELPER_OUTDATED' },
      message: expect.stringContaining(
        'sudo npm install -g /opt/devchain-host/current/lib/node_modules/devchain-cli/dist/host-install/devchain-host-bootstrap.tgz',
      ),
    });
  });
});
