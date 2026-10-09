import { DEFAULT_FILE_SYNC_IGNORES } from '../../src/modules/file-sync/file-sync.dto';
import { FileListChangedError } from '../../src/ui/pages/cloud/lib/remote-vm-errors';
import {
  InMemoryRemoteVmApi,
  PROXMOX_CONNECTION,
  REMOTE,
  makeOperation,
} from './in-memory-remote-vm-api';

// The fake owns state transitions, isolation and overrides; page specs own rendered orchestration.
describe('InMemoryRemoteVmApi', () => {
  const signal = () => new AbortController().signal;

  it('isolates seeded state and read snapshots from callers and other instances', async () => {
    const seed = [{ ...REMOTE }];
    const api = new InMemoryRemoteVmApi({ remotesData: seed });
    const other = new InMemoryRemoteVmApi();
    seed[0].name = 'outside';
    const remotes = await api.listRemotes(signal());
    remotes[0].name = 'mutated read';
    await expect(api.listRemotes(signal())).resolves.toEqual([
      expect.objectContaining({ name: 'lab-vm' }),
    ]);
    expect(other.remotesData[0].name).toBe('lab-vm');
  });

  it('persists remote creation and rename, then removes the row and its operations on deletion', async () => {
    const api = new InMemoryRemoteVmApi();
    const created = await api.createRemote({
      name: 'Worker',
      baseUrl: 'https://worker',
      certificateFingerprint: 'SHA256:certificate',
    });
    await api.renameRemote(created.id, 'Build worker');
    api.operationsData = [{ ...makeOperation(), remoteId: created.id }];
    expect(api.remotesData.find(({ id }) => id === created.id)?.name).toBe('Build worker');
    await api.deleteRemote(created.id);
    expect(api.remotesData.map(({ id }) => id)).toEqual(['r1']);
    expect(api.operationsData).toEqual([]);
  });

  it('refuses deletion while a project still binds the remote', async () => {
    const api = new InMemoryRemoteVmApi({
      bindingsData: [{ remoteId: 'r1', projectId: 'p1', state: 'remote' }],
    });
    await expect(api.deleteRemote('r1')).rejects.toThrow(
      'Cannot delete a remote with a project binding.',
    );
    expect(api.remotesData.map(({ id }) => id)).toEqual(['r1']);
    expect(api.bindingsData).toHaveLength(1);
  });

  it('records independent request snapshots before callers scrub credentials', async () => {
    const api = new InMemoryRemoteVmApi();
    const ssh = { user: 'alice', password: 'secret' };
    const request = api.retryOperation('op1', { ssh });
    ssh.password = '';
    await request;
    expect(api.calls.retryOperation).toEqual([
      ['op1', { ssh: { user: 'alice', password: 'secret' } }],
    ]);
    const controller = new AbortController();
    await api.probeAddress('worker', { checkSsh: true, signal: controller.signal });
    expect(api.calls.probeAddress[0][1].signal).toBe(controller.signal);
  });

  it('uses overrides without mutating default state, and can resume default behavior', async () => {
    const api = new InMemoryRemoteVmApi();
    const refusal = new Error('Name already used');
    api.overrides.renameRemote = refusal;
    await expect(api.renameRemote('r1', 'Worker')).rejects.toBe(refusal);
    expect(api.remotesData[0].name).toBe('lab-vm');
    delete api.overrides.renameRemote;
    await expect(api.renameRemote('r1', 'Worker')).resolves.toMatchObject({ name: 'Worker' });
    expect(api.calls.renameRemote).toEqual([
      ['r1', 'Worker'],
      ['r1', 'Worker'],
    ]);
  });

  it('retains gated power-on state until released, then reports a running VM awaiting health', async () => {
    let release!: () => void;
    const powerOnGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = new InMemoryRemoteVmApi({
      remotesData: [{ ...REMOTE, powerState: 'stopped' }],
      powerOnGate,
    });
    const pending = api.powerOn('r1');
    expect(api.remotesData[0].powerState).toBe('stopped');
    release();
    await pending;
    expect(api.remotesData[0]).toMatchObject({ powerState: 'running', online: false });
  });

  it('filters live operations by state and resolves separate project history', async () => {
    const running = makeOperation();
    const done = { ...makeOperation(), id: 'done', projectId: 'p2', state: 'done' as const };
    const history = {
      ...makeOperation(),
      id: 'history',
      projectId: 'p3',
      state: 'cancelled' as const,
    };
    const api = new InMemoryRemoteVmApi({
      operationsData: [running, done],
      projectHistory: [history],
    });
    await expect(api.listOperations('running', 200, signal())).resolves.toEqual([running]);
    await expect(api.readNewestOperation('p3', signal())).resolves.toEqual(history);
    await expect(api.readNewestOperation('missing', signal())).resolves.toBeNull();
  });

  it.each([
    ['attach', 'attaching'],
    ['detach', 'detaching'],
  ] as const)('starts %s with the matching binding transition', async (action, state) => {
    const api = new InMemoryRemoteVmApi();
    const operation =
      action === 'attach'
        ? await api.attachProject('r1', { projectId: 'p1' })
        : await api.detachProject('r1', { projectId: 'p1', force: false });
    expect(operation).toMatchObject({
      kind: action,
      state: 'running',
      remoteId: 'r1',
      projectId: 'p1',
    });
    expect(api.operationsData).toEqual([operation]);
    expect(api.bindingsData).toEqual([{ projectId: 'p1', remoteId: 'r1', state }]);
  });

  it('starts Force sync without changing the connected binding', async () => {
    const binding = { projectId: 'p1', remoteId: 'r1', state: 'remote' };
    const api = new InMemoryRemoteVmApi({ bindingsData: [binding] });
    const operation = await api.forceSync('r1', { projectId: 'p1', source: 'vm' });
    expect(operation).toMatchObject({
      kind: 'force_sync',
      details: { source: 'vm', forceSync: { source: 'vm' } },
    });
    expect(operation.steps.map(({ id }) => id)).toEqual(['preflight', 'force_copy']);
    expect(api.bindingsData).toEqual([binding]);
  });

  it('cancels by clearing bindings and recording the VM terminal marker; retry clears step failures', async () => {
    const failed = {
      ...makeOperation(),
      state: 'failed' as const,
      steps: [
        {
          id: 'copy',
          label: 'Copy',
          state: 'failed' as const,
          error: { message: 'Stopped', code: null },
        },
      ],
    };
    const api = new InMemoryRemoteVmApi({
      operationsData: [failed],
      bindingsData: [{ projectId: 'p1', remoteId: 'r1', state: 'attaching' }],
    });
    const cancelled = await api.cancelOperation('op1');
    expect(cancelled.state).toBe('cancelled');
    expect(api.bindingsData).toEqual([]);
    expect(api.remotesData[0].lastOperation).toMatchObject({
      id: 'op1',
      kind: 'attach',
      state: 'cancelled',
    });
    const retried = await api.retryOperation('op1');
    expect(retried).toMatchObject({ state: 'running', steps: [{ state: 'running', error: null }] });
    expect(api.operationsData).toEqual([retried]);
  });

  it('creates a managed pending VM with the resource choices and image/claim steps', async () => {
    const api = new InMemoryRemoteVmApi();
    const operation = await api.createVm('pc1', {
      name: 'Worker',
      cores: 2,
      memory: 4096,
      disk: 16,
      providerAuth: {},
    });
    expect(api.remotesData.at(-1)).toMatchObject({
      id: 'r-created',
      name: 'Worker',
      baseUrl: null,
      vmIdentity: null,
      vmProviderConnectionId: 'pc1',
      vmSpec: { cores: 2, memory: 4096, disk: 16 },
    });
    expect(operation).toMatchObject({
      id: 'create-op',
      kind: 'create_vm',
      state: 'running',
      projectId: null,
    });
    expect(operation.steps.map(({ id }) => id)).toEqual([
      'vm_preflight',
      'ensure_image',
      'ensure_template',
      'clone',
      'start',
      'wait_ip',
      'claim_preflight',
      'claim_claim',
    ]);
  });

  it('previews Proxmox without storing it and connects with the current rights result', async () => {
    const api = new InMemoryRemoteVmApi({ permissionMissing: ['VM.Allocate'] });
    const preview = await api.previewProxmoxConnection('connection');
    expect(preview.fingerprint).toBe(PROXMOX_CONNECTION.sslFingerprint);
    expect(api.providerConnectionsData).toEqual([]);
    const connected = await api.connectProxmox('connection');
    expect(connected.permissions).toEqual({ ok: false, missing: ['VM.Allocate'] });
    expect(api.providerConnectionsData).toEqual([PROXMOX_CONNECTION]);
  });

  it('refuses to remove a provider used by a VM and permits it after the VM is removed', async () => {
    const api = new InMemoryRemoteVmApi({
      providerConnectionsData: [PROXMOX_CONNECTION],
      remotesData: [{ ...REMOTE, vmProviderConnectionId: 'pc1' }],
    });
    await expect(api.deleteVmProvider('pc1')).rejects.toThrow('lab-vm uses this connection.');
    expect(api.providerConnectionsData).toEqual([PROXMOX_CONNECTION]);
    await api.deleteRemote('r1');
    await api.deleteVmProvider('pc1');
    expect(api.providerConnectionsData).toEqual([]);
  });

  it('persists ignore revisions, distinguishes stale writes, and restores defaults', async () => {
    const api = new InMemoryRemoteVmApi();
    const saved = await api.saveProjectIgnores('p1', ['/runtime'], 0);
    expect(saved).toMatchObject({ ignores: ['/runtime'], revision: 1, applied: true });
    await expect(api.saveProjectIgnores('p1', ['/lost'], 0)).rejects.toBeInstanceOf(
      FileListChangedError,
    );
    expect(api.ignores.p1).toEqual(['/runtime']);
    const restored = await api.saveProjectIgnores('p1', null, 1);
    expect(restored).toMatchObject({ ignores: [...DEFAULT_FILE_SYNC_IGNORES], revision: 2 });
    expect(api.ignorePuts).toEqual([
      { projectId: 'p1', ignores: ['/runtime'] },
      { projectId: 'p1', ignores: ['/lost'] },
      { projectId: 'p1', ignores: null },
    ]);
  });
});
