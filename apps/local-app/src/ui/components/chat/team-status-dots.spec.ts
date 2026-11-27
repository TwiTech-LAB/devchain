import type { AgentPresence } from '@/ui/lib/sessions';
import {
  getAttentionReasons,
  getDotState,
  getTeamDots,
  summarizeTeamDots,
} from './team-status-dots';

// Layer: pure unit. State precedence, order and summary are plain functions of their input;
// no rendering is needed to catch a wrong rule.
describe('getDotState', () => {
  const offline: AgentPresence = { online: false };
  const idle: AgentPresence = { online: true, activityState: 'idle' };
  const unknown: AgentPresence = { online: true, activityState: null };
  const busy: AgentPresence = { online: true, activityState: 'busy' };
  const ask = (presence: AgentPresence): AgentPresence => ({ ...presence, pendingQuestion: true });

  it.each([
    { name: 'busy with a question', presence: ask(busy), disabled: false, state: 'waiting' },
    { name: 'idle with a question', presence: ask(idle), disabled: false, state: 'waiting' },
    { name: 'offline with a question', presence: ask(offline), disabled: false, state: 'offline' },
    { name: 'busy', presence: busy, disabled: false, state: 'working' },
    { name: 'online idle', presence: idle, disabled: false, state: 'idle' },
    { name: 'online, no activity state', presence: unknown, disabled: false, state: 'idle' },
    { name: 'offline', presence: offline, disabled: false, state: 'offline' },
    { name: 'no presence entry', presence: undefined, disabled: false, state: 'offline' },
    {
      name: 'quiet tool run: turn busy, terminal idle',
      presence: { ...idle, turnActivityState: 'busy' } as AgentPresence,
      disabled: false,
      state: 'working',
    },
    {
      name: 'output after a finished turn: turn idle, terminal busy',
      presence: { ...busy, turnActivityState: 'idle' } as AgentPresence,
      disabled: false,
      state: 'idle',
    },
    {
      name: 'no turn state from the server, terminal busy',
      presence: { ...busy, turnActivityState: null } as AgentPresence,
      disabled: false,
      state: 'working',
    },
    {
      name: 'turn busy with a question',
      presence: ask({ ...idle, turnActivityState: 'busy' }),
      disabled: false,
      state: 'waiting',
    },
    { name: 'disabled, busy with a question', presence: ask(busy), disabled: true, state: null },
    { name: 'disabled, offline', presence: offline, disabled: true, state: null },
  ])('$name → $state', ({ presence, disabled, state }) => {
    expect(getDotState({ disabled }, presence, getAttentionReasons(presence))).toBe(state);
  });
});

describe('getTeamDots and summarizeTeamDots', () => {
  const team = [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', disabled: true },
    { id: 'lead', name: 'Lead' },
    { id: 'c', name: 'C' },
  ];
  const presence = {
    lead: { online: true, activityState: 'busy' as const, pendingQuestion: true },
    c: { online: true, activityState: 'busy' as const, busySince: '2026-01-01T00:00:00.000Z' },
  };

  it('gives the lead no dot, drops disabled agents and leaves zero counts out', () => {
    const dots = getTeamDots(team, 'lead', presence);
    expect(dots.map((dot) => [dot.agentId, dot.state, dot.busySince])).toEqual([
      ['a', 'offline', null],
      ['c', 'working', '2026-01-01T00:00:00.000Z'],
    ]);
    expect(summarizeTeamDots('Planning', dots)).toBe('Planning: 1 working, 1 offline');
  });

  it('shows every enabled agent of a team with no lead', () => {
    const dots = getTeamDots(team, null, presence);
    expect(dots.map((dot) => [dot.agentId, dot.state])).toEqual([
      ['a', 'offline'],
      ['lead', 'waiting'],
      ['c', 'working'],
    ]);
  });

  it('takes the busy start time from the same source as the state', () => {
    const terminalStart = '2026-01-01T00:05:00.000Z';
    const turnStart = '2026-01-01T00:00:00.000Z';
    const dots = getTeamDots(
      [
        { id: 'turn', name: 'Turn' },
        { id: 'quiet', name: 'Quiet' },
        { id: 'old', name: 'Old server' },
      ],
      null,
      {
        turn: {
          online: true,
          activityState: 'busy',
          busySince: terminalStart,
          turnActivityState: 'busy',
          turnBusySince: turnStart,
        },
        // The terminal has been quiet for longer than its timeout; the turn still runs.
        quiet: {
          online: true,
          activityState: 'idle',
          busySince: null,
          turnActivityState: 'busy',
          turnBusySince: turnStart,
        },
        old: { online: true, activityState: 'busy', busySince: terminalStart },
      },
    );
    expect(dots.map((dot) => [dot.agentId, dot.state, dot.busySince])).toEqual([
      ['turn', 'working', turnStart],
      ['quiet', 'working', turnStart],
      ['old', 'working', terminalStart],
    ]);
  });
});
