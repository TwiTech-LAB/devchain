import {
  toolSchemaRegistry,
  getToolSchema,
  hasToolSchema,
  getRegisteredToolNames,
  REGISTERED_TOOL_COUNT,
  ListSessionsParamsSchema,
} from './schema-registry';
import { getToolDefinitions } from '../tool-definitions';

describe('schema-registry', () => {
  const toolDefinitions = getToolDefinitions();
  const definedToolNames = toolDefinitions.map((t) => t.name);

  describe('registry coverage', () => {
    it('has schema entries for all tools defined in tool-definitions', () => {
      const missingSchemas: string[] = [];

      definedToolNames.forEach((toolName) => {
        if (!toolSchemaRegistry.has(toolName)) {
          missingSchemas.push(toolName);
        }
      });

      expect(missingSchemas).toEqual([]);
    });

    it('has no extra schemas for tools not in tool-definitions', () => {
      const registeredNames = getRegisteredToolNames();
      const extraSchemas = registeredNames.filter((name) => !definedToolNames.includes(name));

      expect(extraSchemas).toEqual([]);
    });

    it('matches the expected tool count (34 tools)', () => {
      expect(toolSchemaRegistry.size).toBe(34);
      expect(REGISTERED_TOOL_COUNT).toBe(34);
    });

    it('has exactly the same count as tool-definitions', () => {
      expect(toolSchemaRegistry.size).toBe(toolDefinitions.length);
    });
  });

  describe('getToolSchema', () => {
    it('returns schema for known tool', () => {
      const schema = getToolSchema('devchain_list_sessions');
      expect(schema).toBeDefined();
      expect(schema).toBe(ListSessionsParamsSchema);
    });

    it('returns undefined for unknown tool', () => {
      const schema = getToolSchema('devchain_nonexistent_tool');
      expect(schema).toBeUndefined();
    });
  });

  describe('hasToolSchema', () => {
    it('returns true for known tool', () => {
      expect(hasToolSchema('devchain_list_epics')).toBe(true);
    });

    it('returns false for unknown tool', () => {
      expect(hasToolSchema('devchain_nonexistent_tool')).toBe(false);
    });
  });

  describe('getRegisteredToolNames', () => {
    it('returns all registered tool names', () => {
      const names = getRegisteredToolNames();
      expect(names.length).toBe(34);
      expect(names).toContain('devchain_list_sessions');
      expect(names).toContain('devchain_update_epic');
      expect(names).toContain('devchain_resolve_comment');
    });
  });

  describe('schema validity', () => {
    it('all registry entries are valid Zod schemas', () => {
      toolSchemaRegistry.forEach((schema, _toolName) => {
        expect(schema).toBeDefined();
        expect(typeof schema.parse).toBe('function');
        expect(typeof schema.safeParse).toBe('function');
      });
    });

    it('devchain_list_sessions schema accepts empty object', () => {
      const schema = getToolSchema('devchain_list_sessions');
      expect(() => schema?.parse({})).not.toThrow();
    });

    it('devchain_update_epic schema requires id, version, sessionId', () => {
      const schema = getToolSchema('devchain_update_epic');
      const result = schema?.safeParse({});
      expect(result?.success).toBe(false);

      const validResult = schema?.safeParse({
        sessionId: 'abcd1234',
        id: '00000000-0000-0000-0000-000000000001',
        version: 1,
      });
      expect(validResult?.success).toBe(true);
    });
  });

  describe('categorized tool coverage', () => {
    const categories = {
      session: ['devchain_list_sessions', 'devchain_register_guest'],
      document: [
        'devchain_list_documents',
        'devchain_get_document',
        'devchain_create_document',
        'devchain_update_document',
      ],
      prompt: ['devchain_list_prompts', 'devchain_get_prompt'],
      agent: ['devchain_list_agents', 'devchain_get_agent_by_name'],
      status: ['devchain_list_statuses'],
      epic: [
        'devchain_list_epics',
        'devchain_list_assigned_epics_tasks',
        'devchain_create_epic',
        'devchain_get_epic_by_id',
        'devchain_add_epic_comment',
        'devchain_update_epic',
      ],
      record: [
        'devchain_create_record',
        'devchain_update_record',
        'devchain_get_record',
        'devchain_list_records',
        'devchain_add_tags',
        'devchain_remove_tags',
      ],
      chat: [
        'devchain_send_message',
        'devchain_chat_ack',
        'devchain_chat_read_history',
        'devchain_chat_list_members',
      ],
      activity: ['devchain_activity_start', 'devchain_activity_finish'],
      review: [
        'devchain_list_reviews',
        'devchain_get_review',
        'devchain_get_review_comments',
        'devchain_reply_comment',
        'devchain_resolve_comment',
      ],
    };

    Object.entries(categories).forEach(([category, tools]) => {
      describe(`${category} tools`, () => {
        tools.forEach((toolName) => {
          it(`has schema for ${toolName}`, () => {
            expect(hasToolSchema(toolName)).toBe(true);
          });
        });
      });
    });
  });
});
