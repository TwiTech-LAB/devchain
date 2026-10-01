import type { RemoteOperation } from '../../storage/models/domain.models';
import { ClaimOperation } from './claim.operation';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { HostSshKeysService } from '../host/host-ssh-keys.service';

// Layer: filesystem-backed unit. The real merge proves a lost reply followed by
// a claim-step retry cannot duplicate the key; the transport alone is stubbed.
describe('ClaimOperation ssh_keys', () => {
  const key = utils.generateKeyPairSync('ed25519').public;
  // The apply stub stands in for the VM's own claimed DevChain, so its claim check passes.
  const claimedHost = { assertClaimedHost: () => undefined } as never;
  let home: string;
  let applySshKeys: jest.Mock;
  let claim: ClaimOperation;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'devchain-claim-ssh-'));
    const service = new HostSshKeysService(claimedHost, home);
    applySshKeys = jest.fn(async (_remoteId: string, keys: string[]) => {
      await service.apply(keys);
    });
    const unused = {} as never;
    claim = new ClaimOperation(
      unused,
      unused,
      { applySshKeys } as never,
      unused,
      unused,
      unused,
      unused,
    );
  });
  afterEach(async () => rm(home, { recursive: true, force: true }));

  it('runs after provider verification and applies the persisted keys', async () => {
    const step = claim.steps.find((definition) => definition.id === 'ssh_keys')!;
    expect(claim.steps.indexOf(step)).toBe(
      claim.steps.findIndex((definition) => definition.id === 'verify_providers') + 1,
    );
    const run = { operation: { remoteId: 'vm' }, details: { sshPublicKeys: [key] } } as Parameters<
      typeof step.run
    >[0];
    expect(step.skip?.(run.details)).toBe(false);
    await step.run(run);
    expect(applySshKeys).toHaveBeenCalledWith('vm', [key]);
    expect(await readFile(join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe(`${key}\n`);
  });

  it.each([{}, { sshPublicKeys: [] }])('skips without keys: %j', async (details) => {
    const step = claim.steps.find((definition) => definition.id === 'ssh_keys')!;
    expect(step.skip?.(details)).toBe(true);
    await step.run({ operation: { remoteId: 'vm' }, details } as Parameters<typeof step.run>[0]);
    expect(applySshKeys).not.toHaveBeenCalled();
  });

  it('retries itself after a lost reply and does not add the key twice', async () => {
    const step = claim.steps.find((definition) => definition.id === 'ssh_keys')!;
    const merge = new HostSshKeysService(claimedHost, home);
    applySshKeys.mockImplementationOnce(async (_remoteId: string, keys: string[]) => {
      await merge.apply(keys);
      throw new Error('Reply lost');
    });
    const run = { operation: { remoteId: 'vm' }, details: { sshPublicKeys: [key] } } as Parameters<
      typeof step.run
    >[0];
    await expect(step.run(run)).rejects.toThrow('Reply lost');
    expect(
      claim.retryFrom({
        steps: [{ id: 'ssh_keys', state: 'failed' }],
        details: run.details,
      } as RemoteOperation),
    ).toBeNull();
    await step.run(run);
    expect(await readFile(join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe(`${key}\n`);
  });
});

// Layer: unit. The register step reads only the health port, so a stubbed state proves
// that a claim whose key the VM rejects does not finish as a working VM.
describe('ClaimOperation register_remote', () => {
  it("refuses a claimed VM that rejects this PC's API key", async () => {
    const health = {
      refresh: async () => ({ online: true, versionMatches: true, apiKeyRejected: true }),
    };
    const unused = {} as never;
    const claim = new ClaimOperation(
      unused,
      health as never,
      unused,
      unused,
      unused,
      unused,
      unused,
    );
    const step = claim.steps.find((definition) => definition.id === 'register_remote')!;
    const operation = { id: 'op-claim', remoteId: 'remote-1' } as RemoteOperation;

    await expect(
      step.run({ operation, details: {} } as Parameters<typeof step.run>[0]),
    ).rejects.toMatchObject({ code: 'HOST_API_KEY_REJECTED' });
  });
});
