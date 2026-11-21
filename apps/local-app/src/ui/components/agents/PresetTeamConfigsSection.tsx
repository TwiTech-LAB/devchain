import { useState } from 'react';
import { ConfigureTeamConfigsModal } from '@/ui/components/team/ConfigureTeamConfigsModal';
import { Button } from '@/ui/components/ui/button';
import { Checkbox } from '@/ui/components/ui/checkbox';
import type { usePresetTeamConfigs } from './usePresetTeamConfigs';

type TeamConfigsEditor = ReturnType<typeof usePresetTeamConfigs>;

export function PresetTeamConfigsSection({
  editor,
  disabled,
}: {
  editor: TeamConfigsEditor;
  disabled: boolean;
}) {
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const editingRow = editor.rows.find(({ team }) => team.id === editingTeamId);

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Team allowed configs</legend>
      {editor.hasError ? (
        <div className="flex items-center gap-2" role="alert">
          <span className="text-sm text-destructive">Failed to load team configurations.</span>
          <Button type="button" variant="outline" size="sm" onClick={editor.retry}>
            Retry
          </Button>
        </div>
      ) : !editor.isReady ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading team configurations…
        </p>
      ) : editor.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No teams with linked profiles.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {editor.rows.map(({ team, linkedProfiles, included, profileSelections }) => (
            <li key={team.id} className="flex items-center gap-3 p-2">
              <Checkbox
                id={`preset-team-${team.id}`}
                aria-label={`Include ${team.name}`}
                checked={included}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  editor.editTeam(team.id, { included: checked === true })
                }
              />
              <div className="min-w-0 flex-1">
                <label htmlFor={`preset-team-${team.id}`} className="text-sm font-medium">
                  {team.name}
                </label>
                <p className="break-words text-xs text-muted-foreground">
                  {linkedProfiles
                    .map(({ name }) => {
                      const selection = profileSelections.find(
                        ({ profileName }) => profileName === name,
                      );
                      return `${name}: ${selection?.configNames.join(', ') ?? 'All'}`;
                    })
                    .join(' · ')}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Configure ${team.name}`}
                disabled={disabled}
                onClick={() => setEditingTeamId(team.id)}
              >
                Configure
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editor.missing.length > 0 && (
        <ul className="space-y-1 text-xs text-destructive" aria-label="Missing team preset entries">
          {editor.missing.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      )}
      {editingRow && (
        <ConfigureTeamConfigsModal
          open
          onOpenChange={(open) => {
            if (!open) setEditingTeamId(null);
          }}
          profiles={editingRow.linkedProfiles}
          linkedProfileIds={editingRow.team.profileIds}
          selections={editingRow.selections}
          presetConfigs={editor.configsByProfile}
          onSave={({ profileConfigSelections }) =>
            editor.editTeam(editingRow.team.id, { selections: profileConfigSelections })
          }
        />
      )}
    </fieldset>
  );
}
