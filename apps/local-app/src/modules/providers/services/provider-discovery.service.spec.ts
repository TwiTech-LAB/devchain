import { Test, TestingModule } from '@nestjs/testing';
import { ProviderDiscoveryService } from './provider-discovery.service';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import { ProviderAdapterFactory } from '../adapters';
import * as resolveBinaryModule from '../../../common/resolve-binary';

jest.mock('../../../common/resolve-binary');
const mockResolveBinary = resolveBinaryModule.resolveBinary as jest.MockedFunction<
  typeof resolveBinaryModule.resolveBinary
>;

describe('ProviderDiscoveryService', () => {
  let service: ProviderDiscoveryService;
  let mockStorage: { listProviders: jest.Mock };
  let mockAdapterFactory: { getSupportedProviders: jest.Mock };

  beforeEach(async () => {
    mockStorage = {
      listProviders: jest.fn().mockResolvedValue({ items: [] }),
    };

    mockAdapterFactory = {
      getSupportedProviders: jest.fn().mockReturnValue(['claude', 'codex', 'gemini', 'opencode']),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProviderDiscoveryService,
        { provide: STORAGE_SERVICE, useValue: mockStorage },
        { provide: ProviderAdapterFactory, useValue: mockAdapterFactory },
      ],
    }).compile();

    service = module.get<ProviderDiscoveryService>(ProviderDiscoveryService);
    jest.clearAllMocks();
  });

  it('discovers binaries not yet in DB', async () => {
    mockResolveBinary
      .mockResolvedValueOnce('/usr/bin/claude')
      .mockResolvedValueOnce('/usr/bin/codex')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await service.discoverInstalledBinaries();

    expect(result.discovered).toEqual([
      { name: 'claude', binPath: '/usr/bin/claude' },
      { name: 'codex', binPath: '/usr/bin/codex' },
    ]);
    expect(result.notFound).toEqual(['gemini', 'opencode']);
    expect(result.alreadyPresent).toEqual([]);
  });

  it('marks existing providers as alreadyPresent without resolving', async () => {
    mockStorage.listProviders.mockResolvedValue({
      items: [
        { id: 'p1', name: 'claude' },
        { id: 'p2', name: 'codex' },
      ],
    });

    mockResolveBinary.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const result = await service.discoverInstalledBinaries();

    expect(result.alreadyPresent).toEqual(['claude', 'codex']);
    expect(result.discovered).toEqual([]);
    expect(result.notFound).toEqual(['gemini', 'opencode']);
    expect(mockResolveBinary).toHaveBeenCalledTimes(2);
  });

  it('case-insensitive matching against existing providers', async () => {
    mockStorage.listProviders.mockResolvedValue({
      items: [{ id: 'p1', name: 'Claude' }],
    });

    mockResolveBinary
      .mockResolvedValueOnce('/usr/bin/codex')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await service.discoverInstalledBinaries();

    expect(result.alreadyPresent).toEqual(['claude']);
    expect(result.discovered).toEqual([{ name: 'codex', binPath: '/usr/bin/codex' }]);
  });

  it('uses getSupportedProviders dynamically', async () => {
    mockAdapterFactory.getSupportedProviders.mockReturnValue(['alpha', 'beta']);
    mockResolveBinary.mockResolvedValueOnce('/usr/bin/alpha').mockResolvedValueOnce(null);

    const result = await service.discoverInstalledBinaries();

    expect(result.discovered).toEqual([{ name: 'alpha', binPath: '/usr/bin/alpha' }]);
    expect(result.notFound).toEqual(['beta']);
  });

  it('returns empty result when all providers already exist', async () => {
    mockStorage.listProviders.mockResolvedValue({
      items: [
        { id: 'p1', name: 'claude' },
        { id: 'p2', name: 'codex' },
        { id: 'p3', name: 'gemini' },
        { id: 'p4', name: 'opencode' },
      ],
    });

    const result = await service.discoverInstalledBinaries();

    expect(result.discovered).toEqual([]);
    expect(result.alreadyPresent).toHaveLength(4);
    expect(result.notFound).toEqual([]);
    expect(mockResolveBinary).not.toHaveBeenCalled();
  });

  it('idempotent: repeated call yields same result', async () => {
    mockResolveBinary.mockResolvedValue(null);

    const first = await service.discoverInstalledBinaries();
    const second = await service.discoverInstalledBinaries();

    expect(first).toEqual(second);
  });
});
