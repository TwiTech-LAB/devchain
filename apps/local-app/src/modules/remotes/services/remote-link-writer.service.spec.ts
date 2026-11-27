/**
 * Where a home UI link write of a `remote` project runs, by the VM's health, what it
 * reports, and its seed.
 * Test layer: unit, with a fake health port and push service.
 */
import { AppError, ConflictError } from '../../../common/errors/error-types';
import type { RemoteHealthState } from '../ports/remote-health.port';
import { RemoteLinkWriterService } from './remote-link-writer.service';

function setup(
  state: Partial<RemoteHealthState>,
  linkWriter: 'vm' | 'home' | 'unknown' | null = 'vm',
) {
  const calls: string[] = [];
  const push = {
    withProjectLinks: jest.fn(async (ids: readonly string[], fn: () => Promise<unknown>) => {
      calls.push(`lock:${ids.join(',')}`);
      try {
        return await fn();
      } finally {
        calls.push('unlock');
      }
    }),
    seedConfirmed: jest.fn(async () => {
      calls.push('seed');
    }),
    forgetSeeded: jest.fn(() => calls.push('forget')),
    linkWriter: jest.fn(async () => linkWriter),
  };
  const writer = new RemoteLinkWriterService(
    { getState: () => ({ online: true, versionMatches: true, ...state }) as RemoteHealthState },
    push as never,
  );
  const write = {
    home: jest.fn(async () => {
      calls.push('home');
      return 'home';
    }),
    host: jest.fn(async () => {
      calls.push('host');
      return 'host';
    }),
  };
  return { writer, push, write, calls };
}

describe('RemoteLinkWriterService', () => {
  it('writes at home, under the project link lock, for a VM that takes no seed', async () => {
    const { writer, write, calls } = setup({ versionMatches: false }, 'home');

    await expect(writer.write('vm-1', 'P', write)).resolves.toBe('home');

    expect(calls).toEqual(['lock:P', 'home', 'unlock']);
  });

  it('seeds a VM of this version first, then writes on it outside the lock', async () => {
    const { writer, write, calls } = setup({});

    await expect(writer.write('vm-1', 'P', write)).resolves.toBe('host');

    expect(calls).toEqual(['lock:P', 'unlock', 'seed', 'host']);
  });

  it('refuses as retryable REMOTE_OFFLINE while the VM is unreachable', async () => {
    const { writer, write } = setup({ online: false });

    const error: unknown = await writer.write('vm-1', 'P', write).catch((e) => e);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).details).toMatchObject({
      code: 'REMOTE_OFFLINE',
      retryable: true,
    });
    expect(write.home).not.toHaveBeenCalled();
    expect(write.host).not.toHaveBeenCalled();
  });

  it('seeds again and retries once when the VM answers PROJECT_NOT_SEEDED', async () => {
    const { writer, write, calls } = setup({});
    const unseeded = new AppError('unseeded', 'PROJECT_NOT_SEEDED', 409);
    write.host.mockRejectedValueOnce(unseeded).mockRejectedValueOnce(unseeded);

    await expect(writer.write('vm-1', 'P', write)).rejects.toBe(unseeded);

    expect(calls).toEqual(['lock:P', 'unlock', 'seed', 'forget', 'seed']);
    expect(write.host).toHaveBeenCalledTimes(2);
  });
});
