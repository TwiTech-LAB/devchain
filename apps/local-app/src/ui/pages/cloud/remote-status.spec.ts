import type { RemoteListItemDto } from '@/modules/remotes/dtos/remote.dto';
import type { RemoteOperationDto } from '@/ui/hooks/useRemoteOperations';
import type { RemoteProjectBindingRow } from '@/ui/lib/backend-provider';
import {
  POWER_ON_GRACE_MS,
  attentionItems,
  createStatusContext,
  projectRecovery,
  projectStatus,
  stepProgress,
  vmStatus,
  type StatusInput,
} from './remote-status';

const NOW = Date.parse('2026-09-28T12:00:00.000Z');

function remote(overrides: Partial<RemoteListItemDto> = {}): RemoteListItemDto {
  return {
    id: 'vm1',
    name: 'lab-vm',
    baseUrl: 'http://10.0.0.5:4000',
    kind: 'address',
    vmProviderConnectionId: null,
    vmIdentity: null,
    vmSpec: null,
    tlsCertificate: null,
    tlsFingerprint: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    online: true,
    version: '1.0.0',
    versionMatches: true,
    uid: 1000,
    gid: 1000,
    stats: null,
    lastSeenAt: '2026-09-28T11:00:00.000Z',
    homePath: '/home/alice',
    homePathMatches: true,
    lastOperation: null,
    userName: null,
    logins: { claude: { choice: 'reuse', entryIds: ['e1'] } },
    ...overrides,
  };
}

type Step = RemoteOperationDto['steps'][number];

function step(id: string, state: Step['state'], error: string | null = null): Step {
  return {
    id,
    label: `Label of ${id}`,
    state,
    error: error === null ? null : { message: error, code: null },
  };
}

let sequence = 0;

function operation(overrides: Partial<RemoteOperationDto> = {}): RemoteOperationDto {
  sequence += 1;
  return {
    id: `op${sequence}`,
    kind: 'claim',
    remoteId: 'vm1',
    projectId: null,
    state: 'running',
    steps: [step('a', 'done'), step('b', 'running'), step('c', 'pending')],
    details: {},
    createdAt: new Date(Date.UTC(2026, 8, 28, 10, 0, sequence)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 8, 28, 10, 0, sequence)).toISOString(),
    ...overrides,
  };
}

function binding(overrides: Partial<RemoteProjectBindingRow> = {}): RemoteProjectBindingRow {
  return { projectId: 'p1', remoteId: 'vm1', state: 'remote', ...overrides };
}

function context(input: Partial<StatusInput> = {}) {
  return createStatusContext({
    remotes: [remote()],
    bindings: [],
    operations: [],
    projectNames: new Map([
      ['p1', 'Alpha'],
      ['p2', 'Beta'],
    ]),
    now: NOW,
    formatTime: (iso) => `<${iso}>`,
    ...input,
  });
}

function vm(overrides: Partial<RemoteListItemDto> = {}, input: Partial<StatusInput> = {}) {
  const target = remote(overrides);
  return vmStatus(target, context({ remotes: [target], ...input }));
}

