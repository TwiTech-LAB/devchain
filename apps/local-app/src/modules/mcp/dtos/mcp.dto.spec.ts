import { ZodError } from 'zod';
import {
  AddEpicCommentParamsSchema,
  ChatAckParamsSchema,
  ChatListMembersParamsSchema,
  CreateEpicParamsSchema,
  GetEpicByIdParamsSchema,
  SendMessageParamsSchema,
  SendMessageResponse,
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
  it('accepts teamName as a send_message routing target', () => {
    expect(() =>
      SendMessageParamsSchema.parse({
        sessionId: 'abcd1234',
        teamName: 'Platform',
        message: 'hello',
      }),
    ).not.toThrow();
  });

  it('rejects teamName with recipientAgentNames for send_message', () => {
    expect(() =>
      SendMessageParamsSchema.parse({
        sessionId: 'abcd1234',
        teamName: 'Platform',
        recipientAgentNames: ['Beta'],
        message: 'hello',
      }),
    ).toThrow('teamName and recipientAgentNames are mutually exclusive');
  });

  it('rejects teamName with threadId for send_message', () => {
    expect(() =>
      SendMessageParamsSchema.parse({
        sessionId: 'abcd1234',
        teamName: 'Platform',
        threadId: '00000000-0000-0000-0000-000000000000',
        message: 'hello',
      }),
    ).toThrow('teamName cannot be combined with threadId in v1');
  });

  it('rejects teamName with recipient user for send_message', () => {
    const result = SendMessageParamsSchema.safeParse({
      sessionId: 'abcd1234',
      teamName: 'Platform',
      recipient: 'user',
      message: 'hello',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'teamName cannot be combined with recipient: "user"',
          }),
        ]),
      );
    }
  });

  it('accepts send_message with no routing target (self-team fallback)', () => {
    const result = SendMessageParamsSchema.safeParse({
      sessionId: 'abcd1234',
      message: 'hello',
    });

    expect(result.success).toBe(true);
  });

  it('allows pooled send_message responses to include optional teamDelivery metadata', () => {
    const response: SendMessageResponse = {
      mode: 'pooled',
      queuedCount: 1,
      queued: [{ name: 'Beta', type: 'agent', status: 'queued' }],
      estimatedDeliveryMs: 50,
      teamDelivery: {
        teamName: 'Platform',
        recipientCount: 1,
        routedToLead: true,
        summary: 'Delivered to 1 agent (team lead)',
      },
    };

    expect(response.teamDelivery?.routedToLead).toBe(true);
  });

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

