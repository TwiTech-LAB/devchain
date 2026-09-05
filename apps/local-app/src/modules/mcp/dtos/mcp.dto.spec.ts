import { ZodError } from 'zod';
import {
  AddEpicCommentParamsSchema,
  CreateEpicParamsSchema,
  DeleteEpicParamsSchema,
  DeleteEpicResponse,
  GetEpicByIdParamsSchema,
  EpicRelationsListParamsSchema,
  EpicRelationCandidatesListParamsSchema,
  EpicRelationsSetParamsSchema,
  EpicRelationsDeleteParamsSchema,
  ProjectsListParamsSchema,
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
  it.each([
    'aaaaaaaa',
    'aaaaaaaa-b',
    'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
  ])('accepts valid project address %s for send_message', (recipientProjectId) => {
    expect(
      SendMessageParamsSchema.safeParse({
        sessionId: 'abcd1234',
        recipientProjectId,
        message: 'hello',
      }).success,
    ).toBe(true);
  });

  it.each([
    'aaaaaaa',
    'aaaaaaaa_',
    'aaaaaaaa-bbbbb',
    'aaaaaaaa-b-bbbb',
    'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeeee',
  ])('rejects malformed project address %s for send_message', (recipientProjectId) => {
    expect(
      SendMessageParamsSchema.safeParse({
        sessionId: 'abcd1234',
        recipientProjectId,
        message: 'hello',
      }).success,
    ).toBe(false);
  });

  it.each([
    ['recipientAgentNames', ['Beta']],
    ['teamName', 'Platform'],
  ])('rejects recipientProjectId with %s', (field, value) => {
    expect(
      SendMessageParamsSchema.safeParse({
        sessionId: 'abcd1234',
        recipientProjectId: 'aaaaaaaa',
        [field]: value,
        message: 'hello',
      }).success,
    ).toBe(false);
  });

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

  it.each([
    ['threadId', '00000000-0000-0000-0000-000000000000'],
    ['recipient', 'user'],
  ])('rejects retired send_message field %s as an unrecognized key', (field, value) => {
    const result = SendMessageParamsSchema.safeParse({
      sessionId: 'abcd1234',
      [field]: value,
      message: 'hello',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'unrecognized_keys', keys: [field] }),
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

  it('allows the transport-neutral project send response', () => {
    const response: SendMessageResponse = {
      mode: 'project',
      targetProject: { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', shortId: 'aaaaaaaa', name: 'B' },
      deliveryStatus: 'failed',
      error: { code: 'DELIVERY_FAILED', message: 'Delivery failed' },
    };

    expect(response.mode).toBe('project');
  });
});

describe('ProjectsListParamsSchema', () => {
  it('accepts only sessionId, limit, and offset with pagination defaults', () => {
    expect(ProjectsListParamsSchema.parse({ sessionId: 'abcd1234' })).toEqual({
      sessionId: 'abcd1234',
      limit: 100,
      offset: 0,
    });
    expect(
      ProjectsListParamsSchema.safeParse({
        sessionId: 'abcd1234',
        limit: 25,
        offset: 5,
        rootPath: '/private/project',
      }).success,
    ).toBe(false);
  });

  it('rejects invalid pagination', () => {
    expect(ProjectsListParamsSchema.safeParse({ sessionId: 'abcd1234', limit: 101 }).success).toBe(
      false,
    );
    expect(ProjectsListParamsSchema.safeParse({ sessionId: 'abcd1234', offset: -1 }).success).toBe(
      false,
    );
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

  describe('DeleteEpicParamsSchema.id', () => {
    it('accepts a full UUID', () => {
      expect(() =>
        DeleteEpicParamsSchema.parse({ sessionId: 'abcd1234', id: FULL_UUID }),
      ).not.toThrow();
    });

    it('accepts an 8-char hex prefix', () => {
      expect(() =>
        DeleteEpicParamsSchema.parse({ sessionId: 'abcd1234', id: PREFIX_8 }),
      ).not.toThrow();
    });

    it('rejects strings shorter than 8 chars', () => {
      expect(() => DeleteEpicParamsSchema.parse({ sessionId: 'abcd1234', id: TOO_SHORT })).toThrow(
        ZodError,
      );
    });

    it('rejects strings longer than 36 chars', () => {
      expect(() => DeleteEpicParamsSchema.parse({ sessionId: 'abcd1234', id: TOO_LONG })).toThrow(
        ZodError,
      );
    });

    it('rejects SQL LIKE wildcards (% and _)', () => {
      expect(() =>
        DeleteEpicParamsSchema.parse({ sessionId: 'abcd1234', id: WITH_WILDCARDS }),
      ).toThrow(ZodError);
    });

    it('rejects unknown keys such as version', () => {
      expect(() =>
        DeleteEpicParamsSchema.parse({
          sessionId: 'abcd1234',
          id: FULL_UUID,
          version: 1,
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

  describe('UpdateEpicParamsSchema.assignment stringified-input compatibility', () => {
    const base = {
      sessionId: 'abcd1234',
      id: '00000000-0000-0000-0000-000000000001',
      version: 1,
    };

    it('accepts stringified assignment with agentName', () => {
      const result = UpdateEpicParamsSchema.parse({
        ...base,
        assignment: '{"agentName":"Coder"}',
      });
      expect(result.assignment).toEqual({ agentName: 'Coder' });
    });

    it('accepts stringified assignment with clear:true', () => {
      const result = UpdateEpicParamsSchema.parse({
        ...base,
        assignment: '{"clear":true}',
      });
      expect(result.assignment).toEqual({ clear: true });
    });

    it('accepts object assignment with agentName', () => {
      const result = UpdateEpicParamsSchema.parse({
        ...base,
        assignment: { agentName: 'Coder' },
      });
      expect(result.assignment).toEqual({ agentName: 'Coder' });
    });

    it('accepts object assignment with clear:true', () => {
      const result = UpdateEpicParamsSchema.parse({
        ...base,
        assignment: { clear: true },
      });
      expect(result.assignment).toEqual({ clear: true });
    });

    it('rejects invalid JSON string as assignment', () => {
      expect(() =>
        UpdateEpicParamsSchema.parse({
          ...base,
          assignment: 'not-json',
        }),
      ).toThrow(ZodError);
    });

    it('rejects valid JSON but wrong shape for assignment', () => {
      expect(() =>
        UpdateEpicParamsSchema.parse({
          ...base,
          assignment: '{"wrong":"field"}',
        }),
      ).toThrow(ZodError);
    });
  });
});

describe('MCP Epic relation DTO schemas', () => {
  const base = {
    sessionId: 'abcd1234',
    epicId: '11111111-1111-4111-8111-111111111111',
  };

  it('accepts strict bounded relation list pages and rejects invalid bounds', () => {
    expect(EpicRelationsListParamsSchema.parse({ ...base, limit: 25, offset: 5 })).toEqual({
      ...base,
      limit: 25,
      offset: 5,
    });
    expect(EpicRelationsListParamsSchema.safeParse({ ...base, limit: 101 }).success).toBe(false);
    expect(EpicRelationsListParamsSchema.safeParse({ ...base, offset: -1 }).success).toBe(false);
    expect(EpicRelationsListParamsSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });

  it('bounds and trims candidate search', () => {
    expect(
      EpicRelationCandidatesListParamsSchema.parse({ ...base, q: ' peer ', limit: 10 }),
    ).toMatchObject({ q: 'peer', limit: 10 });
    expect(
      EpicRelationCandidatesListParamsSchema.safeParse({ ...base, q: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  it.each(['related', 'blocks', 'blocked_by'] as const)(
    'accepts the focal-relative %s value for set and atomic create',
    (relation) => {
      expect(
        EpicRelationsSetParamsSchema.safeParse({
          ...base,
          relatedEpicId: '22222222',
          relation,
        }).success,
      ).toBe(true);
      expect(
        CreateEpicParamsSchema.safeParse({
          sessionId: base.sessionId,
          title: 'Atomic',
          relation: { relatedEpicId: '22222222', relation },
        }).success,
      ).toBe(true);
    },
  );

  it('rejects the removed timeRoute field on set while related writes stay strict', () => {
    expect(
      EpicRelationsSetParamsSchema.safeParse({
        ...base,
        relatedEpicId: '22222222',
        relation: 'related',
      }),
    ).toMatchObject({ success: true });
    expect(
      EpicRelationsSetParamsSchema.safeParse({
        ...base,
        relatedEpicId: '22222222',
        relation: 'related',
        timeRoute: 'focal_to_related',
      }).success,
    ).toBe(false);
    expect(
      EpicRelationsSetParamsSchema.safeParse({
        ...base,
        relatedEpicId: '22222222',
        relation: 'related',
        timeRoute: 'none',
      }).success,
    ).toBe(false);
    expect(
      EpicRelationsSetParamsSchema.safeParse({
        ...base,
        relatedEpicId: '22222222',
        relation: 'related',
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('keeps initial Epic creation free of relation direction fields', () => {
    expect(
      CreateEpicParamsSchema.safeParse({
        sessionId: base.sessionId,
        title: 'Atomic',
        timeRoute: 'focal_to_related',
      }).success,
    ).toBe(false);
    expect(
      CreateEpicParamsSchema.safeParse({
        sessionId: base.sessionId,
        title: 'Atomic',
        relation: {
          relatedEpicId: '22222222',
          relation: 'related',
          timeRoute: 'focal_to_related',
        },
      }).success,
    ).toBe(false);
  });

  it('keeps create relation nested and strict while update remains unchanged', () => {
    expect(
      CreateEpicParamsSchema.safeParse({
        sessionId: base.sessionId,
        title: 'Atomic',
        relation: { relatedEpicId: '22222222', relation: 'related', extra: true },
      }).success,
    ).toBe(false);
    expect(
      UpdateEpicParamsSchema.safeParse({
        sessionId: base.sessionId,
        id: base.epicId,
        version: 1,
        relation: { relatedEpicId: '22222222', relation: 'related' },
      }).success,
    ).toBe(false);
    expect(
      EpicRelationsDeleteParamsSchema.safeParse({
        ...base,
        relatedEpicId: '22222222',
        relation: 'related',
      }).success,
    ).toBe(false);
  });
});

describe('MCP epic delete DTO response shape', () => {
  it('supports the minimal delete response contract', () => {
    const response: DeleteEpicResponse = {
      id: '00000000-0000-0000-0000-000000000001',
      deleted: true,
    };

    expect(response.id).toBe('00000000-0000-0000-0000-000000000001');
    expect(response.deleted).toBe(true);
  });
});
