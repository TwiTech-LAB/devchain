// Local Syncthing is the ownership authority; no VM GitOwnerStore is involved.
import { FileSyncService } from '../file-sync/file-sync.service';
import { FakeFileSyncService } from '../file-sync/testing/fake-file-sync.service';
import type { GitCoordinatorService } from '../remotes/git-coordinator/git-coordinator.service';
import { ProjectGitMutex } from './project-git-mutex';
import { WorktreeAdmissionService } from './worktree-admission.service';

describe('WorktreeAdmissionService', () => {
  let files: FakeFileSyncService;
  let mutex: ProjectGitMutex;
  let admission: WorktreeAdmissionService;

  beforeEach(() => {
    files = new FakeFileSyncService();
    mutex = new ProjectGitMutex();
    // A permit that never opens shows which mutations bypass the coordinator.
    const closed = { withVmPermit: () => new Promise<never>(() => undefined) };
    admission = new WorktreeAdmissionService(
      files as unknown as FileSyncService,
      mutex,
      closed as unknown as GitCoordinatorService,
    );
  });

  it('runs local project mutations without a coordinator permit', async () => {
    await expect(admission.withPermit('p', async () => 'ran')).resolves.toBe('ran');
  });

  it('allows local projects with a confirmed absent folder, including create', async () => {
    await expect(admission.assertOwned('p', true)).resolves.toBeUndefined();
  });

  it.each(['sendonly', 'receiveonly', 'sendreceive'] as const)(
    'checks %s and paused ownership',
    async (type) => {
      await files.ensureFolder({
        projectId: 'p',
        kind: 'git',
        type,
        paused: false,
        peerDeviceId: 'peer',
        ignores: ['/worktrees'],
      });
      if (type === 'sendonly')
        await expect(admission.assertOwned('p', true)).resolves.toBeUndefined();
      else
        await expect(admission.assertOwned('p')).rejects.toMatchObject({ code: 'GIT_NOT_OWNED' });
      await files.updateFolder('git:p', { paused: true });
      await expect(admission.assertOwned('p')).rejects.toMatchObject({ code: 'GIT_NOT_OWNED' });
    },
  );

  it('fails closed for an unreachable Syncthing or ignore read', async () => {
    jest.spyOn(files, 'folderConfiguration').mockRejectedValueOnce(new Error('unreachable'));
    await expect(admission.assertOwned('p')).rejects.toMatchObject({
      code: 'GIT_OWNERSHIP_UNKNOWN',
    });
    await files.ensureFolder({
      projectId: 'p',
      kind: 'git',
      type: 'sendonly',
      peerDeviceId: 'peer',
      ignores: ['/worktrees'],
    });
    jest.spyOn(files, 'installedIgnores').mockRejectedValueOnce(new Error('unreachable'));
    await expect(admission.assertOwned('p', true)).rejects.toMatchObject({
      code: 'GIT_SYNC_IGNORES_PENDING',
    });
  });

  it('refuses create until the local sender ignore is installed', async () => {
    await files.ensureFolder({
      projectId: 'p',
      kind: 'git',
      type: 'sendonly',
      peerDeviceId: 'peer',
      ignores: ['*.lock'],
    });
    await expect(admission.assertOwned('p', true)).rejects.toMatchObject({
      code: 'GIT_SYNC_IGNORES_PENDING',
    });
    await expect(admission.assertOwned('p')).resolves.toBeUndefined();
    await files.updateFolder('git:p', { ignores: ['/worktrees'] });
    await expect(admission.assertOwned('p', true)).resolves.toBeUndefined();
  });

  it('closes admission immediately, drains in-flight work and refuses queued mutations', async () => {
    let release!: () => void;
    const held = mutex.runExclusive(
      'p',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const queued = mutex.runExclusive('p', () => admission.assertOwned('p'));
    const rejected = expect(queued).rejects.toMatchObject({ code: 'LANES_FROZEN' });
    let drained = false;
    const frozen = admission.setFrozen('p', true).then(() => {
      drained = true;
    });
    expect(() => admission.assertUnfrozen('p')).toThrow(
      expect.objectContaining({ code: 'LANES_FROZEN' }),
    );
    expect(drained).toBe(false);
    release();
    await Promise.all([held, rejected, frozen]);
    expect(drained).toBe(true);
    await admission.setFrozen('p', false);
    await expect(admission.assertOwned('p')).resolves.toBeUndefined();
  });
});
