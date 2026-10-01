import { ProviderAuthReleaseService } from './provider-auth-release.service';
import type { ProviderAuthEntryDto } from './provider-auth.dto';
import type { ProviderAuthVaultService } from './provider-auth-vault.service';
import type { ProviderAuthWritebackService } from './provider-auth-writeback.service';

const REMOTE_ID = '22222222-2222-4222-8222-222222222222';
const ENTRY_ID = '11111111-1111-4111-8111-111111111111';

function makeEntry(checkedOutRemoteId: string | null): ProviderAuthEntryDto {
  return {
    id: ENTRY_ID,
    provider: 'codex',
    kind: 'family',
    label: 'Codex login',
    payloadKind: 'files',
    checkedOutRemoteId,
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    lastVerifiedAt: '2026-09-24T00:00:00.000Z',
    lastWritebackAt: null,
  };
}

// These unit tests isolate release orchestration, where pull order and offline behavior live.
describe('ProviderAuthReleaseService', () => {
  let vault: { get: jest.Mock; release: jest.Mock };
  let writeback: { pullFamiliesNow: jest.Mock };
  let service: ProviderAuthReleaseService;

  beforeEach(() => {
    vault = {
      get: jest.fn().mockResolvedValue(makeEntry(REMOTE_ID)),
      release: jest.fn().mockResolvedValue(makeEntry(null)),
    };
    writeback = {
      pullFamiliesNow: jest.fn().mockResolvedValue({ pulled: true, families: [] }),
    };
    service = new ProviderAuthReleaseService(
      vault as unknown as ProviderAuthVaultService,
      writeback as unknown as ProviderAuthWritebackService,
    );
  });

  it('pulls the checked-out remote before releasing the family', async () => {
    await expect(service.release(ENTRY_ID)).resolves.toEqual({
      entry: makeEntry(null),
      pullStatus: 'pulled',
    });

    expect(writeback.pullFamiliesNow).toHaveBeenCalledWith(REMOTE_ID);
    expect(vault.release).toHaveBeenCalledWith(ENTRY_ID);
    expect(writeback.pullFamiliesNow.mock.invocationCallOrder[0]).toBeLessThan(
      vault.release.mock.invocationCallOrder[0],
    );
  });

  it('releases an offline family and reports that it was not pulled', async () => {
    writeback.pullFamiliesNow.mockResolvedValue({ pulled: false, families: [] });

    await expect(service.release(ENTRY_ID)).resolves.toEqual({
      entry: makeEntry(null),
      pullStatus: 'offline',
    });

    expect(vault.release).toHaveBeenCalledWith(ENTRY_ID);
  });

  it('does not pull for an entry that is not checked out', async () => {
    vault.get.mockResolvedValue(makeEntry(null));

    await expect(service.release(ENTRY_ID)).resolves.toEqual({
      entry: makeEntry(null),
      pullStatus: 'not-needed',
    });

    expect(writeback.pullFamiliesNow).not.toHaveBeenCalled();
    expect(vault.release).toHaveBeenCalledWith(ENTRY_ID);
  });
});