// Layer: UI pure-module unit (Jest). The status model is pure data in, data
// out, so each table row is cheapest to prove here without rendering a page.
describe('vmStatus', () => {
  describe('row 1: removed', () => {
    it('reads "Setup cancelled" after a cancelled create_vm', () => {
      expect(
        vm({
          baseUrl: null,
          kind: 'proxmox',
          lastOperation: {
            id: 'x',
            kind: 'create_vm',
            state: 'cancelled',
            updatedAt: '2026-09-28T10:00:00.000Z',
          },
        }),
      ).toMatchObject({
        state: 'removed',
        label: 'Setup cancelled',
        tone: 'neutral',
        action: { kind: 'remove', label: 'Remove from list' },
      });
    });

    it('reads "VM destroyed" after a done destroy_vm', () => {
      expect(
        vm({
          baseUrl: null,
          kind: 'proxmox',
          lastOperation: {
            id: 'x',
            kind: 'destroy_vm',
            state: 'done',
            updatedAt: '2026-09-28T10:00:00.000Z',
          },
        }),
      ).toMatchObject({ state: 'removed', label: 'VM destroyed' });
    });
  });

  describe('row 2: busy', () => {
    it.each([
      ['claim', {}, 'Setting up'],
      ['install_host', {}, 'Installing'],
      ['update_host', { versionChange: true }, 'Updating'],
      ['update_host', { dockerChange: true, versionChange: false }, 'Installing Docker'],
      ['update_logins', {}, 'Changing logins'],
      ['create_vm', {}, 'Creating'],
      ['reset_vm', {}, 'Resetting'],
      ['destroy_vm', {}, 'Destroying'],
    ])('reads %s %j as "%s" with its step', (kind, details, label) => {
      const running = operation({ kind, details });
      expect(vm({}, { operations: [running] })).toMatchObject({
        state: 'busy',
        label,
        note: 'step 2 of 3',
        tone: 'running',
        action: { kind: 'open-activity', operationId: running.id },
        operation: running,
      });
    });

    it('ignores a running project operation on the VM', () => {
      const attach = operation({ kind: 'attach', projectId: 'p1' });
      expect(vm({}, { operations: [attach] }).state).toBe('ready');
    });
  });

  describe('row 3: stopped', () => {
    it.each([
      ['claim', {}, 'Setup stopped'],
      ['install_host', {}, 'Install stopped'],
      ['update_host', {}, 'Update stopped'],
      ['update_host', { dockerChange: true, versionChange: false }, 'Docker install stopped'],
      ['update_logins', {}, 'Login change stopped'],
      ['create_vm', {}, 'Create stopped'],
      ['reset_vm', {}, 'Reset stopped'],
      ['destroy_vm', {}, 'Destroy stopped'],
    ])('reads a failed %s %j as "%s" and offers Resolve', (kind, details, label) => {
      const failed = operation({ kind, details, state: 'failed' });
      expect(vm({ online: false, logins: null }, { operations: [failed] })).toMatchObject({
        state: 'stopped',
        label,
        tone: 'error',
        action: { kind: 'resolve', label: 'Resolve', operationId: failed.id },
      });
    });

    it('ignores done and cancelled operations', () => {
      const done = operation({ kind: 'claim', state: 'done' });
      const cancelled = operation({ kind: 'update_host', state: 'cancelled' });
      expect(vm({}, { operations: [done, cancelled] }).state).toBe('ready');
    });
  });

  describe('row 4: not set up', () => {
    it('reads "Not set up" for an address VM added before its setup', () => {
      expect(vm({ online: false, logins: null })).toMatchObject({
        state: 'not-set-up',
        label: 'Not set up',
        tone: 'neutral',
        action: { kind: 'set-up', label: 'Set up' },
      });
    });

    it.each(['claim', 'install_host'] as const)(
      'reads "Setup cancelled" after a cancelled %s',
      (kind) => {
        expect(
          vm({
            online: false,
            logins: null,
            lastOperation: {
              id: 'x',
              kind,
              state: 'cancelled',
              updatedAt: '2026-09-28T10:00:00.000Z',
            },
          }),
        ).toMatchObject({ state: 'not-set-up', label: 'Setup cancelled' });
      },
    );

    it('lets an online address VM without logins follow rows 9–11', () => {
      expect(vm({ online: true, logins: null }).state).toBe('ready');
    });
  });

  it('row 5: reads "Provisioning" without an address', () => {
    expect(vm({ baseUrl: null, kind: 'proxmox', online: false })).toMatchObject({
      state: 'provisioning',
      label: 'Provisioning',
      tone: 'running',
      action: null,
    });
  });

  it('row 6: offers Power on for a stopped Proxmox VM', () => {
    expect(vm({ kind: 'proxmox', online: false, powerState: 'stopped' })).toMatchObject({
      state: 'powered-off',
      label: 'Powered off',
      tone: 'warn',
      action: { kind: 'power-on', label: 'Power on' },
    });
  });

  describe('row 7: starting', () => {
    const starting = { kind: 'proxmox' as const, online: false, powerState: 'running' as const };

    it('reads "Starting" within 3 minutes of a Power on from this page', () => {
      const poweredOnAt = new Map([['vm1', NOW - POWER_ON_GRACE_MS + 1_000]]);
      expect(vm(starting, { poweredOnAt })).toMatchObject({
        state: 'starting',
        label: 'Starting',
        tone: 'running',
        action: null,
      });
    });

    it('reads "Not answering" after 3 minutes', () => {
      const poweredOnAt = new Map([['vm1', NOW - POWER_ON_GRACE_MS]]);
      expect(vm(starting, { poweredOnAt })).toMatchObject({
        state: 'starting',
        label: 'Not answering',
        tone: 'warn',
      });
    });

    it('reads "Not answering" without a Power on from this page', () => {
      expect(vm(starting).label).toBe('Not answering');
    });
  });

  describe('row 8: offline', () => {
    it('reads "Offline since <lastSeenAt>"', () => {
      expect(vm({ online: false })).toMatchObject({
        state: 'offline',
        label: 'Offline since <2026-09-28T11:00:00.000Z>',
        tone: 'neutral',
        action: null,
      });
    });

    it('reads "Never reached" when the VM never answered', () => {
      expect(vm({ online: false, lastSeenAt: null }).label).toBe('Never reached');
    });

    it('reads "Unreachable" for Proxmox with an unknown power state', () => {
      expect(vm({ kind: 'proxmox', online: false, powerState: 'unknown' }).label).toBe(
        'Unreachable',
      );
    });

    it('warns when it holds projects', () => {
      expect(vm({ online: false }, { bindings: [binding()] }).tone).toBe('warn');
    });
  });

  it('row 9: offers Update when the version differs', () => {
    expect(vm({ versionMatches: false, homePathMatches: false })).toMatchObject({
      state: 'update-needed',
      label: 'Update needed',
      tone: 'warn',
      action: { kind: 'update', label: 'Update' },
    });
  });

  it('row 10: reads "Home folder differs"', () => {
    expect(vm({ homePathMatches: false })).toMatchObject({
      state: 'home-mismatch',
      label: 'Home folder differs',
      tone: 'warn',
      action: null,
    });
  });

  it('row 11: reads "Ready", also when the home folder is unknown', () => {
    expect(vm()).toMatchObject({ state: 'ready', label: 'Ready', tone: 'ok', action: null });
    expect(vm({ homePathMatches: null }).state).toBe('ready');
  });

  describe('chips', () => {
    const docker = {
      installed: true,
      engineVersion: '27.0.0',
      composeVersion: '2.29.0',
      userInGroup: true,
      dataRootFreeBytes: null,
    };

    it('shows "Docker" when Docker is usable', () => {
      expect(vm({ docker }).chips).toEqual([{ key: 'docker', label: 'Docker', tone: 'neutral' }]);
    });

    it('shows "Docker · restart needed" when DevChain lacks the group', () => {
      expect(vm({ docker: { ...docker, userInGroup: false } }).chips).toEqual([
        { key: 'docker', label: 'Docker · restart needed', tone: 'warn' },
      ]);
    });

    it('shows no Docker chip when Docker is not installed', () => {
      expect(vm({ docker: { ...docker, installed: false } }).chips).toEqual([]);
    });

    it('shows one chip per running project operation', () => {
      const attach = operation({ kind: 'attach', projectId: 'p1' });
      const detach = operation({
        kind: 'detach',
        projectId: 'p2',
        steps: [step('a', 'running'), step('b', 'pending'), step('c', 'skipped')],
      });
      const failedAttach = operation({ kind: 'attach', projectId: 'p1', state: 'failed' });
      const chips = vm({}, { operations: [attach, detach, failedAttach] }).chips;
      expect(chips).toEqual([
        {
          key: detach.id,
          label: 'Disconnecting Beta, 1/2',
          tone: 'running',
          operationId: detach.id,
        },
        { key: attach.id, label: 'Connecting Alpha, 2/3', tone: 'running', operationId: attach.id },
      ]);
    });
  });
});

