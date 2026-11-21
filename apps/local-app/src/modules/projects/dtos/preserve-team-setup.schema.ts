import { z } from 'zod';
import type { PreserveTeamSetup } from '../../../common/project-preservation.contract';

const name = z.string().trim().min(1);
const key = (value: string) => value.trim().toLowerCase();

function uniqueList<T extends z.ZodTypeAny>(item: T, identity: (entry: z.output<T>) => string) {
  return z.array(item).refine((entries) => new Set(entries.map(identity)).size === entries.length, {
    message: 'Duplicate selection',
  });
}

export const PreserveTeamSetupSchema: z.ZodType<PreserveTeamSetup> = z
  .object({
    addTeams: uniqueList(name, key).optional(),
    addMembers: uniqueList(
      z.object({ teamName: name, agentName: name }).strict(),
      ({ teamName, agentName }) => JSON.stringify([key(teamName), key(agentName)]),
    ).optional(),
    agentOptions: uniqueList(
      z.object({ agentName: name, configName: name, providerName: name }).strict(),
      ({ agentName }) => key(agentName),
    ).optional(),
    teamPermissions: uniqueList(
      z
        .object({
          teamName: name,
          allowTeamLeadCreateAgents: z.boolean().optional(),
          profiles: uniqueList(
            z.object({ profileName: name, configNames: uniqueList(name, key) }).strict(),
            ({ profileName }) => key(profileName),
          ).optional(),
        })
        .strict(),
      ({ teamName }) => key(teamName),
    ).optional(),
  })
  .strict();

export const PRESERVE_SETUP_EXCLUSIVE_MESSAGE =
  'preserveTeamSetup cannot be combined with presetName, agentOverrides or teamOverrides';

export function mixesPreserveTeamSetup(input: {
  preserveTeamSetup?: unknown;
  presetName?: unknown;
  agentOverrides?: unknown;
  teamOverrides?: unknown;
}): boolean {
  return (
    input.preserveTeamSetup !== undefined &&
    (input.presetName !== undefined ||
      input.agentOverrides !== undefined ||
      input.teamOverrides !== undefined)
  );
}
