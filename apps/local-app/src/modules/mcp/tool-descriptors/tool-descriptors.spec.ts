import { allMetadata, allBindings } from './index';
import { ZodObject, ZodEffects, type ZodSchema } from 'zod';

function unwrapZodSchema(schema: ZodSchema): ZodSchema {
  let unwrapped = schema;
  while (unwrapped instanceof ZodEffects) {
    unwrapped = unwrapped._def.schema;
  }
  return unwrapped;
}

describe('tool-descriptors', () => {
  describe('metadata', () => {
    it('has exactly 44 tool metadata entries', () => {
      expect(allMetadata.length).toBe(44);
    });

    it('all entries have required shape', () => {
      allMetadata.forEach((entry) => {
        expect(typeof entry.name).toBe('string');
        expect(typeof entry.description).toBe('string');
        expect(typeof entry.inputSchema).toBe('object');
        expect(entry.name).toMatch(/^devchain_/);
      });
    });

    it('all tool names are unique', () => {
      const names = allMetadata.map((m) => m.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('all inputSchema objects have additionalProperties: false', () => {
      allMetadata.forEach((entry) => {
        const schema = entry.inputSchema as { additionalProperties?: boolean };
        expect(schema.additionalProperties).toBe(false);
      });
    });

    it('nested object schemas in oneOf also have additionalProperties: false', () => {
      const updateEpic = allMetadata.find((m) => m.name === 'devchain_update_epic');
      expect(updateEpic).toBeDefined();
      const schema = updateEpic!.inputSchema as {
        properties?: { assignment?: { oneOf?: Array<{ additionalProperties?: boolean }> } };
      };
      expect(schema.properties?.assignment?.oneOf).toBeDefined();
      schema.properties?.assignment?.oneOf?.forEach((option) => {
        expect(option.additionalProperties).toBe(false);
      });
    });
  });

  describe('bindings', () => {
    it('has exactly 44 tool binding entries', () => {
      expect(allBindings.length).toBe(44);
    });

    it('all bindings have name and handler function', () => {
      allBindings.forEach(([name, handler]) => {
        expect(typeof name).toBe('string');
        expect(name).toMatch(/^devchain_/);
        expect(typeof handler).toBe('function');
      });
    });

    it('all binding names are unique', () => {
      const names = allBindings.map(([name]) => name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  describe('metadata-binding alignment', () => {
    const metadataNames = new Set(allMetadata.map((m) => m.name));
    const bindingNames = new Set(allBindings.map(([name]) => name));

    it('every metadata entry has a binding (no orphan metadata)', () => {
      const orphans = allMetadata.filter((m) => !bindingNames.has(m.name));
      expect(orphans.map((o) => o.name)).toEqual([]);
    });

    it('every binding has a metadata entry (no orphan handler)', () => {
      const orphans = allBindings.filter(([name]) => !metadataNames.has(name));
      expect(orphans.map(([name]) => name)).toEqual([]);
    });

    it('counts match: metadata == bindings == 44', () => {
      expect(allMetadata.length).toBe(44);
      expect(allBindings.length).toBe(44);
      expect(metadataNames.size).toBe(44);
      expect(bindingNames.size).toBe(44);
    });
  });

  describe('Zod schema contract', () => {
    const schemasWithParams = allMetadata.filter((m) => m.paramsSchema !== null);

    it('all paramsSchemas are valid Zod schemas', () => {
      schemasWithParams.forEach((entry) => {
        expect(entry.paramsSchema).toBeDefined();
        expect(typeof entry.paramsSchema!.parse).toBe('function');
        expect(typeof entry.paramsSchema!.safeParse).toBe('function');
      });
    });

    it('all Zod schemas have unknownKeys set to strict', () => {
      const nonStrict: string[] = [];
      schemasWithParams.forEach((entry) => {
        const unwrapped = unwrapZodSchema(entry.paramsSchema!);
        if (unwrapped instanceof ZodObject) {
          if (unwrapped._def.unknownKeys !== 'strict') {
            nonStrict.push(entry.name);
          }
        } else {
          nonStrict.push(`${entry.name} (not ZodObject after unwrap)`);
        }
      });
      expect(nonStrict).toEqual([]);
    });

    it('JSON Schema additionalProperties: false aligns with Zod strict mode', () => {
      schemasWithParams.forEach((entry) => {
        const jsonSchema = entry.inputSchema as { additionalProperties?: boolean };
        if (jsonSchema.additionalProperties === false) {
          const testData = { _contract_test_unknown_key_: 'should be rejected' };
          const result = entry.paramsSchema!.safeParse(testData);
          if (result.success) {
            fail(`${entry.name} has additionalProperties: false but Zod accepts unknown keys`);
          }
        }
      });
    });
  });

  describe('devchain_apply_suggestion permanent registration', () => {
    it('exists in metadata', () => {
      const entry = allMetadata.find((m) => m.name === 'devchain_apply_suggestion');
      expect(entry).toBeDefined();
      expect(entry!.paramsSchema).not.toBeNull();
    });

    it('exists in bindings', () => {
      const entry = allBindings.find(([name]) => name === 'devchain_apply_suggestion');
      expect(entry).toBeDefined();
      expect(typeof entry![1]).toBe('function');
    });
  });

  describe('devchain_send_message', () => {
    it('includes threadId in schema properties', () => {
      const entry = allMetadata.find((m) => m.name === 'devchain_send_message');
      const schema = entry?.inputSchema as { properties?: Record<string, unknown> };
      expect(schema?.properties).toHaveProperty('threadId');
    });

    it('includes recipientAgentNames with minItems: 1', () => {
      const entry = allMetadata.find((m) => m.name === 'devchain_send_message');
      const schema = entry?.inputSchema as { properties?: Record<string, { minItems?: number }> };
      expect(schema?.properties?.recipientAgentNames?.minItems).toBe(1);
    });

    it('includes teamName with self-team hint', () => {
      const entry = allMetadata.find((m) => m.name === 'devchain_send_message');
      const schema = entry?.inputSchema as {
        properties?: Record<string, { description?: string }>;
      };
      expect(schema?.properties?.teamName?.description).toContain('Routes to team lead');
    });
  });

  describe('devchain_update_epic tag discoverability', () => {
    it('description includes tag-only update examples', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_update_epic');
      expect(metadata).toBeDefined();
      expect(metadata!.description).toContain('setTags');
      expect(metadata!.description).toContain('addTags');
      expect(metadata!.description).toContain('removeTags');
      expect(metadata!.description).toContain('{ sessionId, id, version, setTags: [...] }');
      expect(metadata!.description).toContain('{ sessionId, id, version, addTags: [...] }');
      expect(metadata!.description).toContain('{ sessionId, id, version, removeTags: [...] }');
    });
  });

  describe('devchain_delete_epic descriptor contract', () => {
    it('exists in metadata and bindings', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_delete_epic');
      const binding = allBindings.find(([name]) => name === 'devchain_delete_epic');
      expect(metadata).toBeDefined();
      expect(binding).toBeDefined();
      expect(typeof binding![1]).toBe('function');
    });

    it('uses strict schema with exactly sessionId and id required', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_delete_epic');
      const schema = metadata!.inputSchema as {
        required?: string[];
        properties?: Record<string, unknown>;
        additionalProperties?: boolean;
      };

      expect(schema.required).toEqual(['sessionId', 'id']);
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['id', 'sessionId']);
      expect(schema.additionalProperties).toBe(false);
    });

    it('description includes user-approval and sub-epic cascade warnings', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_delete_epic');
      expect(metadata!.description).toContain('without explicit user approval');
      expect(metadata!.description).toContain('deletes its sub-epics');
      expect(metadata!.description).toContain('one epic.deleted event');
    });
  });

  describe('code review tools', () => {
    const reviewToolNames = [
      'devchain_list_reviews',
      'devchain_get_review',
      'devchain_get_review_comments',
      'devchain_reply_comment',
      'devchain_resolve_comment',
      'devchain_apply_suggestion',
    ];

    it('includes all code review tools in metadata and bindings', () => {
      const metaNames = allMetadata.map((m) => m.name);
      const bindNames = allBindings.map(([n]) => n);
      reviewToolNames.forEach((name) => {
        expect(metaNames).toContain(name);
        expect(bindNames).toContain(name);
      });
    });
  });

  describe('domain categorization', () => {
    const categories: Record<string, string[]> = {
      session: ['devchain_list_sessions', 'devchain_register_guest'],
      document: [
        'devchain_list_documents',
        'devchain_get_document',
        'devchain_create_document',
        'devchain_update_document',
      ],
      prompt: ['devchain_list_prompts', 'devchain_get_prompt'],
      skill: ['devchain_list_skills', 'devchain_get_skill'],
      agent: ['devchain_list_agents', 'devchain_get_agent_by_name', 'devchain_list_statuses'],
      epic: [
        'devchain_list_epics',
        'devchain_list_assigned_epics_tasks',
        'devchain_create_epic',
        'devchain_get_epic_by_id',
        'devchain_add_epic_comment',
        'devchain_update_epic',
        'devchain_delete_epic',
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
      team: [
        'devchain_teams_list',
        'devchain_teams_members_list',
        'devchain_teams_configs_list',
        'devchain_teams_create_agent',
        'devchain_teams_delete_agent',
        'devchain_team',
      ],
      review: [
        'devchain_list_reviews',
        'devchain_get_review',
        'devchain_get_review_comments',
        'devchain_reply_comment',
        'devchain_resolve_comment',
        'devchain_apply_suggestion',
      ],
    };

    it('all categorized tools sum to 44', () => {
      const total = Object.values(categories).reduce((sum, tools) => sum + tools.length, 0);
      expect(total).toBe(44);
    });

    Object.entries(categories).forEach(([category, tools]) => {
      it(`all ${category} tools present in metadata`, () => {
        const metaNames = allMetadata.map((m) => m.name);
        tools.forEach((name) => {
          expect(metaNames).toContain(name);
        });
      });
    });
  });
});
