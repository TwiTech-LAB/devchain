/** Two booted apps are the cheapest reliable layer for own-key host routes,
 * forced detach lifecycle, health integration and restart-persistent settings. */
import { startTwoInstances, type TwoInstances } from '../../../common/test/two-instance.fixture';
import { replicaSeeder } from '../replica/__fixtures__/replica-seed';
import { RemoteHealthService } from './remote-health.service';
import { RemoteForcedDetachStore } from './remote-forced-detach.store';
import { RemoteOperationRunner } from '../operations/remote-operation.runner';
import { HostSharedVmStore } from '../host/host-shared-vm.store';
import type { RemoteOperation } from '../../storage/models/domain.models';

const KEY = `dck_${'n'.repeat(43)}`;

describe('home notices and forced Disconnect reconciliation', () => {
  let instances: TwoInstances;
  let remoteId: string;

  beforeEach(async () => {
    instances = await startTwoInstances({ claimedHost: { key: KEY }, healthIntervalMs: 60_000 });
    remoteId = (await instances.registerRemote('shared-vm')).id;
    replicaSeeder(instances.host.sqlite).seedProject('forced-project');
    await instances.bindProject('forced-project', remoteId);
    await instances.home.app.get(RemoteHealthService).refresh(remoteId);
  });

  afterEach(async () => {
    await instances?.close();
  });

  async function forceDisconnect(): Promise<RemoteOperation> {
    const response = await instances.home.app.inject({
      method: 'POST',
      url: `/api/remotes/${remoteId}/detach`,
      payload: { projectId: 'forced-project', force: true },
    });
    expect(response.statusCode).toBe(202);
    const started = response.json<RemoteOperation>();
    await instances.home.app.get(RemoteOperationRunner).whenIdle(started.id);
    const outcome = await instances.home.storage.getRemoteOperation(started.id);
    expect(outcome.steps.find((step) => step.state === 'failed')?.error).toBeUndefined();
    expect(outcome.state).toBe('done');
    return outcome;
  }

  it('polls the protected inbox and forwards Dismiss to the own instance', async () => {
    const inbox = instances.host.app.get(HostSharedVmStore);
    const notice = await inbox.receive({
      fromUser: 'owner',
      action: 'destroy',
      message: 'Please save your work',
      at: '2026-10-12T15:00:00Z',
    });
    await instances.home.app.get(RemoteHealthService).refresh(remoteId);
    const response = await instances.home.app.inject({ url: '/api/remotes/notices' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ notices: [{ ...notice, remoteId }] });
    const dismissed = await instances.home.app.inject({
      method: 'POST',
      url: `/api/remotes/${remoteId}/notices/dismiss`,
      payload: { id: notice.id },
    });
    expect(dismissed.statusCode).toBe(204);
    expect(inbox.notices()).toEqual([]);
    expect((await instances.home.app.inject({ url: '/api/remotes/notices' })).json()).toEqual({
      notices: [],
    });
  });

  it('sends an online forced Disconnect tombstone immediately and stops counting without deleting the VM project', async () => {
    const host = instances.host.app.get(HostSharedVmStore);
    expect(host.connectedCount()).toBe(1);
    await forceDisconnect();
    expect(instances.home.app.get(RemoteForcedDetachStore).pending()).toEqual([]);
    expect(host.connectedCount()).toBe(0);
    expect(await instances.host.storage.getProject('forced-project')).toMatchObject({
      id: 'forced-project',
    });
    expect(await instances.home.storage.getRemoteProjectBinding('forced-project')).toBeNull();
  });

  it('keeps an offline tombstone across home restart and sends it on the next successful health poll', async () => {
    await instances.host.close();
    expect((await instances.home.app.get(RemoteHealthService).refresh(remoteId)).online).toBe(
      false,
    );
    await forceDisconnect();
    expect(instances.home.app.get(RemoteForcedDetachStore).pending()).toEqual([
      { remoteId, projectId: 'forced-project' },
    ]);
    await instances.restartHome();
    expect(instances.home.app.get(RemoteForcedDetachStore).pending()).toEqual([
      { remoteId, projectId: 'forced-project' },
    ]);
    await instances.restartHost();
    expect((await instances.home.app.get(RemoteHealthService).refresh(remoteId)).online).toBe(true);
    expect(instances.home.app.get(RemoteForcedDetachStore).pending()).toEqual([]);
    expect(instances.host.app.get(HostSharedVmStore).connectedCount()).toBe(0);
  });
});
