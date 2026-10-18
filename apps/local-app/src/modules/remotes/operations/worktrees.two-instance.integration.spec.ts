// Real authenticated host transport and both app graphs prove lane handoff admission.
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  startTwoInstances,
  waitForValue,
  type TwoInstances,
} from '../../../common/test/two-instance.fixture';
import {
  seedRemoteProject,
  type SeededRemoteProject,
} from '../../../common/test/remote-project.fixture';
import { FileSyncService } from '../../file-sync/file-sync.service';
import { FakeFileSyncService } from '../../file-sync/testing/fake-file-sync.service';
import { WorktreeAdmissionService } from '../../worktrees/worktree-admission.service';
import { ProjectGitMutex } from '../../worktrees/project-git-mutex';
import type { Remote, RemoteOperation } from '../../storage/models/domain.models';
import { ProjectFreezeService } from '../host/project-freeze.service';
import { RemoteFileSyncService } from '../sync/remote-file-sync.service';
import { RemoteHealthService } from '../services/remote-health.service';
import { RemoteHostClient } from './remote-host.client';
import { RemoteWorktreeGuard, UNKNOWN_VM_LANES_WARNING } from './remote-worktree-guard';
import { AttachOperation } from './attach.operation';
import { DetachOperation } from './detach.operation';
import { ResetVmOperation } from './reset-vm.operation';
import { RemoteSharedVmService } from '../services/remote-shared-vm.service';
import { FileSyncHandoff } from './file-sync-handoff';
import { VmProvidersService } from '../../vm-providers/vm-providers.service';
import { ProviderAuthWritebackService } from '../../provider-auth/provider-auth-writeback.service';
import { WorktreeGitRunner } from '../../worktrees/worktree-git-runner';
import { ChildProcessExecutor } from '../../terminal/services/process-executor/child-process-executor';
import { RemoteOperationRunner } from './remote-operation.runner';
import type { RemoteOperationStepDefinition } from './remote-operation.types';

jest.mock('node:os', () => {
  const os = jest.requireActual('node:os');
  const fs = jest.requireActual('node:fs');
  const path = jest.requireActual('node:path');
  const bootstrapHome = fs.mkdtempSync(path.join(os.tmpdir(), 'devchain-worktree-import-home-'));
  return {
    ...os,
    __testBootstrapHome: bootstrapHome,
    homedir: () =>
      process.env.HOME?.includes('/devchain-two-instance-') ? process.env.HOME : bootstrapHome,
  };
});

