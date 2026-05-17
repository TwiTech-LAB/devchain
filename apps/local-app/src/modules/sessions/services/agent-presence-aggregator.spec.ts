import { aggregatePresence } from './agent-presence-aggregator';
import { TerminalSessionRegistry } from '../../terminal/services/terminal-session/terminal-session-registry';

describe('aggregatePresence', () => {
  it('returns online=true with activity state for sessions in registry', () => {
    const registry = new TerminalSessionRegistry();
    const session = registry.create('s1', 'tmux-s1');
    session.subscribe('client-1');
    session.pushFrame('output');

    const result = aggregatePresence(registry, [{ sessionId: 's1', agentId: 'agent-1' }]);

    expect(result.size).toBe(1);
    const entry = result.get('agent-1')!;
    expect(entry.online).toBe(true);
    expect(entry.sessionId).toBe('s1');
    expect(entry.activityState).toBe('busy');
    expect(entry.lastActivityAt).toBeDefined();
    expect(entry.busySince).toBeDefined();
  });

  it('returns online=false for agents without sessions in registry', () => {
    const registry = new TerminalSessionRegistry();

    const result = aggregatePresence(registry, [], new Set(['agent-1', 'agent-2']));

    expect(result.get('agent-1')!.online).toBe(false);
    expect(result.get('agent-2')!.online).toBe(false);
  });

  it('aggregates across multiple sessions', () => {
    const registry = new TerminalSessionRegistry();
    const s1 = registry.create('s1', 'tmux-s1');
    const s2 = registry.create('s2', 'tmux-s2');
    s1.pushFrame('data');
    s2.subscribe('c1');

    const result = aggregatePresence(registry, [
      { sessionId: 's1', agentId: 'agent-1' },
      { sessionId: 's2', agentId: 'agent-2' },
    ]);

    expect(result.get('agent-1')!.online).toBe(true);
    expect(result.get('agent-2')!.online).toBe(true);
  });

  it('returns idle state when session has been marked idle', () => {
    const registry = new TerminalSessionRegistry();
    const session = registry.create('s1', 'tmux-s1');
    session.pushFrame('output');
    session.markIdle();

    const result = aggregatePresence(registry, [{ sessionId: 's1', agentId: 'agent-1' }]);

    expect(result.get('agent-1')!.activityState).toBe('idle');
    expect(result.get('agent-1')!.busySince).toBeNull();
  });

  it('returns null activity state when session has no activity', () => {
    const registry = new TerminalSessionRegistry();
    registry.create('s1', 'tmux-s1');

    const result = aggregatePresence(registry, [{ sessionId: 's1', agentId: 'agent-1' }]);

    expect(result.get('agent-1')!.activityState).toBeNull();
    expect(result.get('agent-1')!.lastActivityAt).toBeNull();
  });

  it('skips mappings for sessions not in registry', () => {
    const registry = new TerminalSessionRegistry();

    const result = aggregatePresence(
      registry,
      [{ sessionId: 'nonexistent', agentId: 'agent-1' }],
      new Set(['agent-1']),
    );

    expect(result.get('agent-1')!.online).toBe(false);
  });

  it('tracks input activity via signalInput', () => {
    const registry = new TerminalSessionRegistry();
    const session = registry.create('s1', 'tmux-s1');
    session.signalInput();

    const result = aggregatePresence(registry, [{ sessionId: 's1', agentId: 'agent-1' }]);

    expect(result.get('agent-1')!.activityState).toBe('busy');
  });
});
