// Unit storage doubles control pending reads and failed saves to verify cache invalidation.
import { Test } from '@nestjs/testing';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { RemoteApiKeyService, remoteAuthorization } from './remote-api-key.service';

describe('RemoteApiKeyService', () => {
  const storage = { readRemoteApiKey: jest.fn(), saveRemoteApiKey: jest.fn() };
  let keys: RemoteApiKeyService;

  beforeEach(async () => {
    jest.resetAllMocks();
    keys = (
      await Test.createTestingModule({
        providers: [RemoteApiKeyService, { provide: STORAGE_SERVICE, useValue: storage }],
      }).compile()
    ).get(RemoteApiKeyService);
  });

  it('memoizes reads and invalidates a pending read when a replacement is saved', async () => {
    let resolve!: (value: string) => void;
    storage.readRemoteApiKey
      .mockReturnValueOnce(
        new Promise<string>((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValue('replacement');
    const pending = keys.get('remote');
    expect(keys.get('remote')).toBe(pending);
    await keys.save('remote', 'replacement');
    resolve('old');
    expect(await pending).toBe('old');
    expect(await keys.headers('remote')).toEqual({ authorization: 'Bearer replacement' });
    expect(storage.readRemoteApiKey).toHaveBeenCalledTimes(2);
  });

  it('retries failed reads and reloads after a failed save', async () => {
    storage.readRemoteApiKey
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue('key');
    await expect(keys.get('remote')).rejects.toThrow('unavailable');
    expect(await keys.getOrCreate('remote')).toBe('key');
    expect(storage.saveRemoteApiKey).not.toHaveBeenCalled();
    storage.saveRemoteApiKey.mockRejectedValueOnce(new Error('unavailable'));
    await expect(keys.save('remote', 'replacement')).rejects.toThrow('unavailable');
    expect(await keys.get('remote')).toBe('key');
    expect(storage.readRemoteApiKey).toHaveBeenCalledTimes(3);
  });

  it('allows explicitly keyless calls', () => {
    expect(remoteAuthorization(null)).toEqual({});
    expect(remoteAuthorization(undefined)).toEqual({});
  });
});
