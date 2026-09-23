import {
  ListSkillsParamsSchema,
  GetSkillParamsSchema,
  SkillsUsageStatsParamsSchema,
  SkillsSetEnabledParamsSchema,
  SkillsSetSourceEnabledParamsSchema,
  SkillsSyncParamsSchema,
} from '../dtos/mcp.dto';
import type { ToolMetadataEntry } from './types';

export const skillMetadata: ToolMetadataEntry[] = [
  {
    name: 'devchain_list_skills',
    description:
      "List skills available to the session's project, excluding disabled skills. Supports optional q for multi-term keyword filtering across skill fields — space-separated terms match independently (e.g. 'react typescript test'). With includeDisabled: true, returns every stored skill, including skills of sources disabled for the project and sources disabled globally; each item then carries four flags: disabled (effective state — true when any block applies), skillDisabled (the project disabled this skill), sourceProjectEnabled (default true), and sourceGloballyEnabled (default true). Skills with sourceGloballyEnabled: false are read-only for MCP. Their stored content can be stale, because disabled sources do not sync. The list is the last stored catalog, not a confirmed fresh one.",
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        q: {
          type: 'string',
          description:
            'Multi-term keyword filter. Space-separated terms match independently across slug, name, display name, and description. Results are ranked by relevance.',
        },
        includeDisabled: {
          type: 'boolean',
          description:
            'When true, return every stored skill with the four state flags (disabled, skillDisabled, sourceProjectEnabled, sourceGloballyEnabled), including skills behind project-disabled and globally disabled sources. Default false lists only enabled (discoverable) skills with no flag fields. Skills with sourceGloballyEnabled: false are read-only for MCP; their content can be stale and the list is the last stored catalog.',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: ListSkillsParamsSchema,
  },
  {
    name: 'devchain_get_skill',
    description:
      'Get a skill by slug with full content/details and record usage from session context. Returns only skills that are enabled for the project; a disabled skill is never returned.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'slug'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        slug: {
          type: 'string',
          description:
            'Full source/name slug or bare slug name (for example: anthropic/code-review or code-review)',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: GetSkillParamsSchema,
  },
  {
    name: 'devchain_skills_usage_stats',
    description:
      "Read the complete skill usage statistics for the session's project in one unpaged response. Usage counts successful devchain_get_skill loads only; it does not prove that a skill helped. Returns summary {totalEvents, distinctSkills, firstEventAt, lastEventAt} and skills[] rows {slug, name, displayName, usageCount, firstAccessedAt, lastAccessedAt} for every used skill; complete is always true, so a missing slug means zero recorded use. Also returns epicReferences[]: for each slug, how many of the project's epics (parents and children, each counted once per slug) currently require it, grouped by status label. epicReferences describes current project requirements and ignores the from/to window; status labels carry no closed flag.",
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        from: {
          type: 'string',
          description:
            'Optional inclusive ISO timestamp lower bound for usage events. Does not affect epicReferences.',
        },
        to: {
          type: 'string',
          description:
            'Optional inclusive ISO timestamp upper bound for usage events. Does not affect epicReferences.',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: SkillsUsageStatsParamsSchema,
  },
  {
    name: 'devchain_skills_set_enabled',
    description:
      'Enable or disable a batch of skills (1-200 full source/name slugs) for the session project. Project-wide effect: the change applies to every agent of the project, and other projects stay unchanged. The tool does not check for human approval — confirm with the user before calling it. Resolves slugs among skills of globally enabled sources, including sources that are disabled for this project, so a skill-level toggle can land while its source is still project-disabled. Skills of globally disabled sources are read-only and return notFound. The compared state is the skill-level disable, independent of any source-level disable. Slugs are trimmed, lowercased, and deduplicated. Returns { updatedCount, unchanged, notFound }: unchanged lists slugs already in the requested skill-level state, notFound lists slugs that do not exist or whose source is disabled globally, and every other requested slug changed state (the changed slugs are not echoed; derive them as the request minus unchanged and notFound). Guests and sessions without agent context are rejected.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'slugs', 'enabled'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        slugs: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: {
            type: 'string',
            description: 'Full skill slug in source/name form (for example: anthropic/code-review)',
          },
          description: 'Skill slugs to enable or disable for the project.',
        },
        enabled: {
          type: 'boolean',
          description: 'true enables the skills for the project; false disables them.',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: SkillsSetEnabledParamsSchema,
  },
  {
    name: 'devchain_skills_set_source_enabled',
    description:
      'Enable or disable one skill source for the session project only; other projects and the global source state (settings skills.sources) are out of scope. Project-wide effect: the change applies to every agent of the project. The tool does not check for human approval — confirm with the user before calling it. Returns { name, projectId, projectEnabled }. An unknown source returns SOURCE_NOT_FOUND; a source disabled in global settings returns SOURCE_DISABLED_GLOBALLY (a project toggle has no effect there); both change nothing. Guests and sessions without agent context are rejected.',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'sourceName', 'enabled'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        sourceName: {
          type: 'string',
          description:
            'Registered skill source name (for example: anthropic or devchain-local). Matched case-insensitively after trimming.',
        },
        enabled: {
          type: 'boolean',
          description: 'true enables the source for the project; false disables it.',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: SkillsSetSourceEnabledParamsSchema,
  },
  {
    name: 'devchain_skills_sync',
    description:
      'Sync the skill catalog now and wait for the result: one source with sourceName, or every enabled source without it. Returns the SyncResult as it is (status, added, updated, removed, failed, unchanged, errors), including the already_running result when another sync holds the admission slot. The effect is global (all projects). GitHub sources download over the network, and a sync can take long. A disabled source is skipped and returns an empty result. A timeout, already_running, or errors do not confirm a fresh catalog. After an edit of a local skill, edit the authoritative local source folder (not the materialized contentPath), then sync that source. The tool does not check for human approval. An unknown source returns SOURCE_NOT_FOUND; guests and sessions without agent context are rejected.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID (full UUID or 8+ char prefix)',
        },
        sourceName: {
          type: 'string',
          description:
            'Optional registered skill source to sync (for example: devchain-local). Without it, every enabled source syncs.',
        },
      },
      additionalProperties: false,
    },
    paramsSchema: SkillsSyncParamsSchema,
  },
];
