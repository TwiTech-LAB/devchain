import {
  PendingAskUserQuestionService,
  PENDING_ASK_QUESTION_TTL_MS,
  type SetPendingAskUserQuestionInput,
} from './pending-ask-user-question.service';

jest.mock('../../../common/logging/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}));

const SESSION_A = '33333333-3333-3333-3333-333333333333';
const SESSION_B = '44444444-4444-4444-4444-444444444444';

function input(
  overrides: Partial<SetPendingAskUserQuestionInput> = {},
): SetPendingAskUserQuestionInput {
  return {
    projectId: '11111111-1111-1111-1111-111111111111',
    agentId: '22222222-2222-2222-2222-222222222222',
    sessionId: SESSION_A,
    claudeSessionId: 'claude-1',
    toolUseId: 'toolu_1',
    questions: [
      {
        question: 'Q?',
        header: 'H',
        multiSelect: false,
        options: [{ label: 'A', description: '' }],
      },
    ],
    now: 1000,
    ...overrides,
  };
}

describe('PendingAskUserQuestionService', () => {
  let service: PendingAskUserQuestionService;

  beforeEach(() => {
    service = new PendingAskUserQuestionService();
  });

  it('stores and retrieves a pending entry by session', () => {
    const entry = service.set(input());
    expect(entry.status).toBe('pending');
    expect(entry.expiresAt).toBe(1000 + PENDING_ASK_QUESTION_TTL_MS);

    const found = service.getBySession(SESSION_A, 2000);
    expect(found).toHaveLength(1);
    expect(found[0].toolUseId).toBe('toolu_1');
    expect(found[0].questions[0].header).toBe('H');
  });

  it('scopes entries by session id', () => {
    service.set(input({ sessionId: SESSION_A, toolUseId: 'a' }));
    service.set(input({ sessionId: SESSION_B, toolUseId: 'b' }));

    expect(service.getBySession(SESSION_A, 2000).map((e) => e.toolUseId)).toEqual(['a']);
    expect(service.getBySession(SESSION_B, 2000).map((e) => e.toolUseId)).toEqual(['b']);
  });

  it('clears a single entry by toolUseId', () => {
    service.set(input({ toolUseId: 'a' }));
    service.set(input({ toolUseId: 'b' }));

    expect(service.clearByToolUseId(SESSION_A, 'a')).toBe(true);
    expect(service.getBySession(SESSION_A, 2000).map((e) => e.toolUseId)).toEqual(['b']);
    // clearing a missing key is a no-op
    expect(service.clearByToolUseId(SESSION_A, 'missing')).toBe(false);
  });

  it('clears all entries for a session', () => {
    service.set(input({ toolUseId: 'a' }));
    service.set(input({ toolUseId: 'b' }));
    service.set(input({ sessionId: SESSION_B, toolUseId: 'c' }));

    expect(service.clearBySession(SESSION_A)).toBe(2);
    expect(service.getBySession(SESSION_A, 2000)).toHaveLength(0);
    expect(service.getBySession(SESSION_B, 2000)).toHaveLength(1);
  });

  it('hides entries past the TTL from the poll but keeps them for the turn hold', () => {
    service.set(input({ now: 1000 }));
    const justBefore = 1000 + PENDING_ASK_QUESTION_TTL_MS - 1;
    const atExpiry = 1000 + PENDING_ASK_QUESTION_TTL_MS;

    expect(service.getBySession(SESSION_A, justBefore)).toHaveLength(1);
    expect(service.getBySession(SESSION_A, atExpiry)).toHaveLength(0);
    expect(service.hasPendingQuestion(SESSION_A)).toBe(true);
    expect(service.size()).toBe(1);
  });

  it('never deletes an entry because of time, including when new ones are stored', () => {
    service.set(input({ toolUseId: 'old', now: 1000 }));
    service.set(input({ toolUseId: 'new', now: 1000 + PENDING_ASK_QUESTION_TTL_MS + 5 }));

    const found = service.getBySession(SESSION_A, 1000 + PENDING_ASK_QUESTION_TTL_MS + 10);
    expect(found.map((e) => e.toolUseId)).toEqual(['new']);
    expect(service.size()).toBe(2);
  });

  it('reports a pending question per session until it is cleared', () => {
    service.set(input({ toolUseId: 'a' }));

    expect(service.hasPendingQuestion(SESSION_A)).toBe(true);
    expect(service.hasPendingQuestion(SESSION_B)).toBe(false);

    service.clearByToolUseId(SESSION_A, 'a');
    expect(service.hasPendingQuestion(SESSION_A)).toBe(false);
  });

  it('clears the session on session.stopped', () => {
    service.set(input({ toolUseId: 'a' }));
    service.onSessionStopped({ sessionId: SESSION_A });
    expect(service.getBySession(SESSION_A, 2000)).toHaveLength(0);
  });

  it('clears the session on session.crashed', () => {
    service.set(input({ toolUseId: 'a' }));
    service.onSessionCrashed({ sessionId: SESSION_A });
    expect(service.getBySession(SESSION_A, 2000)).toHaveLength(0);
  });
});
