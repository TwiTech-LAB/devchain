import { readFileSync } from 'fs';
import { join } from 'path';
import { ExportSchema } from '@devchain/shared';
import {
  buildProviderSummary,
  computeFamilyAlternatives,
  derivePresetProviderCoverage,
} from '@/modules/projects/helpers/profile-mapping.helpers';
import type { SetupPreviewResponse } from '@/ui/pages/projects/lib/project-contracts';

/**
 * The setup-preview of the bundled teams-dev template with the given installed providers, computed
 * with the same pure helpers as `ProjectsService.setupPreview`.
 */
export function teamsDevSetupPreview(installed: string[]): SetupPreviewResponse {
  const raw = readFileSync(join(__dirname, '../../templates/teams-dev.json'), 'utf8');
  const payload = ExportSchema.parse(JSON.parse(raw)) as SetupPreviewResponse['payload'];
  const profiles = payload.profiles as Parameters<typeof buildProviderSummary>[0];
  const agents = payload.agents ?? [];
  const available = new Set(installed);
  return {
    payload,
    providerSummary: buildProviderSummary(profiles, agents, available),
    familyAlternatives: computeFamilyAlternatives(profiles, agents, available).alternatives,
    presetProviderCoverage: derivePresetProviderCoverage(
      payload.presets ?? [],
      profiles,
      agents,
      available,
    ).map((c) => ({
      presetName: c.presetName,
      referencedProviders: c.referencedProviders,
      coversAllAgents: c.coversAllAgents,
      coveredAgentNames: [...c.coveredAgentNames].sort(),
      agentResolvedProviders: Object.fromEntries(c.agentResolvedProviders),
    })),
    localAvailability: { installedProviders: installed.map((name) => ({ id: name, name })) },
  };
}
