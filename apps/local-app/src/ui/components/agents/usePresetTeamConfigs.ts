import { useEffect, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { firstPresetTeamEntries, presetNameKey } from '@devchain/shared';
import { toConfigItem, type ConfigItem } from '@/ui/components/team/selector-types';
import type { FetchFn } from '@/ui/lib/api-transport';
import type { Preset } from '@/ui/lib/preset-types';
import { profileQueries } from '@/ui/lib/profiles';
import { providerConfigQueries } from '@/ui/lib/provider-configs';
import { fetchAllTeams, fetchTeamDetail, teamsQueryKeys, type TeamDetail } from '@/ui/lib/teams';

type PresetTeamConfig = NonNullable<Preset['teamConfigs']>[number];
type Profile = { id: string; name: string };
type ConfigsByProfile = Record<string, ConfigItem<string>[]>;
type ConfigSelections = TeamDetail['profileConfigSelections'];
type TeamEdit = { included?: boolean; selections?: ConfigSelections };

function configNamesForProfile(
  profileId: string,
  selections: ConfigSelections,
  configsByProfile: ConfigsByProfile,
): string[] {
  const configIds = selections.find((selection) => selection.profileId === profileId)?.configIds;
  const configs = configsByProfile[profileId] ?? [];
  return (configIds ?? []).flatMap((id) => {
    const config = configs.find((option) => option.key === id);
    return config ? [config.label] : [];
  });
}

function resolveStoredSelections(
  entry: PresetTeamConfig,
  profiles: Profile[],
  configsByProfile: ConfigsByProfile,
  missing: Set<string>,
): ConfigSelections {
  const configIdsByProfile = new Map<string, Set<string>>();
  for (const { profileName, configNames } of entry.profileSelections) {
    const profile = profiles.find(({ name }) => presetNameKey(name) === presetNameKey(profileName));
    if (!profile) {
      missing.add(`Missing profile: ${profileName} (${entry.teamName})`);
      continue;
    }

    const configIds = configIdsByProfile.get(profile.id) ?? new Set<string>();
    for (const name of configNames) {
      const config = configsByProfile[profile.id]?.find(
        ({ label }) => presetNameKey(label) === presetNameKey(name),
      );
      if (config) {
        configIds.add(config.key);
      } else {
        missing.add(`Missing config: ${name} (${entry.teamName} / ${profileName})`);
      }
    }
    if (configIds.size > 0) {
      configIdsByProfile.set(profile.id, configIds);
    }
  }
  return Array.from(configIdsByProfile, ([profileId, configIds]) => ({
    profileId,
    configIds: [...configIds],
  }));
}

export function usePresetTeamConfigs(
  fetchFn: FetchFn,
  projectId: string,
  open: boolean,
  presetToEdit: Preset | null | undefined,
) {
  const [edits, setEdits] = useState<Record<string, TeamEdit>>({});
  useEffect(() => {
    setEdits({});
  }, [open, projectId, presetToEdit]);

  const teamsQuery = useQuery({
    queryKey: teamsQueryKeys.allTeams(projectId),
    queryFn: () => fetchAllTeams(projectId, fetchFn),
    enabled: open,
  });
  const details = useQueries({
    queries: (teamsQuery.data ?? []).map(({ id }) => ({
      queryKey: teamsQueryKeys.detail(id),
      queryFn: () => fetchTeamDetail(id, fetchFn),
      enabled: open,
    })),
  });
  const teams = details.flatMap(({ data }) => (data ? [data] : []));
  const profileIds = [...new Set(teams.flatMap(({ profileIds }) => profileIds))];
  const profilesQuery = useQuery({
    ...profileQueries.list(fetchFn, projectId),
    enabled: open && profileIds.length > 0,
  });
  const profilesById = new Map(profilesQuery.data?.items?.map((profile) => [profile.id, profile]));
  const missingProfileIds = profilesQuery.isSuccess
    ? profileIds.filter((id) => !profilesById.has(id))
    : [];
  // The project profile list has a server-side limit, but a team can link profiles past that page.
  const profileDetails = useQueries({
    queries: missingProfileIds.map((id) => ({
      ...profileQueries.detail(fetchFn, id),
      enabled: open,
    })),
  });
  const profiles = new Map<string, Profile>(profilesById);
  for (const { data } of profileDetails) {
    if (data) profiles.set(data.id, data);
  }
  const configQueries = useQueries({
    queries: profileIds.map((id) => ({
      ...providerConfigQueries.profile(fetchFn, id),
      enabled: open,
    })),
  });
  const configsByProfile: ConfigsByProfile = Object.fromEntries(
    profileIds.map((id, index) => [id, (configQueries[index].data ?? []).map(toConfigItem)]),
  );

  const queries = [
    teamsQuery,
    ...details,
    ...(profileIds.length > 0 ? [profilesQuery] : []),
    ...profileDetails,
    ...configQueries,
  ];
  const isReady = open && queries.every(({ isSuccess }) => isSuccess);
  const hasError = queries.some(({ isError }) => isError);

  const storedEntries = firstPresetTeamEntries(presetToEdit?.teamConfigs ?? []);

  const missing = new Set<string>();
  const rows = isReady
    ? teams.flatMap((team) => {
        const name = presetNameKey(team.name);
        const stored = storedEntries.get(name);
        storedEntries.delete(name);
        const linkedProfiles = team.profileIds.flatMap((id) => {
          const profile = profiles.get(id);
          return profile ? [profile] : [];
        });
        const edit = edits[team.id];
        let selections = edit?.selections;
        if (!selections) {
          if (stored) {
            selections = resolveStoredSelections(stored, linkedProfiles, configsByProfile, missing);
          } else {
            // A new preset starts from the team's current rows. An edited preset without an
            // entry for this team starts empty.
            selections = presetToEdit ? [] : team.profileConfigSelections;
          }
        }
        if (linkedProfiles.length === 0) return [];

        const included = edit?.included ?? (!presetToEdit || !!stored);
        const untouchedStored = edit?.selections === undefined ? stored?.profileSelections : [];
        const profileSelections = linkedProfiles.flatMap(({ id, name }) => {
          const configNames = configNamesForProfile(id, selections, configsByProfile);
          if (configNames.length > 0) return [{ profileName: name, configNames }];

          // No stored config name resolves. Keep the stored restriction, as apply does: a
          // profile changes to "All" only when the user confirms that in this dialog.
          const staleNames = (untouchedStored ?? [])
            .filter(({ profileName }) => presetNameKey(profileName) === presetNameKey(name))
            .flatMap((selection) => selection.configNames);
          return staleNames.length > 0 ? [{ profileName: name, configNames: staleNames }] : [];
        });
        return [{ team, linkedProfiles, selections, included, profileSelections }];
      })
    : [];
  const teamConfigs: PresetTeamConfig[] = rows
    .filter(({ included }) => included)
    .map(({ team, profileSelections }) => ({ teamName: team.name, profileSelections }));
  if (isReady) {
    for (const { teamName } of storedEntries.values()) {
      missing.add(`Missing team: ${teamName}`);
    }
  }

  return {
    rows,
    configsByProfile,
    isReady,
    hasError,
    missing: [...missing],
    teamConfigs,
    retry: () => {
      for (const query of queries) void query.refetch();
    },
    editTeam: (id: string, edit: TeamEdit) =>
      setEdits((previous) => ({ ...previous, [id]: { ...previous[id], ...edit } })),
  };
}