describe('projectStatus', () => {
  function project(input: Partial<StatusInput> = {}, projectId = 'p1') {
    return projectStatus(projectId, context(input));
  }

  it.each<[string, string, Record<string, unknown>]>([
    ['attach', 'Connecting to lab-vm', {}],
    ['detach', 'Disconnecting from lab-vm', {}],
    ['force_sync', 'Force syncing', {}],
    ['git_owner', 'Moving Git to the VM', { owner: 'vm' }],
    ['git_owner', 'Moving Git to this PC', { owner: 'home' }],
  ])('row 1: a running %s makes the project busy', (kind, label, details) => {
    const running = operation({ kind, projectId: 'p1', details });
    expect(
      project({ operations: [running], bindings: [binding({ state: 'attaching' })] }),
    ).toMatchObject({
      state: 'busy',
      label,
      note: 'step 2 of 3',
      tone: 'running',
      action: { kind: 'view', operationId: running.id },
    });
  });

  it('never calls a project busy from its binding state alone', () => {
    expect(project({ bindings: [binding({ state: 'attaching' })] }).state).not.toBe('busy');
  });

  it.each([
    ['attach', 'Connect stopped'],
    ['detach', 'Disconnect stopped'],
    ['force_sync', 'Force sync stopped'],
    ['git_owner', 'Git switch stopped'],
  ])('row 2: a failed %s stops the project with the error first line', (kind, label) => {
    const failed = operation({
      kind,
      projectId: 'p1',
      state: 'failed',
      steps: [step('a', 'done'), step('b', 'failed', 'Host refused\nstack trace')],
    });
    expect(project({ operations: [failed] })).toMatchObject({
      state: 'stopped',
      label,
      note: 'Host refused',
      tone: 'error',
      action: { kind: 'resolve', label: 'Resolve', operationId: failed.id },
    });
  });

  describe('row 3: cleanup failed', () => {
    it('reports the release error of the newest operation and offers Connect', () => {
      const cancelled = operation({
        kind: 'attach',
        projectId: 'p1',
        state: 'cancelled',
        details: { hostReleaseError: 'VM refused the release' },
      });
      expect(
        project({
          bindings: [binding({ state: 'failed' })],
          newestProjectOperations: new Map([['p1', cancelled]]),
        }),
      ).toMatchObject({
        state: 'cleanup-failed',
        label: 'Connect cancelled. The copy on lab-vm was not removed.',
        note: 'VM refused the release',
        tone: 'warn',
        action: { kind: 'connect', disabledReason: null },
      });
    });

    it('falls back to the Docker cleanup error', () => {
      const cancelled = operation({
        kind: 'attach',
        projectId: 'p1',
        state: 'cancelled',
        details: { dockerCleanupError: 'container busy' },
      });
      expect(
        project({
          bindings: [binding({ state: 'failed' })],
          newestProjectOperations: new Map([['p1', cancelled]]),
        }).note,
      ).toBe('container busy');
    });
  });

  describe('row 4: leftover', () => {
    it('offers Disconnect for a leftover detaching binding', () => {
      expect(project({ bindings: [binding({ state: 'detaching' })] })).toMatchObject({
        state: 'leftover',
        label: 'Stuck while disconnecting',
        tone: 'error',
        action: { kind: 'disconnect', label: 'Disconnect' },
      });
    });

    it('offers View for a leftover attaching binding', () => {
      const newest = operation({ kind: 'attach', projectId: 'p1', state: 'cancelled' });
      expect(
        project({
          bindings: [binding({ state: 'attaching' })],
          newestProjectOperations: new Map([['p1', newest]]),
        }),
      ).toMatchObject({
        state: 'leftover',
        label: 'Stuck while connecting',
        action: { kind: 'view', operationId: newest.id },
      });
    });
  });

  describe('row 5: remote', () => {
    it.each([
      [{ syncError: 'disk full' }, {}, 'Sync failed: disk full', 'error'],
      [{ fileSyncWarning: 'Retrying file sync' }, {}, 'Retrying file sync', 'warn'],
      [{}, { online: false }, 'VM offline', 'warn'],
      [{}, { versionMatches: false }, 'Blocked until lab-vm is updated', 'warn'],
      [{}, {}, 'Files in sync', 'ok'],
    ])('notes %j on a VM %j as "%s"', (bindingFields, remoteFields, note, tone) => {
      expect(
        project({ remotes: [remote(remoteFields)], bindings: [binding(bindingFields)] }),
      ).toMatchObject({
        state: 'remote',
        label: 'On lab-vm',
        note,
        tone,
        action: { kind: 'disconnect' },
      });
    });
  });

  describe('row 6: local', () => {
    it('offers Connect when a VM is ready', () => {
      expect(project()).toMatchObject({
        state: 'local',
        label: 'This PC',
        tone: 'neutral',
        action: { kind: 'connect', disabledReason: null },
      });
    });

    it('asks to add a VM first when none exists', () => {
      expect(project({ remotes: [] }).action).toMatchObject({ disabledReason: 'Add a VM first' });
    });

    it('says no VM is ready when none is', () => {
      expect(project({ remotes: [remote({ versionMatches: false })] }).action).toMatchObject({
        disabledReason: 'No VM is ready',
      });
    });
  });
});

