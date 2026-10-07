import { Test, TestingModule } from '@nestjs/testing';
import { ValidationError } from '../../../common/errors/error-types';
import { E2eeTrustService } from '../services/e2ee-trust.service';
import { E2eeTrustController } from './e2ee-trust.controller';
import { PairedDeviceWorkspaceAccessService } from '../services/paired-device-workspace-access.service';

describe('E2eeTrustController', () => {
  let controller: E2eeTrustController;
  let service: {
    listDevices: jest.Mock;
    getSafetyNumber: jest.Mock;
    verifyDevice: jest.Mock;
    revokeDevice: jest.Mock;
    adoptPeerKeyTofu: jest.Mock;
    setLocalAlias: jest.Mock;
  };
  let workspaceAccess: { getAccess: jest.Mock; updateAccess: jest.Mock };

  beforeEach(async () => {
    service = {
      listDevices: jest
        .fn()
        .mockReturnValue([
          { kid: 'k', label: 'Pixel', trust: 'unverified', addedAt: '2026-06-20T00:00:00Z' },
        ]),
      getSafetyNumber: jest
        .fn()
        .mockResolvedValue({ kid: 'k', safetyNumber: '00000 00000', trust: 'unverified' }),
      verifyDevice: jest
        .fn()
        .mockReturnValue({ kid: 'k', trust: 'verified', verifiedVia: 'safety-number' }),
      revokeDevice: jest.fn().mockReturnValue({ kid: 'k', removed: true }),
      adoptPeerKeyTofu: jest.fn().mockReturnValue({ kid: 'k', trust: 'unverified' }),
      setLocalAlias: jest.fn().mockImplementation((kid: string, localAlias: string | null) => ({
        kid,
        label: 'Pixel',
        ...(localAlias !== null ? { localAlias } : {}),
        trust: 'unverified',
        addedAt: '2026-06-20T00:00:00Z',
      })),
    };
    workspaceAccess = {
      getAccess: jest.fn().mockReturnValue({ kid: 'k', explicit: false, workspaceIds: ['w1'] }),
      updateAccess: jest.fn().mockResolvedValue({ kid: 'k', explicit: true, workspaceIds: ['w2'] }),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [E2eeTrustController],
      providers: [
        { provide: E2eeTrustService, useValue: service },
        { provide: PairedDeviceWorkspaceAccessService, useValue: workspaceAccess },
      ],
    }).compile();
    controller = module.get(E2eeTrustController);
  });

  it('renames with a trimmed alias and clears blank/null aliases', () => {
    expect(controller.setLocalAlias('k', { localAlias: '  Personal  ' })).toMatchObject({
      localAlias: 'Personal',
    });
    expect(service.setLocalAlias).toHaveBeenLastCalledWith('k', 'Personal');

    controller.setLocalAlias('k', { localAlias: '   ' });
    expect(service.setLocalAlias).toHaveBeenLastCalledWith('k', null);
    controller.setLocalAlias('k', { localAlias: null });
    expect(service.setLocalAlias).toHaveBeenLastCalledWith('k', null);
  });

  it('adopt rejects when kid or publicKeyB64 is missing', () => {
    expect(() => controller.adopt({ kid: 'k' })).toThrow(ValidationError);
    expect(service.adoptPeerKeyTofu).not.toHaveBeenCalled();
  });
});
