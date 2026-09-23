import { allMetadata } from './index';
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

  describe('devchain_apply_suggestion metadata registration', () => {
    it('exists in metadata', () => {
      const entry = allMetadata.find((m) => m.name === 'devchain_apply_suggestion');
      expect(entry).toBeDefined();
      expect(entry!.paramsSchema).not.toBeNull();
    });
  });

  describe('devchain_send_message', () => {
    it('includes recipientProjectId as a UUID-prefix project route', () => {
      const entry = allMetadata.find((m) => m.name === 'devchain_send_message');
      const schema = entry?.inputSchema as {
        properties?: Record<string, { pattern?: string; description?: string }>;
      };
      expect(schema?.properties?.recipientProjectId?.pattern).toBeDefined();
      expect(new RegExp(schema!.properties!.recipientProjectId.pattern!).test('AAAAAAAA')).toBe(
        true,
      );
      expect(schema?.properties?.recipientProjectId?.description).toContain('8+ character');
    });

    it('omits retired thread and internal-recipient fields', () => {
      const entry = allMetadata.find((m) => m.name === 'devchain_send_message');
      const schema = entry?.inputSchema as { properties?: Record<string, unknown> };
      expect(schema?.properties).not.toHaveProperty('threadId');
      expect(schema?.properties).not.toHaveProperty('recipient');
      expect(schema?.additionalProperties).toBe(false);
    });

    it('includes recipientAgentNames with minItems: 1', () => {
      const entry = allMetadata.find((m) => m.name === 'devchain_send_message');
      const schema = entry?.inputSchema as { properties?: Record<string, { minItems?: number }> };
      expect(schema?.properties?.recipientAgentNames?.minItems).toBe(1);
    });

    it('documents explicit recipients as terminal delivery', () => {
      const entry = allMetadata.find((m) => m.name === 'devchain_send_message');
      const schema = entry?.inputSchema as {
        properties?: Record<string, { description?: string }>;
      };

      expect(entry?.description).toContain('terminal-routed message');
      expect(schema?.properties?.recipientAgentNames?.description).toContain(
        'Accepts one or more recipients',
      );
      expect(entry?.description).not.toContain('thread');
    });

    it('includes teamName with self-team hint', () => {
      const entry = allMetadata.find((m) => m.name === 'devchain_send_message');
      const schema = entry?.inputSchema as {
        properties?: Record<string, { description?: string }>;
      };
      expect(schema?.properties?.teamName?.description).toContain('Routes to team lead');
    });
  });

  describe('retired terminal-unrelated tools', () => {
    const retiredNames = [
      'devchain_chat_ack',
      'devchain_chat_read_history',
      'devchain_chat_list_members',
      'devchain_activity_start',
      'devchain_activity_finish',
      'devchain_list_documents',
      'devchain_get_document',
      'devchain_create_document',
      'devchain_update_document',
    ];

    it.each(retiredNames)('%s is absent from metadata', (name) => {
      expect(allMetadata.some((entry) => entry.name === name)).toBe(false);
    });
  });

  describe('devchain_projects_list', () => {
    it('has a strict, resource-first project directory descriptor', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_projects_list');
      const schema = metadata?.inputSchema as {
        required?: string[];
        properties?: Record<string, unknown>;
        additionalProperties?: boolean;
      };

      expect(metadata?.description).toContain('Project Owner');
      expect(schema.required).toEqual(['sessionId']);
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['limit', 'offset', 'sessionId']);
      expect(schema.additionalProperties).toBe(false);
    });
  });

  describe('devchain_get_agent_by_name', () => {
    it('documents the directory card and self-only instructions contract', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_get_agent_by_name');

      expect(metadata?.description).toContain('directory card');
      expect(metadata?.description).toContain('instructions are self-only');
      expect(metadata?.description).toContain('open assigned epics with status');
      expect(metadata?.description).toContain('empty array when team data is unavailable');
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

  describe('devchain_list_epics description diet', () => {
    it('documents previews and the includeDescription opt-in', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_list_epics');
      const schema = metadata?.inputSchema as {
        properties?: { includeDescription?: { type?: string } };
      };

      expect(metadata!.description).toContain('descriptionPreview');
      expect(metadata!.description).toContain('devchain_get_epic_by_id');
      expect(metadata!.description).toContain('includeDescription: true');
      expect(schema.properties?.includeDescription?.type).toBe('boolean');
    });
  });

  describe('devchain_get_epic_by_id parent summary', () => {
    it('documents the summary parent and the includeParentDescription opt-in', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_get_epic_by_id');
      const schema = metadata?.inputSchema as {
        properties?: { includeParentDescription?: { type?: string } };
      };

      expect(metadata!.description).toContain('parent is a summary');
      expect(metadata!.description).toContain('includeParentDescription: true');
      expect(schema.properties?.includeParentDescription?.type).toBe('boolean');
    });
  });

  describe('devchain_update_epic description edits', () => {
    it('keeps the nested edit object strict with array bounds', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_update_epic');
      const schema = metadata?.inputSchema as {
        properties?: {
          descriptionEdits?: {
            minItems?: number;
            maxItems?: number;
            items?: {
              required?: string[];
              additionalProperties?: boolean;
              properties?: Record<string, { minLength?: number; type?: string }>;
            };
          };
          appendDescription?: { minLength?: number; type?: string };
        };
      };

      const edits = schema.properties?.descriptionEdits;
      expect(edits).toMatchObject({ minItems: 1, maxItems: 50 });
      expect(edits?.items).toMatchObject({ required: ['find', 'replace'] });
      expect(edits?.items?.additionalProperties).toBe(false);
      expect(edits?.items?.properties?.find).toMatchObject({ type: 'string', minLength: 1 });
      expect(edits?.items?.properties?.replace?.type).toBe('string');
      expect(schema.properties?.appendDescription).toMatchObject({ type: 'string', minLength: 1 });
    });

    it('documents the mutual exclusion with the full description field', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_update_epic');
      const schema = metadata?.inputSchema as {
        properties?: Record<string, { description?: string }>;
      };

      expect(schema.properties?.description?.description).toContain('mutually exclusive');
      expect(schema.properties?.descriptionEdits?.description).toContain('mutually exclusive');
      expect(schema.properties?.appendDescription?.description).toContain('mutually exclusive');
    });

    it('coaches agents on unique find text, edit preference, response contexts, and conflict recovery', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_update_epic');

      expect(metadata!.description).toContain('prefer descriptionEdits');
      expect(metadata!.description).toContain('exactly once');
      expect(metadata!.description).toContain('re-read is not needed');
      expect(metadata!.description).toContain('VERSION_CONFLICT');
    });
  });

  describe('Epic relation descriptors', () => {
    const relationToolNames = [
      'devchain_epic_relations_list',
      'devchain_epic_relations_list_candidates',
      'devchain_epic_relations_set',
      'devchain_epic_relations_delete',
    ];

    it('registers all four resource-first tools with strict descriptors', () => {
      for (const name of relationToolNames) {
        const metadata = allMetadata.find((entry) => entry.name === name);
        expect(metadata).toBeDefined();
        expect(metadata?.inputSchema).toMatchObject({
          type: 'object',
          additionalProperties: false,
        });
        expect(metadata?.paramsSchema).not.toBeNull();
      }
    });

    it('describes bounded list and candidate pages', () => {
      for (const name of relationToolNames.slice(0, 2)) {
        const metadata = allMetadata.find((entry) => entry.name === name);
        const schema = metadata?.inputSchema as {
          properties?: Record<string, { minimum?: number; maximum?: number }>;
        };
        expect(schema.properties?.limit).toMatchObject({ minimum: 1, maximum: 100 });
        expect(schema.properties?.offset).toMatchObject({ minimum: 0 });
      }
    });

    it('keeps the optional create relation object strict and focal-relative', () => {
      const metadata = allMetadata.find((entry) => entry.name === 'devchain_create_epic');
      const schema = metadata?.inputSchema as {
        properties?: {
          relation?: {
            required?: string[];
            additionalProperties?: boolean;
            properties?: { relation?: { enum?: string[]; description?: string } };
          };
        };
      };
      expect(schema.properties?.relation).toMatchObject({
        required: ['relatedEpicId', 'relation'],
        additionalProperties: false,
      });
      expect(schema.properties?.relation?.properties?.relation?.enum).toEqual([
        'related',
        'blocks',
        'blocked_by',
      ]);
      expect(schema.properties?.relation?.properties?.relation?.description).toContain(
        'relative to the new Epic',
      );
    });

    it('keeps the create relations list strict, bounded, and mutually exclusive with relation', () => {
      const metadata = allMetadata.find((entry) => entry.name === 'devchain_create_epic');
      const schema = metadata?.inputSchema as {
        properties?: {
          relations?: {
            minItems?: number;
            maxItems?: number;
            description?: string;
            items?: {
              required?: string[];
              additionalProperties?: boolean;
              properties?: Record<string, { pattern?: string; enum?: string[] }>;
            };
          };
          relation?: { description?: string };
        };
      };

      const relations = schema.properties?.relations;
      expect(relations).toMatchObject({ minItems: 1, maxItems: 20 });
      expect(relations?.items).toMatchObject({
        required: ['relatedEpicId', 'relation'],
        additionalProperties: false,
      });
      expect(relations?.items?.properties?.relatedEpicId?.pattern).toBe('^[a-f0-9-]{8,36}$');
      expect(relations?.items?.properties?.relation?.enum).toEqual([
        'related',
        'blocks',
        'blocked_by',
      ]);
      expect(relations?.description).toContain('mutually exclusive with relation');
      expect(relations?.description).toContain('RELATION_ROUTE_CONFLICT');
      expect(schema.properties?.relation?.description).toContain(
        'mutually exclusive with relations',
      );
    });

    it('documents the endpoint-order source and target rule on set with no timeRoute field', () => {
      const set = allMetadata.find((entry) => entry.name === 'devchain_epic_relations_set');
      const setSchema = set as { description?: string } | undefined;
      const setInputSchema = set?.inputSchema as {
        required?: string[];
        additionalProperties?: boolean;
        properties?: Record<string, { enum?: string[]; description?: string }>;
      };
      expect(setSchema?.description).toContain('epicId is the source');
      expect(setSchema?.description).toContain('relatedEpicId is the target');
      expect(setInputSchema.properties?.timeRoute).toBeUndefined();
      expect(setInputSchema.required).not.toContain('timeRoute');
      expect(setInputSchema.additionalProperties).toBe(false);

      const list = allMetadata.find((entry) => entry.name === 'devchain_epic_relations_list');
      expect((list as { description?: string } | undefined)?.description).toContain('sourceEpicId');

      const create = allMetadata.find((entry) => entry.name === 'devchain_create_epic');
      const createSchema = create?.inputSchema as { properties?: Record<string, unknown> };
      expect(createSchema.properties?.timeRoute).toBeUndefined();
      const createRelationSchema = createSchema.properties?.relation as
        | { properties?: Record<string, unknown> }
        | undefined;
      expect(createRelationSchema?.properties?.timeRoute).toBeUndefined();
    });
  });

  describe('devchain_delete_epic descriptor contract', () => {
    it('exists in metadata', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_delete_epic');
      expect(metadata).toBeDefined();
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

  describe('devchain_get_skill descriptor contract', () => {
    it('states enabled-only resolution and describes both slug input forms', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_get_skill');
      expect(metadata).toBeDefined();

      expect(metadata!.description).toContain('enabled for the project');
      expect(metadata!.description).not.toContain('Works even when the skill is disabled');

      const schema = metadata!.inputSchema as {
        properties?: Record<string, { description?: string }>;
      };
      expect(schema.properties?.slug?.description).toContain('source/name');
      expect(schema.properties?.slug?.description).toContain('bare slug name');
    });
  });

  describe('devchain_skills_usage_stats descriptor contract', () => {
    it('uses a strict schema with sessionId required and no paging fields', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_skills_usage_stats');
      const schema = metadata!.inputSchema as {
        required?: string[];
        properties?: Record<string, unknown>;
        additionalProperties?: boolean;
      };

      expect(schema.required).toEqual(['sessionId']);
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['from', 'sessionId', 'to']);
      expect(schema.additionalProperties).toBe(false);
      expect(metadata?.paramsSchema).not.toBeNull();
    });

    it('documents usage semantics, the epicReferences window exemption, and status labels', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_skills_usage_stats');

      expect(metadata?.description).toContain('successful devchain_get_skill loads only');
      expect(metadata?.description).toContain('ignores the from/to window');
      expect(metadata?.description).toContain('no closed flag');
      expect(metadata?.description).toContain('complete is always true');
    });
  });

  describe('devchain_skills_set_enabled descriptor contract', () => {
    it('uses a strict schema with sessionId, slugs, and enabled required', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_skills_set_enabled');
      const schema = metadata!.inputSchema as {
        required?: string[];
        properties?: Record<string, { minItems?: number; maxItems?: number }>;
        additionalProperties?: boolean;
      };

      expect(schema.required).toEqual(['sessionId', 'slugs', 'enabled']);
      expect(schema.properties?.slugs).toMatchObject({ minItems: 1, maxItems: 200 });
      expect(schema.additionalProperties).toBe(false);
      expect(metadata?.paramsSchema).not.toBeNull();
    });

    it('documents the project-wide effect, approval exemption, and resolution limits', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_skills_set_enabled');

      expect(metadata?.description).toContain('Project-wide effect');
      expect(metadata?.description).toContain('does not check for human approval');
      expect(metadata?.description).toContain(
        'including sources that are disabled for this project',
      );
      expect(metadata?.description).toContain('skill-level disable');
      expect(metadata?.description).toContain('disabled globally');
    });

    it('documents the count-only response and how to derive the changed slugs', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_skills_set_enabled');

      expect(metadata?.description).toContain('{ updatedCount, unchanged, notFound }');
      expect(metadata?.description).toContain('request minus unchanged and notFound');
    });

    it('documents devchain_skills_set_source_enabled with project scope and refusal cases', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_skills_set_source_enabled');
      const schema = metadata!.inputSchema as {
        required?: string[];
        properties?: Record<string, unknown>;
        additionalProperties?: boolean;
      };

      expect(metadata).toBeDefined();
      expect(metadata?.description).toContain('Project-wide effect');
      expect(metadata?.description).toContain('does not check for human approval');
      expect(metadata?.description).toContain('global source state');
      expect(metadata?.description).toContain('SOURCE_NOT_FOUND');
      expect(metadata?.description).toContain('SOURCE_DISABLED_GLOBALLY');
      expect(metadata?.paramsSchema).not.toBeNull();
      expect(schema.required).toEqual(['sessionId', 'sourceName', 'enabled']);
      expect(schema.additionalProperties).toBe(false);
    });

    it('documents devchain_skills_sync with global effect, duration, and freshness caveats', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_skills_sync');
      const schema = metadata!.inputSchema as {
        required?: string[];
        properties?: Record<string, unknown>;
        additionalProperties?: boolean;
      };

      expect(metadata).toBeDefined();
      expect(metadata?.description).toContain('global (all projects)');
      expect(metadata?.description).toContain('download over the network');
      expect(metadata?.description).toContain('can take long');
      expect(metadata?.description).toContain('disabled source is skipped');
      expect(metadata?.description).toContain('do not confirm a fresh catalog');
      expect(metadata?.description).toContain('authoritative local source folder');
      expect(metadata?.description).toContain('does not check for human approval');
      expect(metadata?.description).toContain('SOURCE_NOT_FOUND');
      expect(metadata?.paramsSchema).not.toBeNull();
      expect(schema.required).toEqual(['sessionId']);
      expect(schema.additionalProperties).toBe(false);
    });

    it('documents includeDisabled on devchain_list_skills with all-sources flags and stale-source caveats', () => {
      const metadata = allMetadata.find((m) => m.name === 'devchain_list_skills');
      const schema = metadata!.inputSchema as {
        properties?: Record<string, unknown>;
      };

      expect(metadata?.description).toContain('every stored skill');
      expect(metadata?.description).toContain('skillDisabled');
      expect(metadata?.description).toContain('sourceProjectEnabled');
      expect(metadata?.description).toContain('sourceGloballyEnabled');
      expect(metadata?.description).toContain('read-only for MCP');
      expect(metadata?.description).toContain('stale');
      expect(metadata?.description).toContain('last stored catalog');
      expect(schema.properties?.includeDisabled).toBeDefined();
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

    it('includes all code review tools in metadata', () => {
      const metaNames = allMetadata.map((m) => m.name);
      reviewToolNames.forEach((name) => {
        expect(metaNames).toContain(name);
      });
    });
  });

  describe('domain categorization', () => {
    const categories: Record<string, string[]> = {
      session: ['devchain_list_sessions', 'devchain_register_guest'],
      prompt: ['devchain_list_prompts', 'devchain_get_prompt'],
      skill: [
        'devchain_list_skills',
        'devchain_get_skill',
        'devchain_skills_usage_stats',
        'devchain_skills_set_enabled',
        'devchain_skills_set_source_enabled',
        'devchain_skills_sync',
      ],
      agent: ['devchain_list_agents', 'devchain_get_agent_by_name', 'devchain_list_statuses'],
      epic: [
        'devchain_list_epics',
        'devchain_list_assigned_epics_tasks',
        'devchain_create_epic',
        'devchain_get_epic_by_id',
        'devchain_epic_relations_list',
        'devchain_epic_relations_list_candidates',
        'devchain_epic_relations_set',
        'devchain_epic_relations_delete',
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
      chat: ['devchain_send_message'],
      projects: ['devchain_projects_list'],
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
