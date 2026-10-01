import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fromX25519PrivateKey, bytesToBase64 } from '@devchain/shared';
import { seedRemoteProject } from '../../common/test/remote-project.fixture';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../common/test/two-instance.fixture';
import { TunnelHandlerService } from '../cloud-tunnel/services/tunnel-handler.service';
import { E2eeDeviceStoreService } from '../e2ee/services/e2ee-device-store.service';
import { PairedDeviceWorkspaceAccessService } from '../e2ee/services/paired-device-workspace-access.service';
import { readRevokedDeviceKids } from '../e2ee/services/device-revocation-history';
import { DEFAULT_PROJECT_WORKSPACE_ID } from '../storage/db/schema';
import type { RemoteOperation } from '../storage/models/domain.models';
import { ensureProvider } from './replica/__fixtures__/replica-seed';

jest.mock('node:os', () => {
  const os = jest.requireActual('node:os');
  const fs = jest.requireActual('node:fs');
  const path = jest.requireActual('node:path');
  const bootstrapHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devchain-grants-import-home-'));
  return {
    ...os,
    __testBootstrapHome: bootstrapHome,
    homedir: () =>
      process.env.HOME?.includes('/devchain-two-instance-') ? process.env.HOME : bootstrapHome,
  };
});

// Real Connect/Disconnect HTTP, migrated SQLite, device lifecycle and mobile authorization;
// the fixture replaces external process/file-sync/cloud-transport boundaries only.
describe('workspace grants at Connect across two instances', () => {
  let instances: TwoInstances;

  beforeAll(async () => {
    instances = await startTwoInstances({ realTunnelHandler: true, syncIntervalMs: 600_000 });
    const homePath = relative(instances.rootDir, homedir());
    expect(homePath && !homePath.startsWith('..') && !isAbsolute(homePath)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await instances?.close();
    const { __testBootstrapHome } = jest.requireMock('node:os') as { __testBootstrapHome: string };
    rmSync(__testBootstrapHome, { recursive: true, force: true });
  }, 30_000);

  it('preserves pre-delivery grants, authorizes mobile reads, and carries workspace/full-unpair revocations on the next Connect', async () => {
    const { home, host } = instances;
    const seed = seedRemoteProject(home.sqlite);
    const workspace = await home.storage.createProjectWorkspace('Connected workspace');
    const other = await home.storage.createProjectWorkspace('Home only');
    const projectRoot = join(instances.rootDir, 'project');
    mkdirSync(projectRoot);
    home.sqlite
      .prepare('UPDATE projects SET workspace_id = ?, root_path = ? WHERE id = ?')
      .run(workspace.id, projectRoot, seed.projectId);
    ensureProvider(host.sqlite, 'host-claude', seed.providerName, null);
    const remote = await instances.registerRemote('grant-host');
    await waitForValue(async () => {
      const response = await fetch(`${home.url}/api/remotes`);
      const result = (await response.json()) as { items: Array<{ id: string; online: boolean }> };
      return result.items.some((row) => row.id === remote.id && row.online);
    }, 10_000);
    const homeDevices = home.app.get(E2eeDeviceStoreService);
    const hostDevices = host.app.get(E2eeDeviceStoreService);
    const homeAccess = home.app.get(PairedDeviceWorkspaceAccessService);
    const handler = host.app.get(TunnelHandlerService);
    const phone = fromX25519PrivateKey(new Uint8Array(32).fill(31));
    const device = { kid: phone.kid, publicKeyB64: bytesToBase64(phone.publicKey) };
    homeDevices.add(device);
    await homeAccess.updateAccess(phone.kid, [workspace.id, other.id]);

    async function operation(kind: 'attach' | 'detach'): Promise<void> {
      const started = await fetch(`${home.url}/api/remotes/${remote.id}/${kind}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: seed.projectId }),
      });
      expect(started.ok).toBe(true);
      const pending = (await started.json()) as RemoteOperation;
      await waitForValue(async () => {
        const response = await fetch(`${home.url}/api/remotes/operations/${pending.id}`);
        const current = (await response.json()) as RemoteOperation;
        if (current.state === 'failed' || current.state === 'waiting')
          throw new Error(JSON.stringify(current.steps));
        return current.state === 'done';
      }, 20_000);
    }
    const rpc = (method: string, params: Record<string, unknown> = {}) =>
      handler.handle(
        { jsonrpc: '2.0', id: 'grant-test', method, params },
        { senderKid: phone.kid },
      );
    const grants = () =>
      host.sqlite
        .prepare(
          'SELECT workspace_id FROM paired_device_workspace_grants WHERE device_kid = ? ORDER BY workspace_id',
        )
        .all(phone.kid);
    const reconnect = async () => {
      await operation('detach');
      await operation('attach');
    };

    await operation('attach');
    expect(hostDevices.get(phone.kid)).toBeNull();
    expect(grants()).toEqual([{ workspace_id: workspace.id }]);
    expect((await rpc('board.listWorkspaces')).error).toBeDefined();
    const adopted = await handler.handle({
      jsonrpc: '2.0',
      id: 'adopt',
      method: 'e2ee.adoptDeviceKey',
      params: device,
    });
    expect(adopted.error).toBeUndefined();
    expect(grants()).toEqual([{ workspace_id: workspace.id }]);
    expect((await rpc('board.listWorkspaces')).result).toEqual([
      expect.objectContaining({ id: workspace.id }),
    ]);
    expect((await rpc('board.listProjects', { workspaceId: workspace.id })).result).toEqual([
      expect.objectContaining({ id: seed.projectId }),
    ]);
    expect((await rpc('board.listStatuses', { projectId: seed.projectId })).error).toBeUndefined();
    expect((await rpc('board.listProjects', { workspaceId: other.id })).error).toBeDefined();

    await homeAccess.updateAccess(phone.kid, [DEFAULT_PROJECT_WORKSPACE_ID]);
    await reconnect();
    expect(grants()).toEqual([]);
    expect((await rpc('board.listProjects', { workspaceId: workspace.id })).error).toBeDefined();
    expect(homeAccess.getAccess(phone.kid).workspaceIds).toEqual([DEFAULT_PROJECT_WORKSPACE_ID]);

    await homeAccess.updateAccess(phone.kid, [workspace.id]);
    await reconnect();
    expect(grants()).toEqual([{ workspace_id: workspace.id }]);
    homeDevices.revoke(phone.kid);
    expect(readRevokedDeviceKids(home.sqlite)).toContain(phone.kid);
    await reconnect();
    expect(hostDevices.get(phone.kid)).not.toBeNull();
    expect(grants()).toEqual([]);
    expect((await rpc('board.listWorkspaces')).result).toEqual([
      expect.objectContaining({ id: DEFAULT_PROJECT_WORKSPACE_ID }),
    ]);
    expect((await rpc('board.listProjects', { workspaceId: workspace.id })).error).toBeDefined();

    homeDevices.add(device);
    expect(readRevokedDeviceKids(home.sqlite)).not.toContain(phone.kid);
    await homeAccess.updateAccess(phone.kid, [workspace.id]);
    await reconnect();
    expect((await rpc('board.listProjects', { workspaceId: workspace.id })).result).toEqual([
      expect.objectContaining({ id: seed.projectId }),
    ]);
  }, 120_000);
});
