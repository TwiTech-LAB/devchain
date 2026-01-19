import { z } from 'zod';

import { suggestNestedPath, getValidKeys } from './param-suggestion';

describe('param-suggestion', () => {
  describe('suggestNestedPath', () => {
    describe('with real schema registry', () => {
      it('suggests assignment.agentName for misplaced agentName in devchain_update_epic', () => {
        const suggestion = suggestNestedPath('agentName', 'devchain_update_epic');
        expect(suggestion).toBe('Did you mean: assignment.agentName?');
      });

      it('suggests assignment.clear for misplaced clear in devchain_update_epic', () => {
        const suggestion = suggestNestedPath('clear', 'devchain_update_epic');
        expect(suggestion).toBe('Did you mean: assignment.clear?');
      });

      it('returns null for unknown key not found anywhere', () => {
        const suggestion = suggestNestedPath('totallyUnknownField', 'devchain_update_epic');
        expect(suggestion).toBeNull();
      });

      it('returns null for top-level key (not a nesting issue)', () => {
        // sessionId exists at top level, not nested - so no suggestion
        const suggestion = suggestNestedPath('sessionId', 'devchain_update_epic');
        expect(suggestion).toBeNull();
      });

      it('returns null for unknown tool name', () => {
        const suggestion = suggestNestedPath('agentName', 'devchain_nonexistent_tool');
        expect(suggestion).toBeNull();
      });

      it('returns null for tool without nested schemas', () => {
        // devchain_list_sessions has no fields at all
        const suggestion = suggestNestedPath('anyKey', 'devchain_list_sessions');
        expect(suggestion).toBeNull();
      });
    });

    describe('with custom registry', () => {
      const customRegistry = new Map([
        [
          'test_tool',
          z
            .object({
              topLevel: z.string(),
              nested: z
                .object({
                  innerKey: z.string(),
                  deepNested: z
                    .object({
                      deepKey: z.string(),
                    })
                    .optional(),
                })
                .optional(),
            })
            .strict(),
        ],
        [
          'test_union_tool',
          z
            .object({
              config: z
                .union([
                  z.object({ modeA: z.string(), optionA: z.number() }),
                  z.object({ modeB: z.string(), optionB: z.boolean() }),
                ])
                .optional(),
            })
            .strict(),
        ],
        [
          'test_refined_tool',
          z
            .object({
              id: z.string().optional(),
              settings: z
                .object({
                  enabled: z.boolean(),
                })
                .optional(),
            })
            .strict()
            .refine((d) => d.id || d.settings, { message: 'Need id or settings' }),
        ],
      ]);

      it('suggests nested path for misplaced key', () => {
        const suggestion = suggestNestedPath('innerKey', 'test_tool', customRegistry);
        expect(suggestion).toBe('Did you mean: nested.innerKey?');
      });

      it('suggests deeply nested path', () => {
        const suggestion = suggestNestedPath('deepKey', 'test_tool', customRegistry);
        expect(suggestion).toBe('Did you mean: nested.deepNested.deepKey?');
      });

      it('returns null for top-level key', () => {
        const suggestion = suggestNestedPath('topLevel', 'test_tool', customRegistry);
        expect(suggestion).toBeNull();
      });

      it('finds keys in union variants', () => {
        const suggestionA = suggestNestedPath('optionA', 'test_union_tool', customRegistry);
        expect(suggestionA).toBe('Did you mean: config.optionA?');

        const suggestionB = suggestNestedPath('optionB', 'test_union_tool', customRegistry);
        expect(suggestionB).toBe('Did you mean: config.optionB?');
      });

      it('handles refined schemas (with .refine())', () => {
        const suggestion = suggestNestedPath('enabled', 'test_refined_tool', customRegistry);
        expect(suggestion).toBe('Did you mean: settings.enabled?');
      });

      it('prefers shallower matches when key exists at multiple depths', () => {
        // Create a schema where 'value' exists at multiple nesting levels
        const multiLevelRegistry = new Map([
          [
            'multi_level_tool',
            z.object({
              level1: z.object({
                value: z.string(),
                level2: z.object({
                  value: z.string(),
                }),
              }),
            }),
          ],
        ]);

        const suggestion = suggestNestedPath('value', 'multi_level_tool', multiLevelRegistry);
        // Should prefer level1.value (depth 1) over level1.level2.value (depth 2)
        expect(suggestion).toBe('Did you mean: level1.value?');
      });
    });
  });

  describe('getValidKeys', () => {
    it('returns all valid keys for devchain_update_epic', () => {
      const keys = getValidKeys('devchain_update_epic');

      // Top-level keys
      expect(keys).toContain('sessionId');
      expect(keys).toContain('id');
      expect(keys).toContain('version');
      expect(keys).toContain('title');
      expect(keys).toContain('description');
      expect(keys).toContain('statusName');
      expect(keys).toContain('assignment');
      expect(keys).toContain('parentId');
      expect(keys).toContain('clearParent');
      expect(keys).toContain('setTags');
      expect(keys).toContain('addTags');
      expect(keys).toContain('removeTags');

      // Nested keys
      expect(keys).toContain('assignment.agentName');
      expect(keys).toContain('assignment.clear');
    });

    it('returns empty array for unknown tool', () => {
      const keys = getValidKeys('devchain_nonexistent_tool');
      expect(keys).toEqual([]);
    });

    it('returns empty array for tool with no params', () => {
      const keys = getValidKeys('devchain_list_sessions');
      expect(keys).toEqual([]);
    });

    it('works with custom registry', () => {
      const customRegistry = new Map([
        [
          'test_tool',
          z.object({
            a: z.string(),
            b: z.object({
              c: z.number(),
            }),
          }),
        ],
      ]);

      const keys = getValidKeys('test_tool', customRegistry);
      expect(keys).toContain('a');
      expect(keys).toContain('b');
      expect(keys).toContain('b.c');
    });

    it('deduplicates keys from union variants', () => {
      const customRegistry = new Map([
        [
          'union_tool',
          z.object({
            config: z.union([
              z.object({ shared: z.string(), uniqueA: z.number() }),
              z.object({ shared: z.string(), uniqueB: z.boolean() }),
            ]),
          }),
        ],
      ]);

      const keys = getValidKeys('union_tool', customRegistry);

      // 'config.shared' should appear only once despite being in both variants
      const sharedCount = keys.filter((k) => k === 'config.shared').length;
      expect(sharedCount).toBe(1);

      expect(keys).toContain('config.uniqueA');
      expect(keys).toContain('config.uniqueB');
    });
  });
});
