import { getToolDefinitions } from './tool-definitions';
import { toolSchemaRegistry } from './dtos/schema-registry';
import { ZodObject, ZodEffects, type ZodSchema } from 'zod';

/**
 * Unwraps ZodEffects (from .refine(), .transform(), etc.) to get the underlying schema.
 * Returns the innermost ZodObject for strictness checking.
 */
function unwrapZodSchema(schema: ZodSchema): ZodSchema {
  let unwrapped = schema;
  while (unwrapped instanceof ZodEffects) {
    unwrapped = unwrapped._def.schema;
  }
  return unwrapped;
}

describe('tool-definitions', () => {
  const tools = getToolDefinitions();

  it('exports exactly 34 tool definitions', () => {
    expect(tools.length).toBe(34);
  });

  it('all tools have required shape (name, description, inputSchema)', () => {
    tools.forEach((tool) => {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(typeof tool.inputSchema).toBe('object');
    });
  });

  it('all tool names follow devchain_ prefix convention', () => {
    tools.forEach((tool) => {
      expect(tool.name).toMatch(/^devchain_/);
    });
  });

  it('all tool names are unique', () => {
    const names = tools.map((t) => t.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('all inputSchema objects have additionalProperties: false', () => {
    tools.forEach((tool) => {
      const schema = tool.inputSchema as { additionalProperties?: boolean };
      expect(schema.additionalProperties).toBe(false);
    });
  });

  it('nested object schemas in oneOf also have additionalProperties: false', () => {
    const updateEpic = tools.find((t) => t.name === 'devchain_update_epic');
    expect(updateEpic).toBeDefined();

    const schema = updateEpic!.inputSchema as {
      properties?: {
        assignment?: {
          oneOf?: Array<{ additionalProperties?: boolean }>;
        };
      };
    };

    const assignment = schema.properties?.assignment;
    expect(assignment?.oneOf).toBeDefined();
    expect(assignment?.oneOf?.length).toBe(2);

    // Both nested objects should have additionalProperties: false
    assignment?.oneOf?.forEach((option) => {
      expect(option.additionalProperties).toBe(false);
    });
  });

  describe('devchain_send_message', () => {
    const sendMessage = tools.find((t) => t.name === 'devchain_send_message');

    it('exists in tool definitions', () => {
      expect(sendMessage).toBeDefined();
    });

    it('includes threadId in schema properties', () => {
      const schema = sendMessage?.inputSchema as {
        properties?: Record<string, unknown>;
      };
      expect(schema?.properties).toHaveProperty('threadId');
    });

    it('includes recipientAgentNames in schema properties', () => {
      const schema = sendMessage?.inputSchema as {
        properties?: Record<string, unknown>;
      };
      expect(schema?.properties).toHaveProperty('recipientAgentNames');
    });
  });

  describe('code review tools', () => {
    const reviewToolNames = [
      'devchain_list_reviews',
      'devchain_get_review',
      'devchain_get_review_comments',
      'devchain_reply_comment',
      'devchain_resolve_comment',
    ];

    it('includes all code review tools', () => {
      const toolNames = tools.map((t) => t.name);
      reviewToolNames.forEach((name) => {
        expect(toolNames).toContain(name);
      });
    });
  });

  describe('Zod-JSON Schema contract alignment', () => {
    it('every tool has both JSON Schema definition and Zod schema in registry', () => {
      const missingZodSchemas: string[] = [];

      tools.forEach((tool) => {
        if (!toolSchemaRegistry.has(tool.name)) {
          missingZodSchemas.push(tool.name);
        }
      });

      expect(missingZodSchemas).toEqual([]);
    });

    it('all Zod schemas have unknownKeys set to strict', () => {
      const nonStrictSchemas: string[] = [];

      toolSchemaRegistry.forEach((schema, toolName) => {
        // Unwrap ZodEffects (from .refine(), .transform(), etc.) to get underlying ZodObject
        const unwrapped = unwrapZodSchema(schema);

        // Check if the unwrapped schema is a ZodObject with strict mode
        if (unwrapped instanceof ZodObject) {
          const unknownKeys = unwrapped._def.unknownKeys;
          if (unknownKeys !== 'strict') {
            nonStrictSchemas.push(`${toolName} (unknownKeys: ${unknownKeys ?? 'undefined'})`);
          }
        } else {
          // If it's not a ZodObject after unwrapping, flag it for review
          nonStrictSchemas.push(`${toolName} (not a ZodObject after unwrap)`);
        }
      });

      expect(nonStrictSchemas).toEqual([]);
    });

    it('JSON Schema additionalProperties: false aligns with Zod strict mode', () => {
      // For every tool with additionalProperties: false in JSON Schema,
      // the corresponding Zod schema should reject unknown keys
      tools.forEach((tool) => {
        const jsonSchema = tool.inputSchema as { additionalProperties?: boolean };
        const zodSchema = toolSchemaRegistry.get(tool.name);

        if (jsonSchema.additionalProperties === false && zodSchema) {
          // Test that Zod rejects unknown keys
          // We add an unknown key to trigger unrecognized_keys error
          const testData = { _contract_test_unknown_key_: 'should be rejected' };
          const result = zodSchema.safeParse(testData);

          // The schema should either:
          // 1. Fail with unrecognized_keys (strict mode working)
          // 2. Fail for other reasons (missing required fields) which is acceptable
          // It should NOT succeed when additionalProperties: false
          if (result.success) {
            fail(`Tool ${tool.name} has additionalProperties: false but Zod accepts unknown keys`);
          }
        }
      });
    });
  });
});
