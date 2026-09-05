import { BusyError } from '../../../common/errors/error-types';
import {
  exactConnectionOperationGateKey,
  projectProviderOperationGateKey,
  ProviderOperationGate,
} from './provider-operation-gate';

// Pure concurrency primitive — the cheapest reliable layer.

describe('ProviderOperationGate', () => {
  it('builds a pure stable key from project and provider identity', () => {
    expect(projectProviderOperationGateKey('project-1', 'jira')).toBe('project-1:jira');
    expect(projectProviderOperationGateKey('project-2', 'jira')).toBe('project-2:jira');
  });

  it('builds an isolated key for exact unassigned connection work', () => {
    expect(exactConnectionOperationGateKey('connection-1')).toBe('connection:connection-1');
    expect(exactConnectionOperationGateKey('connection-2')).toBe('connection:connection-2');
  });

  it('serializes operations under the same key when the caller retries past busy', async () => {
    const gate = new ProviderOperationGate();
    const order: string[] = [];
    const first = gate.run('clickup', async () => {
      order.push('a-start');
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push('a-end');
    });
    // The immediate second caller is rejected busy and retries after release.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(gate.run('clickup', async () => undefined)).rejects.toMatchObject({
      details: { reason: 'operation_in_progress' },
    });
    await first;
    await gate.run('clickup', async () => {
      order.push('b-start');
    });
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('rejects a concurrent caller with BusyError immediately', async () => {
    const gate = new ProviderOperationGate();
    let releaseFirst: () => void = () => undefined;
    const first = gate.run(
      'jira',
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    await Promise.resolve();
    expect(gate.isHeld('jira')).toBe(true);
    await expect(gate.run('jira', async () => undefined)).rejects.toBeInstanceOf(BusyError);
    releaseFirst();
    await first;
    expect(gate.isHeld('jira')).toBe(false);
  });

  it('releases the key after a failure so later operations can proceed', async () => {
    const gate = new ProviderOperationGate();
    await expect(
      gate.run('clickup', async () => {
        throw new Error('vendor failure');
      }),
    ).rejects.toThrow('vendor failure');
    expect(gate.isHeld('clickup')).toBe(false);
    await expect(gate.run('clickup', async () => 'ok')).resolves.toBe('ok');
  });

  it('keeps different provider keys independent', async () => {
    const gate = new ProviderOperationGate();
    let releaseClickUp: () => void = () => undefined;
    const held = gate.run(
      'clickup',
      () =>
        new Promise<void>((resolve) => {
          releaseClickUp = resolve;
        }),
    );
    await Promise.resolve();
    await expect(gate.run('jira', async () => 'jira-ok')).resolves.toBe('jira-ok');
    releaseClickUp();
    await held;
  });

  it('keeps the same provider independent across projects', async () => {
    const gate = new ProviderOperationGate();
    let releaseFirst: () => void = () => undefined;
    const held = gate.run(
      { projectId: 'project-1', provider: 'clickup' },
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    await Promise.resolve();

    await expect(
      gate.run({ projectId: 'project-2', provider: 'clickup' }, async () => 'ok'),
    ).resolves.toBe('ok');

    releaseFirst();
    await held;
  });

  it('reports public project and provider fields without exposing the internal gate key', async () => {
    const gate = new ProviderOperationGate();
    let releaseFirst: () => void = () => undefined;
    const scope = { projectId: 'project-1', provider: 'jira' as const };
    const held = gate.run(
      scope,
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    await Promise.resolve();

    const error = await gate.run(scope, async () => undefined).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BusyError);
    expect(error).toMatchObject({
      details: {
        reason: 'operation_in_progress',
        projectId: 'project-1',
        provider: 'jira',
      },
    });
    expect(JSON.stringify((error as BusyError).details)).not.toContain('project-1:jira');
    releaseFirst();
    await held;
  });

  it('serializes one exact legacy connection without blocking project-owned peers', async () => {
    const gate = new ProviderOperationGate();
    let releaseFirst: () => void = () => undefined;
    const scope = { connectionId: 'connection-1', provider: 'jira' as const };
    const held = gate.run(
      scope,
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    await Promise.resolve();

    await expect(gate.run(scope, async () => undefined)).rejects.toMatchObject({
      details: {
        reason: 'operation_in_progress',
        connectionId: 'connection-1',
        provider: 'jira',
      },
    });
    await expect(
      gate.run({ projectId: 'project-1', provider: 'jira' }, async () => 'project-ok'),
    ).resolves.toBe('project-ok');

    releaseFirst();
    await held;
  });
});
