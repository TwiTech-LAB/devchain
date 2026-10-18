import { Test } from '@nestjs/testing';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { GitProcessIdentity } from './git-process-identity';

jest.mock('node:fs/promises', () => ({ readFile: jest.fn() }));
jest.mock('node:child_process', () => ({ execFile: jest.fn() }));
const read = jest.mocked(readFile);
const exec = jest.mocked(execFile) as unknown as jest.Mock;

// Unit tests isolate procfs errors and parsing that cannot be induced reliably with real PIDs.
(process.platform === 'linux' ? describe : describe.skip)('Git process start identity', () => {
  let processes: GitProcessIdentity;
  beforeEach(async () => {
    read.mockReset();
    const module = await Test.createTestingModule({ providers: [GitProcessIdentity] }).compile();
    processes = module.get(GitProcessIdentity);
  });

  it('parses start ticks after a process name containing spaces and parentheses', async () => {
    const fields = Array(20).fill('0');
    fields[0] = 'S';
    fields[19] = '42';
    read
      .mockResolvedValueOnce(`123 (git ) child) ${fields.join(' ')}`)
      .mockResolvedValueOnce('boot-id\n');
    expect(await processes.read(123)).toBe('boot-id:42');
  });

  it.each([
    ['ENOENT', false],
    ['ESRCH', false],
    ['EACCES', null],
  ] as const)('treats process read failure %s as %s', async (code, identity) => {
    read.mockRejectedValueOnce(Object.assign(new Error('unreadable'), { code }));
    expect(await processes.read(123)).toBe(identity);
  });

  it('does not treat a missing boot identifier as proof of process exit', async () => {
    read
      .mockResolvedValueOnce('123 (git) S')
      .mockRejectedValueOnce(Object.assign(new Error('no boot id'), { code: 'ENOENT' }));
    expect(await processes.read(123)).toBeNull();
  });
});

// Unit tests replace ps and sysctl output, since macOS cannot run in this test environment.
describe('Git process start identity on macOS', () => {
  const platform = process.platform;
  const answer = (outputs: Record<string, string | Error>) =>
    exec.mockImplementation((command: string, _args, _options, done) => {
      const output = outputs[command];
      if (output instanceof Error) done(output);
      else done(null, { stdout: output, stderr: '' });
    });
  beforeEach(() => {
    exec.mockReset();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });
  afterEach(() => Object.defineProperty(process, 'platform', { value: platform }));

  it('combines boot time and process start time, and proves exit when ps finds no process', async () => {
    const processes = new GitProcessIdentity();
    answer({
      ps: 'S+   Thu Oct 15 12:00:01 2026\n',
      sysctl: '{ sec = 1792000000, usec = 5 } Thu Oct 15 08:00:00 2026\n',
    });
    expect(await processes.read(123)).toBe('1792000000:Thu Oct 15 12:00:01 2026');
    answer({ ps: Object.assign(new Error('exit 1'), { code: 1, stdout: '' }) });
    expect(await processes.read(123)).toBe(false);
    answer({ ps: 'Z    Thu Oct 15 12:00:01 2026\n' });
    expect(await processes.read(123)).toBe(false);
    answer({ ps: Object.assign(new Error('spawn ps EACCES'), { code: 'EACCES' }) });
    expect(await processes.read(123)).toBeNull();
  });
});