describe('projectRecovery', () => {
  function failedAttach(bindState: Step['state'] | null) {
    return operation({
      kind: 'attach',
      projectId: 'p1',
      state: 'failed',
      steps: [
        step('preflight', 'done'),
        ...(bindState ? [step('bind_remote', bindState)] : []),
        step('thaw_host', 'pending'),
      ],
    });
  }

  it('offers Retry and Cancel before bind_remote has started', () => {
    expect(projectRecovery(failedAttach('pending'))).toEqual(['retry', 'cancel']);
  });

  it.each(['running', 'failed'] as const)('offers only Retry with bind_remote %s', (state) => {
    expect(projectRecovery(failedAttach(state))).toEqual(['retry']);
  });

  it('offers Retry and "Disconnect instead" after bind_remote is done', () => {
    expect(projectRecovery(failedAttach('done'))).toEqual(['retry', 'disconnect-instead']);
  });

  it('offers Retry, Cancel and "Force disconnect" for a failed detach', () => {
    expect(
      projectRecovery(operation({ kind: 'detach', projectId: 'p1', state: 'failed' })),
    ).toEqual(['retry', 'cancel', 'force-disconnect']);
  });

  it('has nothing for a running or non-project operation', () => {
    expect(projectRecovery(operation({ kind: 'attach', projectId: 'p1' }))).toBeNull();
    expect(projectRecovery(operation({ kind: 'claim', state: 'failed' }))).toBeNull();
  });
});