describe('worktree host admission and handoffs between two instances', () => {
  let pair: TwoInstances;
  let seed: SeededRemoteProject;
  let remote: Remote;
  let online = true;

  beforeAll(async () => {
    pair = await startTwoInstances({
      claimedHost: { key: `dck_${'w'.repeat(43)}` },
      syncIntervalMs: 600_000,
    });
    seed = seedRemoteProject(pair.host.sqlite);
    pair.host.sqlite
      .prepare("UPDATE sessions SET status = 'running', ended_at = NULL WHERE id = ?")
      .run(seed.sessionId);
    remote = await pair.registerRemote('worktree-host');
    await pair.bindProject(seed.projectId, remote.id);
    jest
      .spyOn(pair.home.app.get(RemoteHealthService), 'getState')
      .mockImplementation(() => ({ online, versionMatches: true, apiKeyRejected: false }) as never);
  }, 60_000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await pair?.close();
    const { __testBootstrapHome } = jest.requireMock('node:os');
    rmSync(__testBootstrapHome, { recursive: true, force: true });
  }, 30_000);

  async function laneTool(operation: string, args: Record<string, unknown> = {}) {
    const response = await pair.host.app.inject({
      method: 'POST',
      url: '/mcp/rpc',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: `devchain_worktrees_${operation}`,
          arguments: { sessionId: seed.sessionId, ...args },
        },
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      error?: { message: string; data: { code: string } };
      result?: { content: Array<{ text: string }> };
    }>();
    if (body.error)
      throw Object.assign(new Error(body.error.message), {
        code: body.error.data.code,
        details: body.error.data,
      });
    return JSON.parse(body.result!.content[0].text) as unknown;
  }

  async function lane() {
    return pair.host.storage.createWorktree({
      projectId: seed.projectId,
      name: 'storage',
      path: join(homedir(), '.devchain/worktrees', seed.projectId, 'storage'),
      branch: 'devchain/storage-123456',
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
      createdByType: 'agent',
      createdByAgentId: seed.leadAgentId,
    });
  }

  async function run(
    step: RemoteOperationStepDefinition,
    details: Record<string, unknown>,
    projectId = seed.projectId,
  ) {
    const operation = {
      id: 'test-operation',
      remoteId: remote.id,
      projectId,
      details,
      steps: [],
    } as unknown as RemoteOperation;
    await step.run({
      operation,
      details,
      progress: async (patch) => {
        Object.assign(details, patch);
      },
    });
  }

  // The real admission route, MCP create and composed steps catch the cross-process race.
  async function forcedHandoffRace() {
    // The fake Proxmox VM has no installed owner helper/claim registry. Keep this
    // composed test focused on lane admission; real fencing has separate coverage.
    const sharedVm = pair.home.app.get(RemoteSharedVmService);
    const occupancy = jest
      .spyOn(sharedVm, 'assertAllowed')
      .mockResolvedValue({ unavailable: false, instances: [] });
    const fence = jest
      .spyOn(sharedVm, 'fencedDestroy')
      .mockImplementation(async ({ destroy }) => destroy());
    const gitRunner = new WorktreeGitRunner(new ChildProcessExecutor());
    const nativeGit = jest
      .spyOn(pair.host.app.get(WorktreeGitRunner), 'run')
      .mockImplementation(gitRunner.run.bind(gitRunner));
    const root = join(pair.rootDir, 'forced-handoff-root');
    mkdirSync(root);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.test');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', join(pair.rootDir, 'empty-hooks'));
    writeFileSync(join(root, 'file.txt'), 'base\n');
    git('add', '.');
    git('commit', '-m', 'base');
    pair.host.sqlite
      .prepare('UPDATE projects SET root_path = ? WHERE id = ?')
      .run(root, seed.projectId);
    const files = pair.host.app.get(FileSyncService) as unknown as FakeFileSyncService;
    await files.ensureFolder({
      projectId: seed.projectId,
      kind: 'git',
      type: 'sendonly',
      peerDeviceId: 'home',
      ignores: ['/worktrees'],
    });
    const health = jest
      .spyOn(pair.home.app.get(RemoteHealthService), 'refresh')
      .mockResolvedValue({ online: true, versionMatches: true, apiKeyRejected: false } as never);
    const detach = pair.home.app.get(DetachOperation);
    const client = pair.home.app.get(RemoteHostClient);
    const makeRun = async (details: Record<string, unknown>, projectId: string | null) => {
      const operation = await pair.home.storage.createRemoteOperation({
        kind: projectId ? 'detach' : 'reset_vm',
        remoteId: remote.id,
        projectId,
        details,
        steps: [],
      });
      operation.details = details;
      const progress = jest.fn(
        async (patch: Record<string, unknown>, _options?: { durable?: boolean }) => {
          Object.assign(details, patch);
          await pair.home.storage.updateRemoteOperation(operation.id, { details: { ...details } });
        },
      );
      return { operation, details, progress };
    };
    const preflight = detach.steps.find((step) => step.id === 'preflight')!;
    const flip = detach.steps.find((step) => step.id === 'file_sync_flip')!;
    const flipEffect = jest
      .spyOn(pair.home.app.get(FileSyncHandoff), 'flipToHome')
      .mockImplementation(async () => {
        await expect(laneTool('create', { name: 'race' })).rejects.toMatchObject({
          code: 'LANES_FROZEN',
        });
        throw new Error('handoff unavailable');
      });
    const admissionFailure = jest
      .spyOn(client, 'setLaneAdmission')
      .mockRejectedValueOnce(new Error('admission route failed'));
    const disconnect = await makeRun({ force: true }, seed.projectId);
    await expect(preflight.run(disconnect)).rejects.toMatchObject({ code: 'LANES_UNKNOWN' });
    expect(disconnect.details.laneWarning).not.toBe(UNKNOWN_VM_LANES_WARNING);
    expect(flipEffect).not.toHaveBeenCalled();
    admissionFailure.mockRestore();
    await preflight.run(disconnect);
    expect(disconnect.progress).toHaveBeenCalledWith({ lanesFrozen: true }, { durable: true });
    await expect(laneTool('create', { name: 'race' })).rejects.toMatchObject({
      code: 'LANES_FROZEN',
    });
    await expect(flip.run(disconnect)).rejects.toThrow('handoff unavailable');
    const pending = (await laneTool('create', { name: 'race' })) as { path: string };
    writeFileSync(join(pending.path, 'uncommitted.txt'), 'work in flight\n');
    await expect(flip.run(disconnect)).rejects.toMatchObject({ code: 'LANES_EXIST' });
    expect(flipEffect).toHaveBeenCalledTimes(1);
    rmSync(join(pending.path, 'uncommitted.txt'));
    await laneTool('remove', { name: 'race' });
    await preflight.run(disconnect);
    await detach.rollback(disconnect.operation);
    const afterCancel = await laneTool('create', { name: 'after-cancel' });
    expect(afterCancel).toMatchObject({ name: 'after-cancel' });
    await laneTool('remove', { name: 'after-cancel' });
    flipEffect.mockImplementation(async () => {
      await expect(laneTool('create', { name: 'race' })).rejects.toMatchObject({
        code: 'LANES_FROZEN',
      });
    });
    await pair.home.storage.updateRemoteOperation(disconnect.operation.id, { state: 'cancelled' });
    const runner = pair.home.app.get(RemoteOperationRunner);
    const setAdmission = client.setLaneAdmission.bind(client);
    let failThaw = true;
    const admissionCalls: boolean[] = [];
    const finalThaw = jest
      .spyOn(client, 'setLaneAdmission')
      .mockImplementation(async (remoteId, projectId, frozen) => {
        admissionCalls.push(frozen);
        if (!frozen && failThaw) {
          failThaw = false;
          throw new Error('one failed thaw request');
        }
        await setAdmission(remoteId, projectId, frozen);
      });
    const started = await runner.start({
      kind: 'detach',
      remoteId: remote.id,
      projectId: seed.projectId,
      details: { force: true },
    });
    await runner.whenIdle(started.id);
    const failed = await pair.home.storage.getRemoteOperation(started.id);
    expect(failed.state).toBe('failed');
    expect(failed.details.lanesFrozen).toBe(true);
    expect(failed.steps.find((step) => step.id === 'thaw_lanes')).toMatchObject({
      state: 'failed',
      error: { message: 'one failed thaw request' },
    });
    expect(admissionCalls.filter((frozen) => !frozen)).toHaveLength(1);
    await expect(laneTool('create', { name: 'after-complete' })).rejects.toMatchObject({
      code: 'LANES_FROZEN',
    });
    const frozenCalls = admissionCalls.filter(Boolean).length;
    await runner.retry(started.id);
    await runner.whenIdle(started.id);
    const completed = await pair.home.storage.getRemoteOperation(started.id);
    expect(completed).toMatchObject({
      state: 'done',
      details: { lanesFrozen: false, laneThawWarning: null },
    });
    expect(admissionCalls.filter(Boolean)).toHaveLength(frozenCalls);
    expect(admissionCalls.filter((frozen) => !frozen)).toHaveLength(2);
    const afterComplete = await laneTool('create', { name: 'after-complete' });
    expect(afterComplete).toMatchObject({ name: 'after-complete' });
    await laneTool('remove', { name: 'after-complete' });
    await pair.bindProject(seed.projectId, remote.id);
    finalThaw.mockImplementation(async (remoteId, projectId, frozen) => {
      if (!frozen) throw new Error('VM unreachable during thaw');
      await setAdmission(remoteId, projectId, frozen);
    });
    health.mockResolvedValue({
      online: false,
      versionMatches: true,
      apiKeyRejected: false,
    } as never);
    const offline = await runner.start({
      kind: 'detach',
      remoteId: remote.id,
      projectId: seed.projectId,
      details: { force: true },
    });
    await runner.whenIdle(offline.id);
    const unknown = await pair.home.storage.getRemoteOperation(offline.id);
    expect(unknown).toMatchObject({
      state: 'done',
      details: {
        lanesFrozen: true,
        laneThawWarning: 'Lane admission on the VM may stay closed. Connect clears it.',
      },
    });
    await expect(laneTool('create', { name: 'after-connect' })).rejects.toMatchObject({
      code: 'LANES_FROZEN',
    });
    finalThaw.mockRestore();
    health.mockResolvedValue({
      online: true,
      versionMatches: true,
      apiKeyRejected: false,
    } as never);
    const connectThaw = pair.home.app
      .get(AttachOperation)
      .steps.find((step) => step.id === 'thaw_lanes')!;
    await connectThaw.run({ operation: offline, details: {}, progress: async () => undefined });
    const afterConnect = await laneTool('create', { name: 'after-connect' });
    expect(afterConnect).toMatchObject({ name: 'after-connect' });
    await laneTool('remove', { name: 'after-connect' });
    await pair.bindProject(seed.projectId, remote.id);

    pair.home.sqlite.prepare("UPDATE remotes SET kind = 'proxmox' WHERE id = ?").run(remote.id);
    const getRemote = jest.spyOn(pair.home.storage, 'getRemote').mockResolvedValue({
      ...remote,
      kind: 'proxmox',
      vmProviderConnectionId: 'connection',
      vmIdentity: 'old',
    });
    const pull = jest
      .spyOn(pair.home.app.get(ProviderAuthWritebackService), 'pullFamiliesNow')
      .mockResolvedValue({ pulled: true, families: [] });
    const destroyVm = jest.fn(async (): Promise<void> => {
      await expect(laneTool('create', { name: 'race' })).rejects.toMatchObject({
        code: 'LANES_FROZEN',
      });
      expect(await pair.host.storage.listWorktrees(seed.projectId)).toEqual([]);
      throw new Error('destroy unavailable');
    });
    const provider = jest
      .spyOn(pair.home.app.get(VmProvidersService), 'forConnection')
      .mockResolvedValue({ assertOwnedVmIdentity: async () => 123, destroyVm } as never);
    const reset = pair.home.app.get(ResetVmOperation);
    const resetRun = await makeRun(
      {
        projectIds: [seed.projectId],
        force: true,
        connectionId: 'connection',
        oldIdentity: 'old',
        spec: { memory: 4096 },
      },
      null,
    );
    const steps = reset.stepsFor(resetRun.details);
    await steps[0].run(resetRun);
    await expect(laneTool('create', { name: 'race' })).rejects.toMatchObject({
      code: 'LANES_FROZEN',
    });
    await reset.rollback(resetRun.operation);
    const resetCancelled = await laneTool('create', { name: 'reset-cancelled' });
    expect(resetCancelled).toMatchObject({ name: 'reset-cancelled' });
    await laneTool('remove', { name: 'reset-cancelled' });
    for (const step of steps) {
      if (step.skip?.(resetRun.details)) continue;
      if (step.id === 'destroy') {
        await expect(step.run(resetRun)).rejects.toThrow('destroy unavailable');
        break;
      }
      await step.run(resetRun);
      if (step.id === `detach:${seed.projectId}:preflight`) {
        await expect(laneTool('create', { name: 'race' })).rejects.toMatchObject({
          code: 'LANES_FROZEN',
        });
        expect(resetRun.progress.mock.calls).toEqual(
          expect.arrayContaining([
            [expect.objectContaining({ detachDetails: expect.any(Object) }), { durable: true }],
          ]),
        );
      }
    }
    const afterFailure = (await laneTool('create', { name: 'race' })) as { path: string };
    writeFileSync(join(afterFailure.path, 'uncommitted.txt'), 'work after failure\n');
    const destroy = steps.find((step) => step.id === 'destroy')!;
    await expect(destroy.run(resetRun)).rejects.toMatchObject({ code: 'LANES_EXIST' });
    expect(destroyVm).toHaveBeenCalledTimes(1);
    rmSync(join(afterFailure.path, 'uncommitted.txt'));
    await laneTool('remove', { name: 'race' });
    destroyVm.mockImplementation(async () => {
      await expect(laneTool('create', { name: 'race' })).rejects.toMatchObject({
        code: 'LANES_FROZEN',
      });
      expect(await pair.host.storage.listWorktrees(seed.projectId)).toEqual([]);
      // Destroying a real VM removes this in-memory admission state with its process.
      await pair.host.app.get(WorktreeAdmissionService).setFrozen(seed.projectId, false);
    });
    await destroy.run(resetRun);
    expect(resetRun.details.lanesFrozen).toEqual([]);
    expect(resetRun.details.detachDetails).toMatchObject({
      [seed.projectId]: { lanesFrozen: false },
    });
    expect(destroyVm).toHaveBeenCalledTimes(2);
    await pair.home.storage.updateRemoteOperation(resetRun.operation.id, { state: 'done' });
    occupancy.mockRestore();
    fence.mockRestore();
    pair.home.sqlite
      .prepare(
        "UPDATE remotes SET kind = 'address', base_url = ?, tls_certificate = ? WHERE id = ?",
      )
      .run(remote.baseUrl, remote.tlsCertificate, remote.id);
    await pair.bindProject(seed.projectId, remote.id);
    await files.removeFolder(`git:${seed.projectId}`);
    for (const mock of [health, flipEffect, getRemote, pull, provider, nativeGit])
      mock.mockRestore();
  }

  it('authenticates lane routes and lists tracked lanes, including missing paths', async () => {
    const row = await lane();
    const client = pair.home.app.get(RemoteHostClient);
    const denied = await pair.host.app.inject({
      method: 'GET',
      url: `/api/host/projects/${seed.projectId}/worktrees`,
      remoteAddress: '192.0.2.10',
    });
    expect(denied.statusCode).toBe(401);
    await expect(client.listWorktrees(remote.id, seed.projectId)).resolves.toEqual({
      lanes: [{ name: row.name, path: row.path, branch: row.branch, dirty: false }],
    });
    const guard = pair.home.app.get(RemoteWorktreeGuard);
    await expect(guard.assertRemoteEmpty(remote.id, seed.projectId)).rejects.toMatchObject({
      code: 'LANES_EXIST',
      details: { names: ['storage'] },
    });
    await pair.host.storage.deleteWorktree(row.id);
    const unavailable = await pair.host.storage.createWorktree({
      ...row,
      id: undefined,
      name: 'old',
      path: '/unmanaged-lane',
    });
    await expect(client.listWorktrees(remote.id, seed.projectId)).resolves.toMatchObject({
      lanes: [{ name: 'old', dirty: true }],
    });
    await expect(guard.assertRemoteEmpty(remote.id, seed.projectId)).rejects.toMatchObject({
      code: 'LANES_EXIST',
    });
    await pair.host.storage.deleteWorktree(unavailable.id);
    await expect(guard.assertRemoteEmpty(remote.id, seed.projectId)).resolves.toBeUndefined();
  });

  it('drains the shared Git lock and refuses every mutation while the authenticated freeze is set', async () => {
    let release!: () => void;
    const held = pair.host.app.get(ProjectGitMutex).runExclusive(
      seed.projectId,
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    await Promise.resolve();
    let drained = false;
    const client = pair.home.app.get(RemoteHostClient);
    const freeze = client.setLaneAdmission(remote.id, seed.projectId, true).then(() => {
      drained = true;
    });
    const admission = pair.host.app.get(WorktreeAdmissionService);
    await waitForValue(
      async () => {
        try {
          admission.assertUnfrozen(seed.projectId);
          return false;
        } catch {
          return true;
        }
      },
      1_000,
      10,
    );
    for (const call of [
      () => laneTool('create'),
      () => laneTool('commit', { name: 'storage', message: 'commit' }),
      () => laneTool('merge', { name: 'storage', expectedHead: 'a'.repeat(40) }),
      () => laneTool('remove', { name: 'storage' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'LANES_FROZEN' });
    }
    expect(drained).toBe(false);
    release();
    await Promise.all([held, freeze]);
    await client.setLaneAdmission(remote.id, seed.projectId, false);
    expect(() => admission.assertUnfrozen(seed.projectId)).not.toThrow();
  });

  it('protects lanes during Disconnect and reset, including forced online races, failure, cancel and retry', async () => {
    const row = await lane();
    const detach = pair.home.app
      .get(DetachOperation)
      .steps.find((step) => step.id === 'preflight')!;
    await expect(run(detach, {})).rejects.toMatchObject({ code: 'LANES_EXIST' });
    const reset = pair.home.app.get(ResetVmOperation);
    const details = {
      projectIds: [seed.projectId],
      force: false,
      connectionId: 'connection',
      oldIdentity: 'old',
      spec: { memory: 4096 },
    };
    const getRemote = jest.spyOn(pair.home.storage, 'getRemote').mockResolvedValue({
      ...remote,
      kind: 'proxmox',
      vmProviderConnectionId: 'connection',
      vmIdentity: 'old',
    });
    const preflight = reset.stepsFor(details).find((step) => step.id === 'preflight')!;
    // This fixture has no shared claim registry; isolate lane policy from the
    // independently covered roster guard while retaining both real app graphs.
    const occupancy = jest
      .spyOn(pair.home.app.get(RemoteSharedVmService), 'assertAllowed')
      .mockResolvedValue({ unavailable: false, instances: [] });
    await expect(run(preflight, details)).rejects.toMatchObject({ code: 'LANES_EXIST' });
    await pair.host.storage.deleteWorktree(row.id);
    await expect(run(preflight, details)).resolves.toBeUndefined();
    getRemote.mockRestore();
    occupancy.mockRestore();
    await expect(run(detach, {})).resolves.toBeUndefined();
    const raced = await lane();
    const freezeHost = pair.home.app
      .get(DetachOperation)
      .steps.find((step) => step.id === 'freeze_host')!;
    await expect(run(freezeHost, {})).rejects.toMatchObject({ code: 'LANES_EXIST' });
    await pair.home.app.get(RemoteHostClient).thaw(remote.id, seed.projectId);
    await pair.host.storage.deleteWorktree(raced.id);
    await pair.home.storage.updateRemoteProjectBinding(seed.projectId, { state: 'remote' });
    const localProject = await pair.home.storage.createProject({
      name: 'local-with-lane',
      rootPath: join(pair.rootDir, 'local'),
      description: null,
      isTemplate: false,
    });
    const local = await pair.home.storage.createWorktree({
      ...row,
      id: undefined,
      projectId: localProject.id,
      createdByAgentId: null,
    });
    const attach = pair.home.app
      .get(AttachOperation)
      .steps.find((step) => step.id === 'preflight')!;
    await expect(run(attach, {}, localProject.id)).rejects.toMatchObject({ code: 'LANES_EXIST' });
    const freezeHome = pair.home.app
      .get(AttachOperation)
      .steps.find((step) => step.id === 'freeze_home')!;
    await expect(run(freezeHome, {}, localProject.id)).rejects.toMatchObject({
      code: 'LANES_EXIST',
    });
    await pair.home.app.get(ProjectFreezeService).thaw(localProject.id);
    await pair.home.storage.deleteWorktree(local.id);
    await forcedHandoffRace();
  });

  it('keeps local projects unaffected and gates connected create on the local sender ignore', async () => {
    const files = pair.host.app.get(FileSyncService) as unknown as FakeFileSyncService;
    await files.ensureFolder({
      projectId: seed.projectId,
      kind: 'git',
      type: 'receiveonly',
      peerDeviceId: 'home',
      ignores: ['/worktrees'],
    });
    for (const call of [
      () => laneTool('create'),
      () => laneTool('commit', { name: 'missing', message: 'commit' }),
      () => laneTool('merge', { name: 'missing', expectedHead: 'a'.repeat(40) }),
      () => laneTool('remove', { name: 'missing' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'GIT_NOT_OWNED' });
    }
    await files.updateFolder(`git:${seed.projectId}`, { type: 'sendonly', ignores: ['*.lock'] });
    await expect(laneTool('create')).rejects.toMatchObject({
      code: 'GIT_SYNC_IGNORES_PENDING',
    });
    const homeFiles = pair.home.app.get(FileSyncService) as unknown as FakeFileSyncService;
    homeFiles.gitProjects.add(seed.projectId);
    await homeFiles.ensureFolder({
      projectId: seed.projectId,
      kind: 'code',
      type: 'sendreceive',
      peerDeviceId: files.deviceId,
      ignores: ['/.git'],
    });
    await files.ensureFolder({
      projectId: seed.projectId,
      kind: 'code',
      type: 'sendreceive',
      peerDeviceId: homeFiles.deviceId,
      ignores: ['/.git'],
    });
    await homeFiles.ensureFolder({
      projectId: seed.projectId,
      kind: 'git',
      type: 'receiveonly',
      peerDeviceId: files.deviceId,
      ignores: ['*.lock'],
    });
    const upkeep = pair.home.app.get(RemoteFileSyncService);
    for (let attempt = 0; attempt < 4; attempt++)
      await upkeep.tick(seed.projectId, remote.id, () => true);
    for (const side of [homeFiles, files])
      expect((await side.installedIgnores(`git:${seed.projectId}`)).ignore).toContain('/worktrees');
    await expect(
      pair.host.app.get(WorktreeAdmissionService).assertOwned(seed.projectId, true),
    ).resolves.toBeUndefined();
    // Repair an already configured connection too, without a new Connect or acknowledgement.
    for (const side of [homeFiles, files])
      await side.updateFolder(`git:${seed.projectId}`, { ignores: ['*.lock'] });
    // Upkeep repairs ignores at most once per 30 s check interval.
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    try {
      await upkeep.tick(seed.projectId, remote.id, () => true);
    } finally {
      clock.mockRestore();
    }
    for (const side of [homeFiles, files])
      expect((await side.installedIgnores(`git:${seed.projectId}`)).ignore).toContain('/worktrees');
    await files.removeFolder(`git:${seed.projectId}`);
    await expect(
      pair.host.app.get(WorktreeAdmissionService).assertOwned(seed.projectId, true),
    ).resolves.toBeUndefined();
  });

  it('refuses offline Disconnect/reset unless forced and records the exact warning', async () => {
    online = false;
    jest
      .spyOn(pair.home.app.get(RemoteHealthService), 'refresh')
      .mockResolvedValue({ online: false, versionMatches: true, apiKeyRejected: false } as never);
    const detach = pair.home.app
      .get(DetachOperation)
      .steps.find((step) => step.id === 'preflight')!;
    await expect(run(detach, {})).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' });
    const details: Record<string, unknown> = { force: true };
    await expect(run(detach, details)).resolves.toBeUndefined();
    expect(details.laneWarning).toBe(UNKNOWN_VM_LANES_WARNING);
    await pair.home.storage.updateRemoteProjectBinding(seed.projectId, { state: 'remote' });
    const reset = pair.home.app.get(ResetVmOperation);
    const resetDetails = {
      projectIds: [seed.projectId],
      force: false,
      // Accept unknown occupancy separately to exercise the existing offline
      // lane/login force behavior through the real roster service.
      forceOccupied: true,
      confirmedOccupancy: { unavailable: true, instances: [] },
      connectionId: 'connection',
      oldIdentity: 'old',
      spec: { memory: 4096 },
    };
    jest.spyOn(pair.home.storage, 'getRemote').mockResolvedValue({
      ...remote,
      kind: 'proxmox',
      vmProviderConnectionId: 'connection',
      vmIdentity: 'old',
    });
    const step = reset.stepsFor(resetDetails).find((item) => item.id === 'preflight')!;
    await expect(run(step, resetDetails)).rejects.toMatchObject({ code: 'REMOTE_OFFLINE' });
    Object.assign(resetDetails, { force: true });
    await expect(run(step, resetDetails)).resolves.toBeUndefined();
    expect((resetDetails as Record<string, unknown>).laneWarnings).toEqual([
      { projectId: seed.projectId, warning: UNKNOWN_VM_LANES_WARNING },
    ]);
    // A fresh failed health probe also preserves the forced unreachable path.
    online = true;
    const unavailable = jest
      .spyOn(pair.home.app.get(RemoteHostClient), 'setLaneAdmission')
      .mockRejectedValue(new Error('host transport unavailable'));
    const unreachable: Record<string, unknown> = { force: true };
    await expect(run(detach, unreachable)).resolves.toBeUndefined();
    expect(unreachable.laneWarning).toBe(UNKNOWN_VM_LANES_WARNING);
    await pair.home.storage.updateRemoteProjectBinding(seed.projectId, { state: 'remote' });
    await expect(run(step, resetDetails)).resolves.toBeUndefined();
    expect((resetDetails as Record<string, unknown>).laneWarnings).toEqual([
      { projectId: seed.projectId, warning: UNKNOWN_VM_LANES_WARNING },
    ]);
    unavailable.mockRestore();
    await pair.home.app.get(RemoteHostClient).setLaneAdmission(remote.id, seed.projectId, false);
  });
});
