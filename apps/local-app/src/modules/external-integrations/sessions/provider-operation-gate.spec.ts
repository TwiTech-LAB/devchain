import { BusyError } from '../../../common/errors/error-types';
import { ProviderOperationGate } from './provider-operation-gate';

// Pure concurrency primitive — the cheapest reliable layer.

describe('ProviderOperationGate', () => {
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
});
