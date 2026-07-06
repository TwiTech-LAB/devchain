/**
 * Watchers codec — owns the `watchers` section (export build + import apply).
 *
 * Apply delegates to the legacy `createWatchersFromPayloadWithHelper` (behavior-preserving),
 * assembling the four name-resolution maps it needs from the ImportContext plus the ambient
 * provider map:
 *  - `agentNameToId`      — written by the agents codec (Record -> Map adapter).
 *  - `profileNameToId`    — written by the profiles codec.
 *  - `profileNameRemapMap`— from the seeded `selectedProfilesByFamily` (family substitution).
 *  - `providerNameToId`   — the ambient provider map (`CodecApplyRuntime.available`); providers
 *                           are pre-existing/ambient so they live in the runtime, not the context
 *                           (consistent with Task 3's placement of `available`).
 *
 * The scope-filter remap via `profileNameRemapMap` (profile-scope watchers whose target was
 * family-substituted) is preserved because it lives inside the shared helper.
 *
 * Template-section ordering: declares reads satisfied by profiles/agents (which run earlier), so
 * this codec is registered after `agents`.
 */
import { createWatchersFromPayloadWithHelper } from '../../helpers/project-runtime.helpers';
import type { ScopeLookupMaps, WatcherTemplateInput } from '../../helpers/project-runtime.helpers';
import type { StorageService } from '../../../storage/interfaces/storage.interface';
import type { ImportContext } from '../import-context';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ParsedTemplatePayload,
  PipelineMode,
  TemplateSectionCodec,
} from '../template-section-codec';

type WatchersSection = ParsedTemplatePayload['watchers'];

// --- Export build (moved from project-export.ts `buildExportWatchers`). --------------
// Standalone param types keep the dependency one-way (project-export -> codec); the caller
// passes its already-loaded export slices.
interface ExportWatcherRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  scope: 'all' | 'agent' | 'profile' | 'provider';
  scopeFilterId: string | null;
  pollIntervalMs: number;
  viewportLines: number;
  idleAfterSeconds: number;
  condition: {
    type: 'contains' | 'regex' | 'not_contains';
    pattern: string;
    flags?: string;
  };
  cooldownMs: number;
  cooldownMode: 'time' | 'until_clear';
  eventName: string;
}

export async function buildExportWatchers(
  watchers: ReadonlyArray<ExportWatcherRow>,
  agents: ReadonlyArray<{ id: string; name: string }>,
  profiles: ReadonlyArray<{ id: string; name: string }>,
  storage: StorageService,
) {
  return Promise.all(
    watchers.map(async (watcher) => {
      let scopeFilterName: string | null = null;

      if (watcher.scopeFilterId) {
        switch (watcher.scope) {
          case 'agent':
            scopeFilterName =
              agents.find((agent) => agent.id === watcher.scopeFilterId)?.name ?? null;
            break;
          case 'profile':
            scopeFilterName =
              profiles.find((profile) => profile.id === watcher.scopeFilterId)?.name ?? null;
            break;
          case 'provider':
            try {
              scopeFilterName = (await storage.getProvider(watcher.scopeFilterId))?.name ?? null;
            } catch {
              scopeFilterName = null;
            }
            break;
        }
      }

      return {
        id: watcher.id,
        name: watcher.name,
        description: watcher.description,
        enabled: watcher.enabled,
        scope: watcher.scope,
        scopeFilterName,
        pollIntervalMs: watcher.pollIntervalMs,
        viewportLines: watcher.viewportLines,
        idleAfterSeconds: watcher.idleAfterSeconds,
        condition: watcher.condition,
        cooldownMs: watcher.cooldownMs,
        cooldownMode: watcher.cooldownMode,
        eventName: watcher.eventName,
      };
    }),
  );
}

class WatchersCodec implements TemplateSectionCodec<WatchersSection> {
  readonly declaration = {
    section: 'watchers',
    reads: ['agentNameToId', 'profileNameToId', 'selectedProfilesByFamily'],
    writes: ['watcherIdMap'],
    requiresState: ['existingDataCleared'],
    modes: ['replace', 'create'],
  } as const;

  pick(payload: ParsedTemplatePayload): WatchersSection {
    return payload.watchers;
  }

  build() {
    // Export build is invoked directly by project-export via `buildExportWatchers`.
    return [];
  }

  async apply(
    watchers: WatchersSection,
    ctx: ImportContext,
    _mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult> {
    if (!rt.watchersService) {
      return { section: 'watchers', log: { watchers: 0, skipped: 'no watchersService' } };
    }

    const maps: ScopeLookupMaps = {
      agentNameToId: new Map(Object.entries(ctx.get('agentNameToId'))),
      profileNameToId: ctx.get('profileNameToId'),
      providerNameToId: rt.available ?? new Map<string, string>(),
      profileNameRemapMap: ctx.get('selectedProfilesByFamily').profileNameRemapMap,
    };

    const { created, watcherIdMap } = await createWatchersFromPayloadWithHelper(
      rt.projectId,
      watchers as WatcherTemplateInput[],
      maps,
      rt.watchersService,
    );

    // Publish the id map so the import orchestrator can surface it in the response `mappings`
    // (byte-compatible with the legacy inline path).
    ctx.set('watcherIdMap', watcherIdMap);

    return { section: 'watchers', log: { watchers: created } };
  }
}

export const watchersCodec = new WatchersCodec();