describe('Epic ID prefix support — schema validation', () => {
  const FULL_UUID = '22222222-2222-2222-2222-222222222222';
  const PREFIX_8 = 'abcd1234';
  const TOO_SHORT = 'abcd123'; // 7 chars
  const TOO_LONG = 'a'.repeat(37); // 37 chars — exceeds max 36
  const WITH_WILDCARDS = 'abcd1234%_'; // SQL LIKE wildcards
  const WITH_UPPERCASE = 'ABCD1234'; // uppercase hex — not allowed
  const WITH_SPACES = 'abcd 1234'; // spaces
  const WITH_SPECIAL = 'abcd1234!@#$'; // special chars
  const NON_HEX = 'zzzzzzzz'; // non-hex alpha characters
  const PREFIX_WITH_HYPHENS = 'ed49311c-a3f6'; // valid prefix with hyphens

  describe('GetEpicByIdParamsSchema.id', () => {
    it('accepts a full UUID', () => {
      expect(() =>
        GetEpicByIdParamsSchema.parse({ sessionId: 'abcd1234', id: FULL_UUID }),
      ).not.toThrow();
    });

    it('accepts an 8-char hex prefix', () => {
      expect(() =>
        GetEpicByIdParamsSchema.parse({ sessionId: 'abcd1234', id: PREFIX_8 }),
      ).not.toThrow();
    });

    it('rejects strings shorter than 8 chars', () => {
      expect(() => GetEpicByIdParamsSchema.parse({ sessionId: 'abcd1234', id: TOO_SHORT })).toThrow(
        ZodError,
      );
    });

    it('rejects strings longer than 36 chars', () => {
      expect(() => GetEpicByIdParamsSchema.parse({ sessionId: 'abcd1234', id: TOO_LONG })).toThrow(
        ZodError,
      );
    });

    it('rejects SQL LIKE wildcards (% and _)', () => {
      expect(() =>
        GetEpicByIdParamsSchema.parse({ sessionId: 'abcd1234', id: WITH_WILDCARDS }),
      ).toThrow(ZodError);
    });

    it('rejects uppercase hex characters', () => {
      expect(() =>
        GetEpicByIdParamsSchema.parse({ sessionId: 'abcd1234', id: WITH_UPPERCASE }),
      ).toThrow(ZodError);
    });

    it('rejects special characters', () => {
      expect(() =>
        GetEpicByIdParamsSchema.parse({ sessionId: 'abcd1234', id: WITH_SPECIAL }),
      ).toThrow(ZodError);
    });

    it('rejects non-hex alphabetic characters (e.g., zzzzzzzz)', () => {
      expect(() => GetEpicByIdParamsSchema.parse({ sessionId: 'abcd1234', id: NON_HEX })).toThrow(
        ZodError,
      );
    });

    it('accepts a prefix with hyphens (e.g., ed49311c-a3f6)', () => {
      expect(() =>
        GetEpicByIdParamsSchema.parse({ sessionId: 'abcd1234', id: PREFIX_WITH_HYPHENS }),
      ).not.toThrow();
    });
  });

  describe('UpdateEpicParamsSchema.id', () => {
    it('accepts a full UUID', () => {
      expect(() =>
        UpdateEpicParamsSchema.parse({ sessionId: 'abcd1234', id: FULL_UUID, version: 1 }),
      ).not.toThrow();
    });

    it('accepts an 8-char hex prefix', () => {
      expect(() =>
        UpdateEpicParamsSchema.parse({ sessionId: 'abcd1234', id: PREFIX_8, version: 1 }),
      ).not.toThrow();
    });

    it('rejects strings shorter than 8 chars', () => {
      expect(() =>
        UpdateEpicParamsSchema.parse({ sessionId: 'abcd1234', id: TOO_SHORT, version: 1 }),
      ).toThrow(ZodError);
    });

    it('rejects strings longer than 36 chars', () => {
      expect(() =>
        UpdateEpicParamsSchema.parse({ sessionId: 'abcd1234', id: TOO_LONG, version: 1 }),
      ).toThrow(ZodError);
    });

    it('rejects SQL LIKE wildcards (% and _)', () => {
      expect(() =>
        UpdateEpicParamsSchema.parse({ sessionId: 'abcd1234', id: WITH_WILDCARDS, version: 1 }),
      ).toThrow(ZodError);
    });

    it('rejects spaces and non-hex characters', () => {
      expect(() =>
        UpdateEpicParamsSchema.parse({ sessionId: 'abcd1234', id: WITH_SPACES, version: 1 }),
      ).toThrow(ZodError);
    });
  });

  describe('AddEpicCommentParamsSchema.epicId', () => {
    it('accepts a full UUID', () => {
      expect(() =>
        AddEpicCommentParamsSchema.parse({
          sessionId: 'abcd1234',
          epicId: FULL_UUID,
          content: 'hello',
        }),
      ).not.toThrow();
    });

    it('accepts an 8-char hex prefix', () => {
      expect(() =>
        AddEpicCommentParamsSchema.parse({
          sessionId: 'abcd1234',
          epicId: PREFIX_8,
          content: 'hello',
        }),
      ).not.toThrow();
    });

    it('rejects strings shorter than 8 chars', () => {
      expect(() =>
        AddEpicCommentParamsSchema.parse({
          sessionId: 'abcd1234',
          epicId: TOO_SHORT,
          content: 'hello',
        }),
      ).toThrow(ZodError);
    });

    it('rejects strings longer than 36 chars', () => {
      expect(() =>
        AddEpicCommentParamsSchema.parse({
          sessionId: 'abcd1234',
          epicId: TOO_LONG,
          content: 'hello',
        }),
      ).toThrow(ZodError);
    });

    it('rejects SQL LIKE wildcards (% and _)', () => {
      expect(() =>
        AddEpicCommentParamsSchema.parse({
          sessionId: 'abcd1234',
          epicId: WITH_WILDCARDS,
          content: 'hello',
        }),
      ).toThrow(ZodError);
    });

    it('rejects non-hex characters', () => {
      expect(() =>
        AddEpicCommentParamsSchema.parse({
          sessionId: 'abcd1234',
          epicId: WITH_SPECIAL,
          content: 'hello',
        }),
      ).toThrow(ZodError);
    });
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