describe('attentionItems', () => {
  it('says nothing when all is well', () => {
    expect(attentionItems(context())).toEqual([]);
  });

  it('lists every rule in order, errors before warnings', () => {
    const failedClaim = operation({
      kind: 'claim',
      remoteId: 'vm-failed',
      state: 'failed',
      steps: [step('check', 'failed', 'SSH refused.\nmore')],
    });
    const cancelledAttach = operation({
      kind: 'attach',
      projectId: 'p-cleanup',
      remoteId: 'vm-ready',
      state: 'cancelled',
      details: { hostReleaseError: 'Copy busy.' },
    });
    const ctx = context({
      remotes: [
        remote({ id: 'vm-failed', name: 'failed-vm', online: false }),
        remote({
          id: 'vm-off',
          name: 'off-vm',
          kind: 'proxmox',
          online: false,
          powerState: 'stopped',
        }),
        remote({ id: 'vm-down', name: 'down-vm', online: false }),
        remote({ id: 'vm-old', name: 'old-vm', version: '0.9.0', versionMatches: false }),
        remote({ id: 'vm-home', name: 'home-vm', homePath: '/home/bob', homePathMatches: false }),
        remote({ id: 'vm-ready', name: 'ready-vm' }),
      ],
      bindings: [
        binding({ projectId: 'p-sync', remoteId: 'vm-ready', syncError: 'disk full' }),
        binding({ projectId: 'p-off', remoteId: 'vm-off' }),
        binding({ projectId: 'p-down1', remoteId: 'vm-down' }),
        binding({ projectId: 'p-down2', remoteId: 'vm-down' }),
        binding({ projectId: 'p-old', remoteId: 'vm-old' }),
        binding({ projectId: 'p-cleanup', remoteId: 'vm-ready', state: 'failed' }),
        binding({
          projectId: 'p-warn',
          remoteId: 'vm-ready',
          fileSyncWarning: 'Retrying file sync',
        }),
      ],
      operations: [failedClaim],
      newestProjectOperations: new Map([['p-cleanup', cancelledAttach]]),
      projectNames: new Map([
        ['p-sync', 'Sync'],
        ['p-off', 'Off'],
        ['p-down1', 'Down1'],
        ['p-down2', 'Down2'],
        ['p-old', 'Old'],
        ['p-cleanup', 'Cleanup'],
        ['p-warn', 'Warn'],
      ]),
    });

    const items = attentionItems(ctx, {
      syncthing: { ok: false, message: 'Install Syncthing 1.27 or later' },
      version: '1.0.0',
      homePath: '/home/alice',
    });

    expect(items.map((item) => [item.tone, item.text, item.action])).toEqual([
      [
        'error',
        'Setup of failed-vm stopped at “Label of check”: SSH refused.',
        { kind: 'open-activity', label: 'Open', operationId: failedClaim.id },
      ],
      [
        'error',
        'Sync: sync failed: disk full.',
        { kind: 'view-vm', label: 'View', remoteId: 'vm-ready' },
      ],
      ['error', 'Syncthing is not usable on this PC: Install Syncthing 1.27 or later.', null],
      [
        'warn',
        'off-vm is powered off. 1 project waits for it.',
        { kind: 'view-vm', label: 'View', remoteId: 'vm-off' },
      ],
      [
        'warn',
        'down-vm is offline. 2 projects wait for it.',
        { kind: 'view-vm', label: 'View', remoteId: 'vm-down' },
      ],
      [
        'warn',
        'old-vm runs DevChain 0.9.0. This PC runs 1.0.0. Requests to Old are blocked until you update.',
        { kind: 'view-vm', label: 'View', remoteId: 'vm-old' },
      ],
      [
        'warn',
        'home-vm uses the home folder /home/bob. This PC uses /home/alice. Projects cannot connect to it.',
        { kind: 'view-vm', label: 'View', remoteId: 'vm-home' },
      ],
      ['warn', 'Cleanup: the copy on ready-vm was not removed. Copy busy.', null],
      ['warn', 'Warn: Retrying file sync.', null],
    ]);
  });

  // Pure status mapping is the cheapest layer for counts-only and legacy warning behavior.
  it.each([
    [{ home: 1, vm: 0 }, true],
    [{ home: 0, vm: 2 }, true],
    [{ home: 0, vm: 0 }, false],
    [undefined, false],
  ] as const)('offers a distinct Fix action for failed counts %j', (fileSyncFailed, actionable) => {
    const ctx = context({
      bindings: [binding({ fileSyncWarning: 'File sync warning', fileSyncFailed })],
    });
    const item = attentionItems(ctx).find((item) => item.key === 'file-sync:p1');
    expect(item?.action).toEqual(
      actionable ? { kind: 'fix-file-sync', label: 'Fix', projectId: 'p1' } : null,
    );
  });

  it('puts an error found late before earlier warnings', () => {
    const ctx = context({
      remotes: [remote({ id: 'vm-old', name: 'old-vm', versionMatches: false })],
      bindings: [binding({ projectId: 'p1', remoteId: 'vm-old', syncError: 'boom' })],
    });
    expect(attentionItems(ctx).map((item) => item.tone)).toEqual(['error', 'warn']);
  });

  it('reports Syncthing only when a VM exists', () => {
    expect(
      attentionItems(context({ remotes: [] }), { syncthing: { ok: false, message: 'x' } }),
    ).toEqual([]);
  });

  it('skips offline VMs that hold no projects', () => {
    expect(attentionItems(context({ remotes: [remote({ online: false })] }))).toEqual([]);
  });

  it('lists one error per VM and provider with a failed managed CLI install', () => {
    const failed = (error: string | null) => ({
      desiredVersion: 'latest' as const,
      installedVersion: '1.0.0',
      state: 'failed' as const,
      error,
      checkedAt: null,
    });
    const ctx = context({
      remotes: [
        remote({
          id: 'v1',
          name: 'lab-vm',
          providerClis: { claude: failed('npm 404'), codex: failed(null) },
        }),
        remote({
          id: 'v2',
          name: 'build-vm',
          providerClis: { copilot: failed('disk full') },
        }),
      ],
    });
    expect(attentionItems(ctx)).toEqual([
      {
        key: 'cli:v1:claude',
        tone: 'error',
        text: 'Claude CLI on lab-vm failed: npm 404.',
        action: { kind: 'view-vm', label: 'View', remoteId: 'v1' },
      },
      {
        key: 'cli:v1:codex',
        tone: 'error',
        text: 'Codex CLI on lab-vm failed.',
        action: { kind: 'view-vm', label: 'View', remoteId: 'v1' },
      },
      {
        key: 'cli:v2:copilot',
        tone: 'error',
        text: 'Copilot CLI on build-vm failed: disk full.',
        action: { kind: 'view-vm', label: 'View', remoteId: 'v2' },
      },
    ]);
  });

  it('reports no CLI line once the install succeeds', () => {
    const idle = {
      desiredVersion: 'latest' as const,
      installedVersion: '2.0.0',
      state: 'idle' as const,
      error: null,
      checkedAt: null,
    };
    expect(
      attentionItems(context({ remotes: [remote({ providerClis: { claude: idle } })] })),
    ).toEqual([]);
  });
});

