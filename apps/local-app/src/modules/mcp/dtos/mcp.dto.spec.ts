import { ZodError } from 'zod';
import {
  ChatAckParamsSchema,
  ChatListMembersParamsSchema,
  CreateEpicParamsSchema,
  TmuxSessionIdSchema,
  RegisterGuestParamsSchema,
  UpdateEpicParamsSchema,
} from './mcp.dto';

describe('TmuxSessionIdSchema - command injection prevention', () => {
  describe('valid session IDs', () => {
    it('accepts alphanumeric session IDs', () => {
      expect(() => TmuxSessionIdSchema.parse('mysession123')).not.toThrow();
    });

    it('accepts session IDs with dashes', () => {
      expect(() => TmuxSessionIdSchema.parse('my-session-name')).not.toThrow();
    });

    it('accepts session IDs with underscores', () => {
      expect(() => TmuxSessionIdSchema.parse('my_session_name')).not.toThrow();
    });

    it('accepts session IDs with periods', () => {
      expect(() => TmuxSessionIdSchema.parse('session.v1.0')).not.toThrow();
    });

    it('accepts devchain-style session names', () => {
      expect(() =>
        TmuxSessionIdSchema.parse('devchain_myproject_epic-123_agent-456_session-789'),
      ).not.toThrow();
    });
  });

  describe('malicious session IDs - command injection attempts', () => {
    it('rejects semicolon command injection: "; rm -rf /"', () => {
      expect(() => TmuxSessionIdSchema.parse('; rm -rf /')).toThrow(ZodError);
    });

    it('rejects command substitution: "$(whoami)"', () => {
      expect(() => TmuxSessionIdSchema.parse('$(whoami)')).toThrow(ZodError);
    });

    it('rejects backtick command substitution: "`whoami`"', () => {
      expect(() => TmuxSessionIdSchema.parse('`whoami`')).toThrow(ZodError);
    });

    it('rejects pipe injection: "| cat /etc/passwd"', () => {
      expect(() => TmuxSessionIdSchema.parse('| cat /etc/passwd')).toThrow(ZodError);
    });

    it('rejects ampersand background: "& malicious-cmd"', () => {
      expect(() => TmuxSessionIdSchema.parse('& malicious')).toThrow(ZodError);
    });

    it('rejects newline injection', () => {
      expect(() => TmuxSessionIdSchema.parse('session\nmalicious')).toThrow(ZodError);
    });

    it('rejects carriage return injection', () => {
      expect(() => TmuxSessionIdSchema.parse('session\rmalicious')).toThrow(ZodError);
    });

    it('rejects spaces (potential argument injection)', () => {
      expect(() => TmuxSessionIdSchema.parse('session -t other')).toThrow(ZodError);
    });

    it('rejects quotes (shell escape attempts)', () => {
      expect(() => TmuxSessionIdSchema.parse("session'; echo pwned")).toThrow(ZodError);
      expect(() => TmuxSessionIdSchema.parse('session"; echo pwned')).toThrow(ZodError);
    });

    it('rejects redirection operators', () => {
      expect(() => TmuxSessionIdSchema.parse('session > /tmp/pwned')).toThrow(ZodError);
      expect(() => TmuxSessionIdSchema.parse('session < /etc/passwd')).toThrow(ZodError);
    });
  });

  describe('length constraints', () => {
    it('rejects empty session ID', () => {
      expect(() => TmuxSessionIdSchema.parse('')).toThrow(ZodError);
    });

    it('rejects session ID exceeding 128 characters', () => {
      const longId = 'a'.repeat(129);
      expect(() => TmuxSessionIdSchema.parse(longId)).toThrow(ZodError);
    });

    it('accepts session ID at max length (128 chars)', () => {
      const maxId = 'a'.repeat(128);
      expect(() => TmuxSessionIdSchema.parse(maxId)).not.toThrow();
    });
  });
});

describe('RegisterGuestParamsSchema - uses secure tmuxSessionId validation', () => {
  it('rejects malicious tmuxSessionId in guest registration', () => {
    expect(() =>
      RegisterGuestParamsSchema.parse({
        name: 'MyGuest',
        tmuxSessionId: '; rm -rf /',
      }),
    ).toThrow(ZodError);
  });

  it('accepts valid guest registration params', () => {
    expect(() =>
      RegisterGuestParamsSchema.parse({
        name: 'MyGuest',
        tmuxSessionId: 'valid-session-123',
      }),
    ).not.toThrow();
  });
});

describe('MCP chat DTO schemas', () => {
  it('requires thread_id for list members tool', () => {
    expect(() => ChatListMembersParamsSchema.parse({})).toThrow(ZodError);
    expect(() =>
      ChatListMembersParamsSchema.parse({ thread_id: '00000000-0000-0000-0000-000000000000' }),
    ).not.toThrow();
  });

  it('validates devchain_chat_ack parameters', () => {
    // Only required params: sessionId, thread_id, message_id
    // agent_id and agent_name are response fields, not request params
    expect(() =>
      ChatAckParamsSchema.parse({
        sessionId: '00000000-0000-0000-0000-000000000003',
        thread_id: '00000000-0000-0000-0000-000000000000',
        message_id: '00000000-0000-0000-0000-000000000001',
      }),
    ).not.toThrow();

    expect(() => ChatAckParamsSchema.parse({ thread_id: 'missing' })).toThrow(ZodError);
  });

  it('rejects unknown keys in strict mode', () => {
    // Strict mode should reject extraneous fields
    expect(() =>
      ChatAckParamsSchema.parse({
        sessionId: '00000000-0000-0000-0000-000000000003',
        thread_id: '00000000-0000-0000-0000-000000000000',
        message_id: '00000000-0000-0000-0000-000000000001',
        unknown_field: 'should fail',
      }),
    ).toThrow(ZodError);
  });

  it('reports unrecognized_keys issue code for unknown params', () => {
    const result = ChatAckParamsSchema.safeParse({
      sessionId: '00000000-0000-0000-0000-000000000003',
      thread_id: '00000000-0000-0000-0000-000000000000',
      message_id: '00000000-0000-0000-0000-000000000001',
      unknown_param: 'value',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const unrecognizedIssue = result.error.issues.find(
        (issue) => issue.code === 'unrecognized_keys',
      );
      expect(unrecognizedIssue).toBeDefined();
      expect((unrecognizedIssue as { keys: string[] }).keys).toContain('unknown_param');
    }
  });
});

describe('MCP epic DTO schemas - skillsRequired validation', () => {
  it('normalizes and deduplicates skillsRequired for create epic params', () => {
    const parsed = CreateEpicParamsSchema.parse({
      sessionId: 'abcd1234',
      title: 'Epic',
      skillsRequired: [' OpenAI/Review ', 'openai/review', 'anthropic/pdf'],
    });

    expect(parsed.skillsRequired).toEqual(['openai/review', 'anthropic/pdf']);
  });

  it('rejects malformed skillsRequired values for create epic params', () => {
    expect(() =>
      CreateEpicParamsSchema.parse({
        sessionId: 'abcd1234',
        title: 'Epic',
        skillsRequired: ['openai'],
      }),
    ).toThrow(ZodError);
  });

  it('rejects malformed skillsRequired values for update epic params', () => {
    expect(() =>
      UpdateEpicParamsSchema.parse({
        sessionId: 'abcd1234',
        id: '00000000-0000-0000-0000-000000000001',
        version: 1,
        skillsRequired: ['../traversal'],
      }),
    ).toThrow(ZodError);
  });
});
