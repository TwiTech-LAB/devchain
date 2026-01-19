/**
 * Param suggestion utility for unknown key detection in MCP tool parameters.
 *
 * Provides helpful suggestions when users misplace parameters at wrong nesting levels.
 * Uses exact-match recursive key search (no fuzzy matching in v1).
 */
import { ZodSchema, ZodObject, ZodOptional, ZodUnion, ZodEffects } from 'zod';

import { toolSchemaRegistry } from '../dtos/schema-registry';

/**
 * Result of a nested key search.
 */
interface KeySearchResult {
  /** The full path to the key (e.g., "assignment.agentName") */
  path: string;
  /** Depth at which the key was found (0 = top level) */
  depth: number;
}

/**
 * Recursively searches a Zod schema for a key name.
 *
 * @param schema - The Zod schema to search
 * @param targetKey - The key name to find
 * @param currentPath - Current path prefix for building full paths
 * @param maxDepth - Maximum recursion depth (prevents infinite loops)
 * @returns Array of all paths where the key was found
 */
function findKeyInSchema(
  schema: ZodSchema,
  targetKey: string,
  currentPath: string = '',
  maxDepth: number = 5,
): KeySearchResult[] {
  if (maxDepth <= 0) {
    return [];
  }

  const results: KeySearchResult[] = [];

  // Unwrap ZodEffects (created by .refine(), .transform(), etc.)
  let unwrapped = schema;
  while (unwrapped instanceof ZodEffects) {
    unwrapped = unwrapped._def.schema;
  }

  // Handle ZodObject - the main case
  if (unwrapped instanceof ZodObject) {
    const shape = unwrapped.shape;

    for (const key of Object.keys(shape)) {
      const fieldPath = currentPath ? `${currentPath}.${key}` : key;
      const fieldSchema = shape[key];

      // Check if this key matches
      if (key === targetKey) {
        results.push({
          path: fieldPath,
          depth: fieldPath.split('.').length - 1,
        });
      }

      // Recursively search nested schemas
      const nestedResults = findKeyInSchema(fieldSchema, targetKey, fieldPath, maxDepth - 1);
      results.push(...nestedResults);
    }
  }

  // Handle ZodOptional - unwrap and search inner schema
  if (unwrapped instanceof ZodOptional) {
    const innerResults = findKeyInSchema(
      unwrapped._def.innerType,
      targetKey,
      currentPath,
      maxDepth,
    );
    results.push(...innerResults);
  }

  // Handle ZodUnion - search all options
  if (unwrapped instanceof ZodUnion) {
    const options = unwrapped._def.options as ZodSchema[];
    for (const option of options) {
      const optionResults = findKeyInSchema(option, targetKey, currentPath, maxDepth);
      results.push(...optionResults);
    }
  }

  return results;
}

/**
 * Suggests a nested path for an unknown key in an MCP tool schema.
 *
 * This function helps users who place parameters at the wrong nesting level.
 * For example, if they pass `agentName` at the top level of `devchain_update_epic`
 * instead of `assignment.agentName`, this will suggest the correct path.
 *
 * @param unknownKey - The unrecognized key name
 * @param toolName - The MCP tool name (e.g., "devchain_update_epic")
 * @param registry - Optional custom registry (defaults to toolSchemaRegistry)
 * @returns A formatted suggestion string or null if no match found
 *
 * @example
 * ```ts
 * suggestNestedPath('agentName', 'devchain_update_epic')
 * // Returns: "Did you mean: assignment.agentName?"
 *
 * suggestNestedPath('unknownField', 'devchain_update_epic')
 * // Returns: null
 * ```
 */
export function suggestNestedPath(
  unknownKey: string,
  toolName: string,
  registry: ReadonlyMap<string, ZodSchema> = toolSchemaRegistry,
): string | null {
  const schema = registry.get(toolName);
  if (!schema) {
    return null;
  }

  // Search for the key in nested locations (skip depth 0 = top level)
  const results = findKeyInSchema(schema, unknownKey);

  // Filter to only nested matches (depth > 0)
  // If the key exists at top level (depth 0), it's not a nesting issue
  const nestedMatches = results.filter((r) => r.depth > 0);

  if (nestedMatches.length === 0) {
    return null;
  }

  // Return the shallowest match (most likely what user intended)
  const bestMatch = nestedMatches.reduce((prev, curr) => (curr.depth < prev.depth ? curr : prev));

  return `Did you mean: ${bestMatch.path}?`;
}

/**
 * Gets all valid keys for a tool schema, including nested paths.
 * Useful for generating comprehensive error messages.
 *
 * @param toolName - The MCP tool name
 * @param registry - Optional custom registry
 * @returns Array of all valid key paths, or empty array if tool not found
 */
export function getValidKeys(
  toolName: string,
  registry: ReadonlyMap<string, ZodSchema> = toolSchemaRegistry,
): string[] {
  const schema = registry.get(toolName);
  if (!schema) {
    return [];
  }

  return collectAllKeys(schema);
}

/**
 * Recursively collects all key paths from a schema.
 */
function collectAllKeys(
  schema: ZodSchema,
  currentPath: string = '',
  maxDepth: number = 5,
): string[] {
  if (maxDepth <= 0) {
    return [];
  }

  const keys: string[] = [];

  // Unwrap ZodEffects
  let unwrapped = schema;
  while (unwrapped instanceof ZodEffects) {
    unwrapped = unwrapped._def.schema;
  }

  if (unwrapped instanceof ZodObject) {
    const shape = unwrapped.shape;

    for (const key of Object.keys(shape)) {
      const fieldPath = currentPath ? `${currentPath}.${key}` : key;
      keys.push(fieldPath);

      // Recursively collect from nested schemas
      const nestedKeys = collectAllKeys(shape[key], fieldPath, maxDepth - 1);
      keys.push(...nestedKeys);
    }
  }

  if (unwrapped instanceof ZodOptional) {
    const innerKeys = collectAllKeys(unwrapped._def.innerType, currentPath, maxDepth);
    keys.push(...innerKeys);
  }

  if (unwrapped instanceof ZodUnion) {
    const options = unwrapped._def.options as ZodSchema[];
    for (const option of options) {
      const optionKeys = collectAllKeys(option, currentPath, maxDepth);
      keys.push(...optionKeys);
    }
  }

  // Deduplicate keys (unions may have overlapping keys)
  return [...new Set(keys)];
}
