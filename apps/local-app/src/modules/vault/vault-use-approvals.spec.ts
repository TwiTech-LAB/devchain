/**
 * The in-memory approval state of sessions. Test layer: unit. The store has no I/O but
 * the session lookup, so a stub row store covers every rule; the gate order and token
 * use across HTTP calls live in the resolve route's integration test.
 */
import type { SessionRowStore } from '../storage/sessions/session-row.store';
import { VaultUseApprovalStore } from './vault-use-approvals';

const RUNNING = 'running-session';
const STOPPED = 'stopped-session';

describe('VaultUseApprovalStore', () => {
  let store: VaultUseApprovalStore;

  beforeEach(() => {
    const rows = {
      getSession: (id: string) => ({ status: id === RUNNING ? 'running' : 'stopped' }),
    } as unknown as SessionRowStore;
    store = new VaultUseApprovalStore(rows);
  });

  it.each<[string, (store: VaultUseApprovalStore) => void]>([
    ['a session approval', (s) => s.approveSession(STOPPED, 'e1')],
    ['a one-shot approval', (s) => s.approveOnce(STOPPED, 'e1')],
    ['a denial', (s) => s.deny(STOPPED, 'e1')],
  ])('refuses %s for a session that is not running and stores nothing', (_name, write) => {
    expect(() => write(store)).toThrow(
      expect.objectContaining({ details: { code: 'VAULT_REQUEST_SESSION_ENDED' } }),
    );
    expect(store.reserveOnce(STOPPED, ['e1']).entryIds.size).toBe(0);
    expect([store.isDenied(STOPPED, 'e1'), store.hasSessionApproval(STOPPED, 'e1')]).toEqual([
      false,
      false,
    ]);
  });

  it('gives each one-shot approval to one reservation, and back on release', () => {
    store.approveOnce(RUNNING, 'e1');
    const first = store.reserveOnce(RUNNING, ['e1', 'e1']);
    const second = store.reserveOnce(RUNNING, ['e1']);
    expect([[...first.entryIds], [...second.entryIds]]).toEqual([['e1'], []]);

    first.release();
    first.release();
    const third = store.reserveOnce(RUNNING, ['e1']);
    third.commit();
    third.release();

    expect(store.reserveOnce(RUNNING, ['e1']).entryIds.size).toBe(0);
  });

  it('lifts a denial on approval and forgets everything when the session stops', () => {
    store.deny(RUNNING, 'e1');
    store.approveSession(RUNNING, 'e1');
    expect([store.isDenied(RUNNING, 'e1'), store.hasSessionApproval(RUNNING, 'e1')]).toEqual([
      false,
      true,
    ]);
    store.approveOnce(RUNNING, 'e2');
    const held = store.reserveOnce(RUNNING, ['e2']);

    store.onSessionStopped({ sessionId: RUNNING } as never);
    held.release();

    expect(store.hasSessionApproval(RUNNING, 'e1')).toBe(false);
    expect(store.reserveOnce(RUNNING, ['e2']).entryIds.size).toBe(0);
  });
});
