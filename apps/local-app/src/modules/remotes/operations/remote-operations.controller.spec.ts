import { ZodError } from 'zod';
import { RemoteOperationsController } from './remote-operations.controller';
import type { RemoteOperationsService } from './remote-operations.service';

const REMOTE_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';

describe('RemoteOperationsController claim, update and retry routes', () => {
  let service: { claim: jest.Mock; updateHost: jest.Mock; retry: jest.Mock };
  let controller: RemoteOperationsController;

  beforeEach(() => {
    service = {
      claim: jest.fn().mockResolvedValue({ id: OPERATION_ID }),
      updateHost: jest.fn().mockResolvedValue({ id: OPERATION_ID }),
      retry: jest.fn().mockResolvedValue({ id: OPERATION_ID }),
    };
    controller = new RemoteOperationsController(service as unknown as RemoteOperationsService);
  });

  it('claims by address or by remote id, with per-provider choices', async () => {
    await controller.claim({
      baseUrl: 'https://10.0.0.5:3000',
      certificateFingerprint: 'ab'.repeat(32),
      providerAuth: { Claude: `reuse:${ENTRY_ID}`, codex: 'generate', agy: 'skip' },
    });
    expect(service.claim).toHaveBeenCalledWith({
      baseUrl: 'https://10.0.0.5:3000',
      certificateFingerprint: 'AB'.repeat(32),
      providerAuth: { claude: `reuse:${ENTRY_ID}`, codex: 'generate', agy: 'skip' },
    });

    await controller.claim({ remoteId: REMOTE_ID });
    expect(service.claim).toHaveBeenLastCalledWith({ remoteId: REMOTE_ID, providerAuth: {} });
  });

  it('refuses a claim with both or neither target, or an unknown choice', () => {
    expect(() => controller.claim({ remoteId: REMOTE_ID, baseUrl: 'http://x:1' })).toThrow(
      ZodError,
    );
    expect(() => controller.claim({})).toThrow(ZodError);
    expect(() => controller.claim({ baseUrl: 'https://10.0.0.5:3000' })).toThrow(ZodError);
    expect(() =>
      controller.claim({ remoteId: REMOTE_ID, providerAuth: { codex: 'reuse:nope' } }),
    ).toThrow(ZodError);
    expect(service.claim).not.toHaveBeenCalled();
  });
});

describe('RemoteOperationsController attach route', () => {
  it('passes only Docker item ids and modes to the attach', async () => {
    const service = { attach: jest.fn().mockResolvedValue({ id: OPERATION_ID }) };
    const controller = new RemoteOperationsController(
      service as unknown as RemoteOperationsService,
    );
    await controller.attach(REMOTE_ID, { projectId: 'A' });
    expect(service.attach).toHaveBeenLastCalledWith(REMOTE_ID, 'A', undefined);
    const docker = { items: [{ id: 'c1', mode: 'data-only' }] };
    await controller.attach(REMOTE_ID, { projectId: 'A', docker });
    expect(service.attach).toHaveBeenLastCalledWith(REMOTE_ID, 'A', docker);

    for (const bad of [
      { items: [{ id: 'c1', mode: 'everything' }] },
      { items: [{ id: 'c1', mode: 'data-only', source: '/etc' }] },
      { items: [], paths: ['/etc'] },
    ])
      expect(() => controller.attach(REMOTE_ID, { projectId: 'A', docker: bad })).toThrow(ZodError);
  });
});

// Unit layer owns request normalization and rejection before service work.
describe('RemoteOperationsController update logins', () => {
  it('accepts only changed choices and an optional boolean force', async () => {
    const service = { updateLogins: jest.fn() };
    const controller = new RemoteOperationsController(
      service as unknown as RemoteOperationsService,
    );
    await controller.updateLogins(REMOTE_ID, { providerAuth: { Claude: `reuse:${ENTRY_ID}` } });
    expect(service.updateLogins).toHaveBeenCalledWith(REMOTE_ID, {
      providerAuth: { claude: `reuse:${ENTRY_ID}` },
      force: false,
    });
    await controller.updateLogins(REMOTE_ID, { providerAuth: { codex: 'skip' }, force: true });
    expect(service.updateLogins).toHaveBeenLastCalledWith(REMOTE_ID, {
      providerAuth: { codex: 'skip' },
      force: true,
    });
    for (const bad of [
      {},
      { providerAuth: {} },
      { providerAuth: { codex: 'skip' }, force: 'true' },
      { providerAuth: { codex: 'skip' }, unexpected: true },
    ]) {
      expect(() => controller.updateLogins(REMOTE_ID, bad)).toThrow(ZodError);
    }
  });
});
