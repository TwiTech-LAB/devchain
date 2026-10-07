// Unit layer: registration publishes an Activity warning from the runtime-backed health answer.
import { Test } from '@nestjs/testing';
import { STORAGE_SERVICE } from '../../storage/interfaces/storage.interface';
import type { RemoteOperation } from '../../storage/models/domain.models';
import { ProcessExecutor } from '../../terminal/services/process-executor/process-executor.port';
import { ProviderAuthVaultService } from '../../provider-auth/provider-auth-vault.service';
import { ProviderAuthGeneratorService } from '../../provider-auth/provider-auth-generator.service';
import { RemoteApiKeyService } from '../auth/remote-api-key.service';
import { REMOTE_HEALTH_PORT } from '../ports/remote-health.port';
import { RemoteHostClient } from './remote-host.client';
import { ClaimOperation } from './claim.operation';

afterEach(() => jest.restoreAllMocks());

it.each([
  {
    holder: 'ubuntu',
    vmUid: 1001,
    vmGid: 1000,
    warning:
      'uid 1000 is used by ubuntu on the VM; the VM user got 1001:1000. Automatic Docker moves are off for this VM.',
  },
  {
    holder: null,
    vmUid: 1001,
    vmGid: 1000,
    warning:
      'The user ids differ (1000:1000 here, 1001:1000 on the VM). Automatic Docker moves are off for this VM.',
  },
  {
    holder: null,
    vmUid: 1000,
    vmGid: 2000,
    warning:
      'The user ids differ (1000:1000 here, 1000:2000 on the VM). Automatic Docker moves are off for this VM.',
  },
  {
    holder: undefined,
    vmUid: 1001,
    vmGid: 1000,
    warning:
      'The user ids differ (1000:1000 here, 1001:1000 on the VM). Automatic Docker moves are off for this VM.',
  },
  { holder: undefined, vmUid: 1000, vmGid: 1000, warning: undefined },
])(
  'finishes the claim with holder $holder and actual ids $vmUid:$vmGid',
  async ({ holder, vmUid, vmGid, warning }) => {
    jest.spyOn(process, 'getuid').mockReturnValue(1000);
    jest.spyOn(process, 'getgid').mockReturnValue(1000);
    const module = await Test.createTestingModule({
      providers: [
        ClaimOperation,
        {
          provide: REMOTE_HEALTH_PORT,
          useValue: {
            refresh: async () => ({
              online: true,
              versionMatches: true,
              uid: vmUid,
              gid: vmGid,
              ...(holder !== undefined ? { uidConflict: { requestedUid: 1000, holder } } : {}),
            }),
          },
        },
        ...[
          STORAGE_SERVICE,
          RemoteHostClient,
          ProviderAuthVaultService,
          ProviderAuthGeneratorService,
          ProcessExecutor,
          RemoteApiKeyService,
        ].map((provide) => ({ provide, useValue: {} })),
      ],
    }).compile();
    const claim = module.get(ClaimOperation);
    const step = claim.steps.find((entry) => entry.id === 'register_remote')!;
    const details: Record<string, unknown> = {};
    await step.run({
      operation: { remoteId: 'vm' } as RemoteOperation,
      details,
      progress: async (patch) => {
        Object.assign(details, patch);
      },
    });
    expect(details.dockerUserWarning).toEqual(warning);
    await module.close();
  },
);
