import { ZodError } from 'zod';
import {
  AddEpicCommentParamsSchema,
  CreateEpicParamsSchema,
  DeleteEpicParamsSchema,
  GetEpicByIdParamsSchema,
  EpicRelationCandidatesListParamsSchema,
  ProjectsListParamsSchema,
  SendMessageParamsSchema,
  TmuxSessionIdSchema,
  RegisterGuestParamsSchema,
  UpdateEpicParamsSchema,
} from './mcp.dto';

describe('TmuxSessionIdSchema - command injection prevention', () => {
  describe('valid session IDs', () => {
    it.each([
      ['accepts alphanumeric session IDs', ['mysession123']],
      ['accepts session IDs with dashes', ['my-session-name']],
      ['accepts session IDs with underscores', ['my_session_name']],
      ['accepts session IDs with periods', ['session.v1.0']],
      [
        'accepts devchain-style session names',
        ['devchain_myproject_epic-123_agent-456_session-789'],
      ],
    ])('%s', (_name, inputs) => {
      for (const input of inputs) expect(TmuxSessionIdSchema.parse(input)).toBe(input);
    });
  });

  describe('malicious session IDs - command injection attempts', () => {
    it.each([
      ['rejects semicolon command injection: "; rm -rf /"', ['; rm -rf /']],
      ['rejects command substitution: "$(whoami)"', ['$(whoami)']],
      ['rejects backtick command substitution: "`whoami`"', ['`whoami`']],
      ['rejects pipe injection: "| cat /etc/passwd"', ['| cat /etc/passwd']],
      ['rejects ampersand background: "& malicious-cmd"', ['& malicious']],
      ['rejects newline injection', ['session\nmalicious']],
      ['rejects carriage return injection', ['session\rmalicious']],
      ['rejects spaces (potential argument injection)', ['session -t other']],
      ['rejects quotes (shell escape attempts)', ["session'; echo pwned", 'session"; echo pwned']],
      ['rejects redirection operators', ['session > /tmp/pwned', 'session < /etc/passwd']],
      ['rejects empty session ID', ['']],
    ])('%s', (_name, inputs) => {
      for (const input of inputs) expect(() => TmuxSessionIdSchema.parse(input)).toThrow(ZodError);
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

  it('accepts send_message with no routing target (self-team fallback)', () => {
    const result = SendMessageParamsSchema.safeParse({
      sessionId: 'abcd1234',
      message: 'hello',
    });

    expect(result.success).toBe(true);
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
});

describe('Epic ID prefix support — schema validation', () => {
  const FULL_UUID = '22222222-2222-2222-2222-222222222222';
  const PREFIX_8 = 'abcd1234';
  const WITH_WILDCARDS = 'abcd1234%_'; // SQL LIKE wildcards
  const WITH_UPPERCASE = 'ABCD1234'; // uppercase hex — not allowed
  const WITH_SPECIAL = 'abcd1234!@#$'; // special chars
  const NON_HEX = 'zzzzzzzz'; // non-hex alpha characters
  const PREFIX_WITH_HYPHENS = 'ed49311c-a3f6'; // valid prefix with hyphens

  describe('GetEpicByIdParamsSchema.id', () => {
    it.each([
      ['accepts a full UUID', FULL_UUID],
      ['accepts an 8-char hex prefix', PREFIX_8],
      ['accepts a prefix with hyphens (e.g., ed49311c-a3f6)', PREFIX_WITH_HYPHENS],
    ])('%s', (_name, id) => {
      const input = { sessionId: 'abcd1234', id };
      expect(GetEpicByIdParamsSchema.parse(input).id).toBe(id);
    });

    it.each([
      ['rejects SQL LIKE wildcards (% and _)', WITH_WILDCARDS],
      ['rejects uppercase hex characters', WITH_UPPERCASE],
      ['rejects special characters', WITH_SPECIAL],
      ['rejects non-hex alphabetic characters (e.g., zzzzzzzz)', NON_HEX],
    ])('%s', (_name, id) => {
      const input = { sessionId: 'abcd1234', id };
      expect(() => GetEpicByIdParamsSchema.parse(input)).toThrow(ZodError);
    });
  });

  describe('UpdateEpicParamsSchema.id', () => {
    it('rejects SQL LIKE wildcards (% and _)', () => {
      expect(() =>
        UpdateEpicParamsSchema.parse({ sessionId: 'abcd1234', id: WITH_WILDCARDS, version: 1 }),
      ).toThrow(ZodError);
    });
  });

  describe('AddEpicCommentParamsSchema.epicId', () => {
    it('rejects SQL LIKE wildcards (% and _)', () => {
      expect(() =>
        AddEpicCommentParamsSchema.parse({
          sessionId: 'abcd1234',
          epicId: WITH_WILDCARDS,
          content: 'hello',
        }),
      ).toThrow(ZodError);
    });
  });

  describe('DeleteEpicParamsSchema.id', () => {
    it('rejects SQL LIKE wildcards (% and _)', () => {
      expect(() =>
        DeleteEpicParamsSchema.parse({ sessionId: 'abcd1234', id: WITH_WILDCARDS }),
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

  describe('CreateEpicParamsSchema relation list', () => {
    const base = { sessionId: 'abcd1234', title: 'Epic' };

    it('keeps the single relation field working and rejects it together with relations', () => {
      expect(
        CreateEpicParamsSchema.safeParse({
          ...base,
          relation: { relatedEpicId: '11111111-1111-4111-8111-111111111111', relation: 'related' },
        }).success,
      ).toBe(true);
      expect(
        CreateEpicParamsSchema.safeParse({
          ...base,
          relation: { relatedEpicId: '11111111-1111-4111-8111-111111111111', relation: 'related' },
          relations: [
            { relatedEpicId: '11111111-1111-4111-8111-111111111112', relation: 'blocks' },
          ],
        }).success,
      ).toBe(false);
    });
  });

  describe('UpdateEpicParamsSchema.assignment stringified-input compatibility', () => {
    const base = {
      sessionId: 'abcd1234',
      id: '00000000-0000-0000-0000-000000000001',
      version: 1,
    };

    it.each([
      ['JSON agentName', '{"agentName":"Coder"}', { agentName: 'Coder' }],
      ['JSON clear', '{"clear":true}', { clear: true }],
      ['object agentName', { agentName: 'Coder' }, { agentName: 'Coder' }],
      ['object clear', { clear: true }, { clear: true }],
    ])('preprocesses assignment %s', (_name, assignment, expected) => {
      expect(UpdateEpicParamsSchema.parse({ ...base, assignment }).assignment).toEqual(expected);
    });

    it('rejects invalid JSON string as assignment', () => {
      expect(() =>
        UpdateEpicParamsSchema.parse({
          ...base,
          assignment: 'not-json',
        }),
      ).toThrow(ZodError);
    });
  });

  describe('UpdateEpicParamsSchema description patch fields', () => {
    const base = {
      sessionId: 'abcd1234',
      id: '00000000-0000-0000-0000-000000000001',
      version: 1,
    };

    it('accepts descriptionEdits and appendDescription together', () => {
      const result = UpdateEpicParamsSchema.parse({
        ...base,
        descriptionEdits: [{ find: 'old', replace: 'new' }],
        appendDescription: 'tail',
      });
      expect(result.descriptionEdits).toEqual([{ find: 'old', replace: 'new' }]);
      expect(result.appendDescription).toBe('tail');
    });

    it('rejects description together with descriptionEdits or appendDescription', () => {
      expect(
        UpdateEpicParamsSchema.safeParse({
          ...base,
          description: 'full text',
          descriptionEdits: [{ find: 'a', replace: 'b' }],
        }).success,
      ).toBe(false);
      expect(
        UpdateEpicParamsSchema.safeParse({
          ...base,
          description: 'full text',
          appendDescription: 'tail',
        }).success,
      ).toBe(false);
    });
  });
});

describe('MCP Epic relation DTO schemas', () => {
  const base = {
    sessionId: 'abcd1234',
    epicId: '11111111-1111-4111-8111-111111111111',
  };

  it('bounds and trims candidate search', () => {
    expect(
      EpicRelationCandidatesListParamsSchema.parse({ ...base, q: ' peer ', limit: 10 }),
    ).toMatchObject({ q: 'peer', limit: 10 });
    expect(
      EpicRelationCandidatesListParamsSchema.safeParse({ ...base, q: 'x'.repeat(201) }).success,
    ).toBe(false);
  });
});