describe('transitions', () => {
  it('a newer project operation does not hide an older failed update_logins', () => {
    const failedLogins = operation({ kind: 'update_logins', state: 'failed' });
    const newerAttach = operation({ kind: 'attach', projectId: 'p1', state: 'done' });
    const status = vm(
      {
        lastOperation: {
          id: newerAttach.id,
          kind: 'attach',
          state: 'done',
          updatedAt: newerAttach.updatedAt,
        },
      },
      { operations: [newerAttach, failedLogins] },
    );
    expect(status).toMatchObject({
      state: 'stopped',
      label: 'Login change stopped',
      action: { kind: 'resolve', operationId: failedLogins.id },
    });
  });
});

describe('stepProgress', () => {
  it('counts done steps when none is active and leaves skipped steps out', () => {
    expect(
      stepProgress(
        operation({ steps: [step('a', 'done'), step('b', 'skipped'), step('c', 'pending')] }),
      ),
    ).toEqual({ current: 2, total: 2 });
  });
});

// Pure status/menu functions are the cheapest layer for precedence and action visibility.
describe('API key rejection status', () => {
  it('takes precedence over offline and gives a direct recovery attention action', () => {
    const vm = remote({ online: false, apiKeyRejected: true });
    const ctx = context({ remotes: [vm] });
    expect(vmStatus(vm, ctx)).toMatchObject({
      state: 'api-key-rejected',
      label: 'API key rejected',
      action: { kind: 'enter-api-key' },
    });
    expect(attentionItems(ctx)).toContainEqual(
      expect.objectContaining({
        key: 'api-key:vm1',
        action: { kind: 'enter-api-key', label: 'Enter API key', remoteId: 'vm1' },
      }),
    );
  });
});

// The pure status model is the cheapest layer for warning actions and VM progress chips.
it.each(['error', 'stalled', 'setup', 'connection', 'failed-files'] as const)(
  'offers a Fix action for %s without failed-file counts only when recoverable',
  (fileSyncProblem) => {
    const ctx = context({
      bindings: [binding({ fileSyncWarning: 'Sync needs attention.', fileSyncProblem })],
    });
    const item = attentionItems(ctx).find((item) => item.key === 'file-sync:p1');
    expect(item?.action).toEqual(
      ['error', 'stalled', 'setup'].includes(fileSyncProblem)
        ? { kind: 'fix-file-sync', label: 'Fix', projectId: 'p1' }
        : null,
    );
  },
);
it('shows Force syncing as a project operation on the VM', () => {
  const running = operation({ kind: 'force_sync', projectId: 'p1' });
  const ctx = context({ bindings: [binding()], operations: [running] });
  expect(vmStatus(remote(), ctx).chips).toContainEqual(
    expect.objectContaining({ operationId: running.id, label: 'Force syncing Alpha, 2/3' }),
  );
});
