/**
 * Agents codec — owns the `agents` section. Apply = the legacy `createImportedAgents`,
 * moved verbatim: resolve each agent's profile (via `agentProfileMap` + `profileIdMap`)
 * and its provider config (via `configLookupMap`, by profileId+providerConfigName with a
 * same-profile fallback), carry `modelOverride` + `effortOverride` verbatim, and THROW
 * with byte-identical messages on a missing profile/config (these surface to users).
 *
 * Declares reads `selectedProfilesByFamily` + `profileIdMap` + `configLookupMap` (the
 * profiles codec writes the latter two) and writes `agentIdMap` + `agentNameToId`.
 */
import { ValidationError } from '../../../../common/errors/error-types';
import { buildProviderConfigLookupKey } from '../../helpers/profile-mapping.helpers';
import type { ImportContext } from '../import-context';
import type {
  CodecApplyResult,
  CodecApplyRuntime,
  ParsedTemplatePayload,
  PipelineMode,
  TemplateSectionCodec,
} from '../template-section-codec';

type AgentsSection = ParsedTemplatePayload['agents'];

// --- Export build (moved from project-export.ts `buildExportAgents`). ---------------
interface ExportAgentRow {
  id: string;
  name: string;
  profileId: string;
  description: string | null;
  providerConfigId: string | null;
  modelOverride: string | null;
  effortOverride?: string | null;
}

export function buildExportAgents(
  agentsRes: { items: ReadonlyArray<ExportAgentRow> },
  configIdToInfo: Map<string, { name: string; profileId: string }>,
) {
  return agentsRes.items.map((agent) => {
    let providerConfigName: string | null = null;
    if (agent.providerConfigId) {
      providerConfigName = configIdToInfo.get(agent.providerConfigId)?.name ?? null;
    }

    return {
      id: agent.id,
      name: agent.name,
      profileId: agent.profileId,
      description: agent.description,
      modelOverride: agent.modelOverride ?? null,
      ...(agent.effortOverride != null && { effortOverride: agent.effortOverride }),
      ...(providerConfigName && { providerConfigName }),
    };
  });
}

class AgentsCodec implements TemplateSectionCodec<AgentsSection> {
  readonly declaration = {
    section: 'agents',
    reads: ['selectedProfilesByFamily', 'profileIdMap', 'configLookupMap'],
    writes: ['agentIdMap', 'agentNameToId'],
    producesState: ['agentsPersisted'],
    modes: ['replace', 'create'],
  } as const;

  pick(payload: ParsedTemplatePayload): AgentsSection {
    return payload.agents;
  }

  build() {
    // Export build for agents is invoked directly by project-export via `buildExportAgents`.
    return [];
  }

  async apply(
    agents: AgentsSection,
    ctx: ImportContext,
    _mode: PipelineMode,
    rt: CodecApplyRuntime,
  ): Promise<CodecApplyResult> {
    const { projectId, storage } = rt;
    const agentProfileMap = ctx.get('selectedProfilesByFamily').agentProfileMap;
    const profileIdMap = ctx.get('profileIdMap');
    const configLookupMap = ctx.get('configLookupMap');

    const agentIdMap: Record<string, string> = {};
    const agentNameToId: Record<string, string> = {};

    for (const agent of agents) {
      const remappedProfileId = agentProfileMap.get(agent.id ?? '');
      const oldProfileId = remappedProfileId ?? agent.profileId ?? '';
      const newProfileId = oldProfileId ? profileIdMap[oldProfileId] : undefined;

      if (!newProfileId) {
        throw new ValidationError(`Profile mapping missing for agent ${agent.name}`, {
          profileId: oldProfileId || null,
        });
      }

      const agentWithConfig = agent as { providerConfigName?: string | null };
      let providerConfigId: string | undefined;

      if (agentWithConfig.providerConfigName) {
        const lookupKey = buildProviderConfigLookupKey(
          newProfileId,
          agentWithConfig.providerConfigName,
        );
        providerConfigId = configLookupMap.get(lookupKey);
      }

      if (!providerConfigId) {
        const profilePrefix = `${newProfileId}:`;
        for (const [lookupKey, configId] of configLookupMap.entries()) {
          if (lookupKey.startsWith(profilePrefix)) {
            providerConfigId = configId;
            break;
          }
        }
      }

      if (!providerConfigId) {
        throw new ValidationError(`No provider config available for agent ${agent.name}`, {
          profileId: newProfileId,
          providerConfigName: agentWithConfig.providerConfigName || null,
        });
      }

      const created = await storage.createAgent({
        projectId,
        name: agent.name,
        profileId: newProfileId,
        description: agent.description ?? null,
        providerConfigId,
        modelOverride: agent.modelOverride ?? null,
        effortOverride: (agent as { effortOverride?: string | null }).effortOverride ?? null,
      });

      const agentKey = agent.id || `name:${agent.name.trim().toLowerCase()}`;
      agentIdMap[agentKey] = created.id;
      agentNameToId[agent.name.trim().toLowerCase()] = created.id;
    }

    ctx.set('agentIdMap', agentIdMap);
    ctx.set('agentNameToId', agentNameToId);

    return { section: 'agents', log: { agents: agents.length } };
  }
}

export const agentsCodec = new AgentsCodec();
