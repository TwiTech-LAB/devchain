import { render, screen } from '@testing-library/react';
import { Step3Teams } from './Step3Teams';
import type { ParsedTemplateProfile, ParsedTemplateTeam, TeamPanelState } from './teamPlan';

// Radix ScrollArea needs this in JSDOM.
(global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const TEAM: ParsedTemplateTeam = {
  name: 'Squad',
  teamLeadAgentName: 'Captain',
  memberAgentNames: ['Member'],
  allowTeamLeadCreateAgents: true,
  profileNames: ['Coder'],
};

const PROFILES: ParsedTemplateProfile[] = [
  {
    name: 'Coder',
    providerConfigs: [
      { name: 'claude-cfg', providerName: 'claude' },
      { name: 'gpt-high', providerName: 'codex' },
    ],
  },
];

function makeStates(): Map<string, TeamPanelState> {
  return new Map<string, TeamPanelState>([
    [
      'Squad',
      {
        selections: [{ profileKey: 'Coder', mode: 'allow-all' }],
        templateSelections: [],
      },
    ],
  ]);
}

function renderStep(selectedProviderNames: string[]) {
  return render(
    <Step3Teams
      visibleTeams={[TEAM]}
      profiles={PROFILES}
      selectedProviderNames={selectedProviderNames}
      teamStates={makeStates()}
      onTeamStateChange={jest.fn()}
    />,
  );
}

describe('Step3Teams', () => {
  it('offers every profile config when all its providers are selected', () => {
    renderStep(['claude', 'codex']);

    expect(screen.getByRole('checkbox', { name: 'Config claude-cfg' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Config gpt-high' })).toBeInTheDocument();
  });

  it('offers only configs from the Step-1 selected providers', () => {
    renderStep(['claude']);

    expect(screen.getByRole('checkbox', { name: 'Config claude-cfg' })).toBeInTheDocument();
    // gpt-high belongs to codex, which was not selected on Step 1 — its config (and the
    // codex provider group) must not be offered to the team.
    expect(screen.queryByRole('checkbox', { name: 'Config gpt-high' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Provider codex' })).not.toBeInTheDocument();
  });
});
